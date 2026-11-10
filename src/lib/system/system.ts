// Server system vitals, client half — board #56 「服务端系统状态显示」.
// Pure types + formatting only: the component renders what these functions
// say, and the tests exercise the words without a DOM.

/** Wire shape of the `system_status` RPC (system_status.rs is the authority).
 * Bytes everywhere; `cpu_pct` is null on the server's first-ever sample
 * (no delta window yet — the next poll fills it in). */
export interface SystemStatus {
  cpu_pct: number | null;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  /** The server's NVIDIA GPUs (board #102), absent/null when it has none or
   * cannot read them: VRAM summed, utilization the HIGHEST card's. */
  gpu?: GpuSummary | null;
  /** One entry per GPU, for the hover card; may be absent. */
  gpus?: GpuReading[] | null;
}

export interface GpuReading {
  name: string;
  /** 0..=100, null when the card did not report it. */
  util_pct: number | null;
  mem_used: number;
  mem_total: number;
}

export interface GpuSummary extends GpuReading {
  count: number;
}

/** How often the corner refreshes. The owner asked for a LOW rate ("可以不用
 * 很高刷新率 大概看个数就行") — 20s keeps the number honest while costing one
 * tiny RPC per interval. */
export const SYS_POLL_MS = 20000;

/** The floor no caller may go under: the server computes CPU% over the poll
 * interval itself, so a sub-second poll would both hammer the wire and make
 * the reading noise. */
export const SYS_POLL_MIN_MS = 5000;

const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'] as const;

/** One byte count, humanised: unit steps of 1024, one decimal under 10 so
 * "3.1G" stays informative while "473G" stays short. Negative or unreadable
 * inputs render as '0'. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const num = v < 10 && u > 0 ? v.toFixed(1).replace(/\.0$/u, '') : String(Math.round(v));
  return `${num}${UNITS[u]}`;
}

/** used/total wearing ONE unit — the TOTAL's unit — so the pair reads as a
 * fraction ("210/473G"), never as two differently-scaled numbers. */
export function fmtPair(used: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  let v = total;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const scale = 1024 ** u;
  const one = (x: number) => {
    const s = x / scale;
    return s < 10 && u > 0 ? s.toFixed(1).replace(/\.0$/u, '') : String(Math.round(s));
  };
  return `${one(Math.max(0, used))}/${one(total)}${UNITS[u]}`;
}

/** What the corner SAYS. Null/absent readings yield [] (the verdict rule:
 * render nothing rather than a row of zeros); each unknowable field simply
 * drops its part — a first sample shows MEM/DISK and picks CPU up next tick. */
export function sysParts(s: SystemStatus | null | undefined, { touch = false }: { touch?: boolean } = {}): { k: string; v: string }[] {
  if (!s) return [];
  const parts: { k: string; v: string }[] = [];
  if (s.cpu_pct !== null && s.cpu_pct !== undefined && Number.isFinite(s.cpu_pct)) {
    parts.push({ k: 'CPU', v: `${Math.round(Math.min(100, Math.max(0, s.cpu_pct)))}%` });
  }
  if (s.mem_total > 0) parts.push({ k: 'MEM', v: fmtPair(s.mem_used, s.mem_total) });
  // The GPU (board #102, leader's ruling note 5): the strip is 24 px and, on
  // the desktop, 201 px wide, and four metrics do not fit (measured). With a
  // GPU the strip reads CPU, MEM, GPU, where GPU is the VRAM (显存) used, in
  // percent; DISK and the GPU's utilization move to the hover card, which spells
  // every one of them. Without a GPU: today's three. Touch has no hover card
  // (reviewer note 42, round 4), so there DISK stays and the GPU follows it;
  // the drawer holds all four (measured at 390 and 320 px).
  const g = s.gpu;
  const gpu = !!g && g.mem_total > 0;
  if ((touch || !gpu) && s.disk_total > 0) parts.push({ k: 'DISK', v: fmtPair(s.disk_used, s.disk_total) });
  // The VRAM as a percentage (round 5, leader note 56): '16/22G' clipped
  // the 320 px drawer beside a 100% CPU and a three-digit MEM; a percent
  // fits every width. The card keeps the fraction.
  if (g && gpu) parts.push({ k: 'GPU', v: `${Math.round(clampPct((Math.max(0, g.mem_used) / g.mem_total) * 100))}%` });
  return parts;
}

