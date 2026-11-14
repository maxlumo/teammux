# System Status (server vitals) — requirements

Board #56. Owner (2026-09-01): 「可以在系统端左下角 显示系统 cpu mem disk容量
状态 可以不用很高刷新率 大概看个数就行」.

## What

The connected client shows three numbers about the MACHINE THE SERVER RUNS ON
(not the phone or browser process). They are always present in the desktop
primary sidebar and appear at the bottom of an open primary side drawer on a
phone:

- **CPU** — whole-machine usage percent.
- **MEM** — used/total, one shared unit (e.g. `3.4/16G`).
- **DISK** — used/total of the root filesystem, one shared unit.

**GPU** (board #102, owner 2026-11-10: "系统资源状态那里如果是我们这种gpu机器要显示
状态 显存利用率"): on a server with an NVIDIA GPU the strip reads CPU, MEM,
**GPU**, where GPU is the VRAM used as a percentage of the total
(`GPU 72%`; several GPUs: summed VRAM). On the desktop, DISK and the GPU's utilization move to the hover
card, which spells every reading: CPU, MEM, DISK, and one line per GPU,
numbers first and the name last (`100.0% · 16.13/22.49G (72%) · NVIDIA L4`:
utilization to one decimal, VRAM as a two-decimal fraction and its
percentage, the name as room allows), so a long model name can lose only its own tail to the card's
one-line ellipsis; with several cards each line is labelled by its position in
the reading (`GPU 0`, `GPU 1`), so cards of the same model stay distinct.
The position is `nvidia-smi`'s index only when no earlier card failed to read
(a card that fails is left out). Touch has no hover card, so the phone
drawer keeps DISK and shows all four: CPU, MEM, DISK, GPU (VRAM percent);
the GPU's utilization has no touch surface (round 4, reviewer note 42,
leader's ruling). In Aggregate, where the server's name sits beside the
reading, a SHOWN name takes its own row on every layout: the strip is two
rows (the name, then the readings) and the sidebar or drawer reserves both
(#102 round 6 for touch + GPU; #103 for every layout, by the owner's
delegation 2026-11-14). Single, a tagless Aggregate and a reading that
renders nothing stay one 24 px row (#103: the row count is derived from
the same rendered parts as the strip). Known limit: on a 320 px phone, CPU 100%, a three-digit
MEM and GPU 100% together are 1.5 px too wide and every value shows an
ellipsis (design doc, § GPUs). The one-row strip is 24 px high (#326) and its readout gets 201 px
on the desktop beside the scratch button; four metrics need 242 px or more
in any form (measured), so one had to leave, and DISK changes slowest
(leader's ruling, #102 note 5; the owner was asked). Without a GPU, or when
the reading fails, the strip is exactly the three above.

## Behaviour

- **Sidebar-only on both layouts.** On a connected desktop the reading
  occupies reserved space at the bottom of the primary sidebar
  (`--sidebar-w`) after the icon rail. On touch it stays hidden until the
  current page's shared side drawer opens, then occupies that drawer's bottom
  row above the safe area. It never draws or reserves a row under the main
  terminal/content area.
- **Compact, quiet monitor treatment.** The strip is one 24px row, two
  (48px) only when a shown server name takes its own row (#103). CPU,
  MEM, and DISK keep their natural widths and flow left — never three equal
  columns. They form one unboxed readout with only restrained 4px
  accent/purple/green (and, with a GPU, orange) dots, muted labels, and clear mono values. There are no
  per-metric coloured cards, borders, or fills competing with project work.
- **Low refresh.** One reading every ~20 seconds. This is a glanceable
  number, not a monitor; the tempo is also the CPU measurement window (see
  design doc).
- **Fail-soft, both directions.** A failed poll keeps the last reading; a
  server that cannot answer (mobile server, older server without the RPC)
  means the corner simply never appears. The corner must never affect the
  connection, the terminal, or any other feature.
- **First sample has no CPU.** CPU% needs a delta window, so the first-ever
  reading shows MEM/DISK only and CPU appears on the next tick — never a
  fabricated 0%.
- **Nothing renders before the first successful reading** (the app-wide
  verdict rule: no flash of zeros).

## API

`system_status` (no params) →

```json
{ "cpu_pct": 12.5, "mem_used": 0, "mem_total": 0, "disk_used": 0, "disk_total": 0,
  "gpu": { "name": "NVIDIA L4", "count": 1, "util_pct": 100.0, "mem_used": 0, "mem_total": 0 },
  "gpus": [{ "name": "NVIDIA L4", "util_pct": 100.0, "mem_used": 0, "mem_total": 0 }] }
```

Bytes everywhere; `cpu_pct` is `null` on the server's first sample. `gpu`
and `gpus` (#102) are `null` on a machine without an NVIDIA GPU or driver;
`gpu` sums VRAM over the cards and takes the highest utilization, `gpus`
has one entry per card, and a card's `util_pct` is `null` when it does not
report one. Older clients ignore both. The
method is desktop-only (Android/iOS report method-not-found, same contract as
`project_*`).
