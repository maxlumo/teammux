//! Server system vitals — board #56 「服务端系统状态显示」.
//!
//! The owner wants three numbers in the desktop client's bottom-left corner:
//! CPU, memory, and disk, at a LOW refresh rate ("可以不用很高刷新率 大概看个
//! 数就行"). This module is the whole collection half: one `read()` per
//! `system_status` RPC call, no background thread, no timer — the CLIENT's
//! poll interval is the clock, which is what makes low frequency free.
//!
//! CPU% needs a delta window (two samples of busy/total time). Instead of
//! sleeping inside the request (a 200ms stall per poll) the previous sample
//! is KEPT between calls in a process-wide `System`, so each reading reports
//! usage since the LAST poll — exactly the interval the client chose. The
//! price is honest: the FIRST call has no window and reports `cpu_pct: null`
//! rather than a made-up 0% (fail-soft: the client renders the other numbers
//! and fills CPU in on its next tick).
//!
//! Disk is the ROOT filesystem — `pick_root_disk` prefers the exact `/`
//! mount and otherwise falls back to the largest mounted disk (macOS lists
//! the APFS data volume separately; largest-total is the container the owner
//! means by "disk容量"). Everything degrades soft: an empty disk list yields
//! 0/0, which the client treats as "nothing to say" — a failed reading must
//! never break the connection that carries the terminal.
//!
//! No shell-outs anywhere (the review brief bans slow commands and injection
//! surfaces): `sysinfo` reads /proc on Linux and the host statistics API on
//! macOS, in-process.
//!
//! GPUs (board #102, owner 2026-11-10: "系统资源状态那里如果是我们这种gpu机器要
//! 显示状态 显存利用率"): NVIDIA cards through NVML (`nvml-wrapper`), loaded ONCE
//! and lazily; a machine with no driver, no library or no device remembers that
//! and reports `gpu: null` on every poll without retrying or logging.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use sysinfo::{Disks, System};

/// One reading. Bytes everywhere; percentages are 0..=100.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SystemStatus {
    /// Whole-machine CPU usage since the previous poll; `None` on the first
    /// call of a server's life (no delta window exists yet).
    pub cpu_pct: Option<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    /// The machine's NVIDIA GPUs summed (#102): `None` without one.
    pub gpu: Option<GpuSummary>,
    /// One reading per GPU, for the hover card; `None` with `gpu`.
    pub gpus: Option<Vec<GpuReading>>,
}

/// One GPU's reading. Bytes; `util_pct` 0..=100 or `None` when the card does
/// not report it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GpuReading {
    pub name: String,
    pub util_pct: Option<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
}

/// Every GPU as one: VRAM summed, utilization the HIGHEST card's (leader's
/// decision on #102), the first card's name.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GpuSummary {
    pub name: String,
    pub count: u32,
    pub util_pct: Option<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
}

/// Fold the cards into the strip's one value. `None` for no card or no VRAM
/// total. Pure, so the several-GPU rule is tested without a GPU.
pub fn summarize_gpus(cards: &[GpuReading]) -> Option<GpuSummary> {
    let first = cards.first()?;
    let mem_total: u64 = cards.iter().map(|c| c.mem_total).sum();
    if mem_total == 0 {
        return None;
    }
    let util_pct = cards.iter().filter_map(|c| c.util_pct).fold(None, |m: Option<f32>, u| Some(m.map_or(u, |m| m.max(u))));
    Some(GpuSummary {
        name: first.name.clone(),
        count: cards.len() as u32,
        util_pct,
        mem_used: cards.iter().map(|c| c.mem_used).sum(),
        mem_total,
    })
}

/// The NVML handle, opened at most once per process: `None` remembers that
/// there is nothing to open (no driver, no library, no device), so a machine
/// without a GPU pays one failed dlopen in its whole life.
static NVML: OnceLock<Option<nvml_wrapper::Nvml>> = OnceLock::new();

/// A card's VRAM as (used, total), the pair `nvidia-smi` reports: NVML
/// memory v2's own `used`, which leaves out the driver's `reserved` (fix
/// round 1, validator note 12, measured on this host's L4: `nvidia-smi`
/// 17458 MiB used; NVML v2 used 18306039808 B = 17458 MiB, reserved
/// 491651072 B; `total - free` read 0.46 GiB high).
fn vram_of(mem: &nvml_wrapper::struct_wrappers::device::MemoryInfo) -> (u64, u64) {
    (mem.used.min(mem.total), mem.total)
}