const isPct = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
/** How many 24 px rows the strip takes (board #102 round 6, leader note
 * 77). Two only on touch, with a server name and a shown GPU: the name
 * plus four readings do not fit the 284 px drawer row (Aggregate: -38 px at
 * 320, -13 at 390, measured), and touch has no hover card to move one to.
 * The desktop is always one row (#326); so is every other case. */
export function sysRows(s: SystemStatus | null | undefined, { touch, tag }: { touch: boolean; tag: string | null | undefined }): 1 | 2 {
  return touch && !!tag && !!s?.gpu && s.gpu.mem_total > 0 ? 2 : 1;
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

/** One row per byte quantity with two decimals in the total's unit — "12.33/64.00G". */
export function fmtPairFull(used: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '';
  let v = total;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const scale = 1024 ** u;
  const one = (x: number) => (u > 0 ? (x / scale).toFixed(2) : String(Math.round(x / scale)));
  return `${one(Math.max(0, used))}/${one(total)}${UNITS[u]}`;
}

/** The FULL reading for the hover card (motion.md §1.16): what the compact
 * corner abbreviates, spelled out — CPU to one decimal, memory and disk as a
 * two-decimal fraction plus the percentage. Same keys as `sysParts`, same
 * drop-the-unknowable rule, so the two never disagree about what exists. */
export function sysDetail(s: SystemStatus | null | undefined): { k: string; v: string }[] {
  if (!s) return [];
  const rows: { k: string; v: string }[] = [];
  if (s.cpu_pct !== null && s.cpu_pct !== undefined && Number.isFinite(s.cpu_pct)) {
    rows.push({ k: 'CPU', v: `${Math.min(100, Math.max(0, s.cpu_pct)).toFixed(1)}%` });
  }
  const pct = (used: number, total: number) => `${Math.round((Math.max(0, used) / total) * 100)}%`;
  if (s.mem_total > 0) rows.push({ k: 'MEM', v: `${fmtPairFull(s.mem_used, s.mem_total)} · ${pct(s.mem_used, s.mem_total)}` });
  if (s.disk_total > 0) rows.push({ k: 'DISK', v: `${fmtPairFull(s.disk_used, s.disk_total)} · ${pct(s.disk_used, s.disk_total)}` });
  // One line per GPU (board #102): name, utilization to one decimal, VRAM.
  // With several cards each line is named by its POSITION in the reading
  // ('GPU 0', 'GPU 1'), which matches nvidia-smi's index only when no earlier
  // card failed to read (leader note 25): the card's rows are keyed by label, and two
  // cards may share a name (round 2, validator note 19: each_key_duplicate).
  if (s.gpu && s.gpu.mem_total > 0) {
    const cards = s.gpus?.length ? s.gpus : [s.gpu];
    for (const [i, g] of cards.entries()) {
      if (!(g.mem_total > 0)) continue;
      // Numbers first, the name last (round 3, validator note 31, leader note
      // 33): the card's one-line ellipsis can then eat only a long name's tail.
      const util = isPct(g.util_pct) ? `${clampPct(g.util_pct).toFixed(1)}% · ` : '';
      rows.push({ k: cards.length > 1 ? `GPU ${i}` : 'GPU', v: `${util}${fmtPairFull(g.mem_used, g.mem_total)} (${pct(g.mem_used, g.mem_total)}) · ${g.name}` });
    }
  }
  return rows;
}