/// Read every GPU NVML can see; empty when there is none or a card fails.
fn read_gpus() -> Vec<GpuReading> {
    let Some(nvml) = NVML.get_or_init(|| nvml_wrapper::Nvml::init().ok()) else { return Vec::new() };
    let count = nvml.device_count().unwrap_or(0);
    (0..count)
        .filter_map(|i| {
            let d = nvml.device_by_index(i).ok()?;
            let mem = d.memory_info().ok()?;
            let (mem_used, mem_total) = vram_of(&mem);
            Some(GpuReading {
                name: d.name().unwrap_or_else(|_| "GPU".into()),
                util_pct: d.utilization_rates().ok().map(|u| (u.gpu as f32).clamp(0.0, 100.0)),
                mem_used,
                mem_total,
            })
        })
        .collect()
}

/// The process-wide sampler. `bool` = "a previous CPU sample exists", i.e.
/// whether the usage sysinfo reports has a real window under it.
static SYS: OnceLock<Mutex<(System, bool)>> = OnceLock::new();

/// Take one reading. Cheap enough for every poll: a /proc read (Linux) or a
/// couple of host calls (macOS) plus a disk-list refresh.
pub fn read() -> SystemStatus {
    let lock = SYS.get_or_init(|| Mutex::new((System::new(), false)));
    let (cpu_pct, mem_used, mem_total) = match lock.lock() {
        Ok(mut guard) => {
            let (sys, primed) = &mut *guard;
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let pct = if *primed {
                Some(sys.global_cpu_usage().clamp(0.0, 100.0))
            } else {
                *primed = true;
                None
            };
            (pct, sys.used_memory(), sys.total_memory())
        }
        // A poisoned lock means a past panic mid-read; report "no reading"
        // rather than poisoning every future poll too.
        Err(_) => (None, 0, 0),
    };

    let disks = Disks::new_with_refreshed_list();
    let listed: Vec<(String, u64, u64)> = disks
        .iter()
        .map(|d| {
            (
                d.mount_point().to_string_lossy().into_owned(),
                d.total_space(),
                d.available_space(),
            )
        })
        .collect();
    let (disk_total, disk_avail) = pick_root_disk(&listed).unwrap_or((0, 0));
    let cards = read_gpus();
    let gpu = summarize_gpus(&cards);

    SystemStatus {
        cpu_pct,
        mem_used,
        mem_total,
        disk_used: disk_total.saturating_sub(disk_avail),
        disk_total,
        gpus: gpu.as_ref().map(|_| cards),
        gpu,
    }
}

/// Which mounted disk is "the disk" (total, available)? Exact `/` when it is
/// listed (Linux, and macOS's synthetic root), else the largest total —
/// macOS splits the APFS container across read-only `/` and the data volume,
/// and the largest one is the capacity a person means. Pure so the choice is
/// testable without a platform.
pub fn pick_root_disk(disks: &[(String, u64, u64)]) -> Option<(u64, u64)> {
    if let Some(root) = disks.iter().find(|(m, ..)| m == "/") {
        if root.1 > 0 {
            return Some((root.1, root.2));
        }
    }
    disks
        .iter()
        .max_by_key(|(_, total, _)| *total)
        .filter(|(_, total, _)| *total > 0)
        .map(|(_, total, avail)| (*total, *avail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_read_has_no_cpu_window_later_reads_do() {
        // Same process-wide sampler as production: the FIRST call must say
        // "no reading yet" instead of a fabricated 0%, and a later call must
        // report a real bounded percentage. (Order within this test does not
        // depend on other tests: whichever call is globally first returns
        // None, every call after it returns Some.)
        let a = read();
        let b = read();
        assert!(b.cpu_pct.is_some(), "second read has a delta window");
        let pct = b.cpu_pct.unwrap();
        assert!((0.0..=100.0).contains(&pct), "cpu% bounded, got {pct}");
        // Memory always reads on a live machine.
        assert!(a.mem_total > 0 && a.mem_used <= a.mem_total);
    }

    /// Board #102: several GPUs are one strip value, VRAM summed and the
    /// highest utilization; none (or no VRAM total) is no value at all.
    #[test]
    fn several_gpus_sum_vram_and_take_the_highest_utilization() {
        let card = |u: Option<f32>, used: u64, total: u64| GpuReading { name: "NVIDIA L4".into(), util_pct: u, mem_used: used, mem_total: total };
        assert_eq!(summarize_gpus(&[]), None);
        assert_eq!(summarize_gpus(&[card(Some(50.0), 0, 0)]), None, "no VRAM total: nothing to say");
        let one = summarize_gpus(&[card(Some(100.0), 16_522 << 20, 23_034 << 20)]).unwrap();
        assert_eq!((one.count, one.util_pct, one.mem_used, one.mem_total), (1, Some(100.0), 16_522 << 20, 23_034 << 20));
        let two = summarize_gpus(&[card(Some(40.0), 4, 22), card(Some(90.0), 10, 22)]).unwrap();
        assert_eq!((two.count, two.util_pct, two.mem_used, two.mem_total, two.name.as_str()), (2, Some(90.0), 14, 44, "NVIDIA L4"));
        let unknown = summarize_gpus(&[card(None, 1, 2), card(None, 1, 2)]).unwrap();
        assert_eq!(unknown.util_pct, None, "no card reported utilization");
        assert_eq!(summarize_gpus(&[card(None, 1, 2), card(Some(7.0), 1, 2)]).unwrap().util_pct, Some(7.0));
    }

    /// Fix round 1 (validator note 12, leader note 14): VRAM used is NVML
    /// v2's `used`, never `total - free`, which also counts the driver's
    /// reservation. The values are the ones measured on this host's L4.
    #[test]
    fn vram_used_is_nvml_v2_used_not_total_minus_free() {
        let mem = nvml_wrapper::struct_wrappers::device::MemoryInfo { free: 5_355_208_704, reserved: 491_651_072, total: 24_152_899_584, used: 18_306_039_808, version: 2 };
        assert_eq!(mem.used + mem.reserved + mem.free, mem.total, "the measured reading is consistent");
        assert_eq!(vram_of(&mem), (18_306_039_808, 24_152_899_584));
        assert_eq!(18_306_039_808_u64 >> 20, 17_458, "= nvidia-smi's 17458 MiB");
        let card = GpuReading { name: "NVIDIA L4".into(), util_pct: Some(100.0), mem_used: vram_of(&mem).0, mem_total: vram_of(&mem).1 };
        let s = summarize_gpus(&[card.clone(), card]).unwrap();
        assert_eq!((s.mem_used, s.mem_total), (2 * 18_306_039_808, 2 * 24_152_899_584), "summed from the same pair");
    }

    /// Board #102: on a machine without NVML (this rig: no driver in Docker)
    /// the reading is today's four fields plus `gpu: null`, every time, and
    /// the wire carries `gpu` and `gpus` as null.
    #[test]
    fn without_a_gpu_the_reading_is_today_s_plus_a_null_gpu() {
        let a = read();
        let b = read();
        if NVML.get().is_some_and(|n| n.is_some()) {
            return; // a host with a GPU: the null path is not what this machine shows
        }
        assert_eq!((a.gpu.clone(), a.gpus.clone(), b.gpu.clone()), (None, None, None));
        let v = serde_json::to_value(&b).unwrap();
        assert!(v.get("gpu").is_some_and(|g| g.is_null()) && v.get("gpus").is_some_and(|g| g.is_null()), "{v}");
        for k in ["cpu_pct", "mem_used", "mem_total", "disk_used", "disk_total"] { assert!(v.get(k).is_some(), "{k}"); }
    }

    #[test]
    fn root_disk_prefers_slash_over_larger_siblings() {
        let disks = vec![
            ("/data".to_string(), 900, 400),
            ("/".to_string(), 500, 200),
        ];
        assert_eq!(pick_root_disk(&disks), Some((500, 200)));
    }

    #[test]
    fn no_slash_falls_back_to_largest_and_empty_is_none() {
        let disks = vec![
            ("/System/Volumes/Data".to_string(), 994_000, 400_000),
            ("/System/Volumes/VM".to_string(), 1_000, 900),
        ];
        assert_eq!(pick_root_disk(&disks), Some((994_000, 400_000)));
        assert_eq!(pick_root_disk(&[]), None);
        // A zero-sized "/" (a broken statvfs) must not win either.
        assert_eq!(pick_root_disk(&[("/".to_string(), 0, 0)]), None);
    }

    #[test]
    fn wire_shape_is_the_documented_contract() {
        // The client's formatter is written against these exact keys.
        let s = SystemStatus {
            cpu_pct: Some(12.5),
            mem_used: 3,
            mem_total: 16,
            disk_used: 210,
            disk_total: 500,
            gpu: None,
            gpus: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        for k in ["cpu_pct", "mem_used", "mem_total", "disk_used", "disk_total", "gpu", "gpus"] {
            assert!(v.get(k).is_some(), "missing key {k}");
        }
        let first = SystemStatus { cpu_pct: None, ..s.clone() };
        assert!(serde_json::to_value(&first).unwrap()["cpu_pct"].is_null());
        // Board #102: the GPU fields, flat, as system.ts reads them.
        let card = GpuReading { name: "NVIDIA L4".into(), util_pct: Some(100.0), mem_used: 7, mem_total: 9 };
        let with = SystemStatus { gpu: summarize_gpus(std::slice::from_ref(&card)), gpus: Some(vec![card]), ..s };
        let v = serde_json::to_value(&with).unwrap();
        assert_eq!(v["gpu"], serde_json::json!({ "name": "NVIDIA L4", "count": 1, "util_pct": 100.0, "mem_used": 7, "mem_total": 9 }));
        assert_eq!(v["gpus"], serde_json::json!([{ "name": "NVIDIA L4", "util_pct": 100.0, "mem_used": 7, "mem_total": 9 }]));
    }
}
