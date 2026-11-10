import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, fmtPair, fmtPairFull, sysDetail, sysParts, sysRows, SYS_POLL_MS, SYS_POLL_MIN_MS } from './system.ts';

const G = 1024 ** 3;

test('fmtBytes: 1024 steps, one decimal under 10, degenerate → 0', () => {
  assert.equal(fmtBytes(0), '0');
  assert.equal(fmtBytes(-5), '0');
  assert.equal(fmtBytes(NaN), '0');
  assert.equal(fmtBytes(512), '512B');
  assert.equal(fmtBytes(3.1 * G), '3.1G');
  assert.equal(fmtBytes(16 * G), '16G');
  assert.equal(fmtBytes(1.2 * 1024 ** 4), '1.2T');
  // the trailing .0 is dropped, not shown
  assert.equal(fmtBytes(2 * G), '2G');
});

test('fmtPair: both numbers wear the TOTAL\'s unit, reading as a fraction', () => {
  assert.equal(fmtPair(210 * G, 473 * G), '210/473G');
  // used far below the total's unit stays IN that unit (a fraction, not two scales)
  assert.equal(fmtPair(0.5 * G, 2 * 1024 ** 4), '0/2T');
  // one decimal only under 10 — 15.3 rounds whole, 3.4 keeps its decimal
  assert.equal(fmtPair(3.4 * G, 15.3 * G), '3.4/15G');
  // degenerate totals say nothing
  assert.equal(fmtPair(5, 0), '');
  assert.equal(fmtPair(5, NaN), '');
  // negative used clamps to 0 instead of rendering a minus sign
  assert.equal(fmtPair(-1, 4 * G), '0/4G');
});

test('sysParts: null status and zero totals render NOTHING (verdict rule)', () => {
  assert.deepEqual(sysParts(null), []);
  assert.deepEqual(sysParts(undefined), []);
  assert.deepEqual(
    sysParts({ cpu_pct: null, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 }),
    [],
  );
});

test('sysParts: a first sample (cpu null) shows MEM/DISK and no CPU part', () => {
  const parts = sysParts({ cpu_pct: null, mem_used: 3 * G, mem_total: 16 * G, disk_used: 100 * G, disk_total: 500 * G });
  assert.deepEqual(parts.map((p) => p.k), ['MEM', 'DISK']);
});

test('sysParts: a full reading is CPU → MEM → DISK, cpu rounded and clamped', () => {
  const parts = sysParts({ cpu_pct: 12.6, mem_used: 3 * G, mem_total: 16 * G, disk_used: 210 * G, disk_total: 473 * G });
  assert.deepEqual(parts, [
    { k: 'CPU', v: '13%' },
    { k: 'MEM', v: '3/16G' },
    { k: 'DISK', v: '210/473G' },
  ]);
  assert.equal(sysParts({ cpu_pct: 250, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })[0]?.v, '100%');
  assert.equal(sysParts({ cpu_pct: -3, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })[0]?.v, '0%');
});

test('the poll tempo is LOW and floored', () => {
  // The owner asked for a low refresh; the server computes CPU% over this
  // very interval, so a fast poll would be both cost and noise.
  assert.ok(SYS_POLL_MS >= 10000, `default ${SYS_POLL_MS} is a low-frequency tempo`);
  assert.ok(SYS_POLL_MIN_MS >= 2000, 'a floor exists so no caller wires a hot loop');
});

test('sysDetail: the hover card’s full reading — one decimal CPU, two-decimal fractions with a percentage', () => {
  assert.deepEqual(sysDetail({ cpu_pct: 23.46, mem_used: 12.5 * G, mem_total: 64 * G, disk_used: 210 * G, disk_total: 473 * G }), [
    { k: 'CPU', v: '23.5%' },
    { k: 'MEM', v: '12.50/64.00G · 20%' },
    { k: 'DISK', v: '210.00/473.00G · 44%' },
  ]);
  // Same drop rule as sysParts: no cpu on the first sample, nothing at all for null.
  assert.deepEqual(sysDetail(null), []);
  assert.equal(sysDetail({ cpu_pct: null, mem_used: G, mem_total: 2 * G, disk_used: 0, disk_total: 0 }).map((r) => r.k).join(','), 'MEM');
  assert.equal(fmtPairFull(5, 0), '');
});

// Board #102 (owner 2026-11-10 17:15: "系统资源状态那里如果是我们这种gpu机器要显示状态 显存利用率"): a
// server with an NVIDIA GPU reports it as a fourth part, after DISK; without one the corner is
// exactly today's. Values from this host's nvidia-smi at 17:20: 1x NVIDIA L4, 100 %, 16522/23034 MiB.
const M = 1024 ** 2;
const base = { cpu_pct: 12.4, mem_used: 11 * G, mem_total: 60 * G, disk_used: 900 * G, disk_total: 1900 * G };
const l4 = { name: 'NVIDIA L4', util_pct: 100, mem_used: 16522 * M, mem_total: 23034 * M };

test('GPU: the strip reads CPU, MEM, GPU (VRAM in MEM\u2019s form); DISK and utilization are the card\u2019s (#102)', () => {
  const s = { ...base, gpu: { ...l4, count: 1 }, gpus: [l4] };
  assert.deepEqual(sysParts(s).map((p) => p.k), ['CPU', 'MEM', 'GPU'], 'four do not fit 24 x 201 px (leader note 5)');
  assert.equal(sysParts(s).at(-1)!.v, '72%', 'the VRAM percentage, 16522/23034 MiB (round 5: fits every width)');
  const card = sysDetail(s);
  assert.deepEqual(card.map((r) => r.k), ['CPU', 'MEM', 'DISK', 'GPU'], 'the card spells every one');
  // Touch has no hover card (reviewer note 42, round 4): there the strip keeps DISK and adds the GPU's
  // VRAM; the drawer has the width (measured at 390 and 320).
  assert.deepEqual(sysParts(s, { touch: true }).map((p) => [p.k, p.v]), [['CPU', '12%'], ['MEM', '11/60G'], ['DISK', '0.9/1.9T'], ['GPU', '72%']]);
  // Full VRAM reads 100%, never more.
  assert.equal(sysParts({ ...base, gpu: { ...l4, count: 1, mem_used: l4.mem_total } }).at(-1)!.v, '100%');
  assert.equal(sysParts({ ...base, gpu: { ...l4, count: 1, mem_used: l4.mem_total * 2 } }).at(-1)!.v, '100%');
  assert.deepEqual(sysParts({ ...base, gpu: null }, { touch: true }).map((p) => p.k), ['CPU', 'MEM', 'DISK'], 'no GPU: today\u2019s three');
  assert.deepEqual(card.at(-1), { k: 'GPU', v: '100.0% · 16.13/22.49G (72%) · NVIDIA L4' }, 'numbers first, the name last (round 3)');
});

test('GPU: absent, null, or a zero total changes nothing (#102)', () => {
  const today = sysParts(base);
  assert.deepEqual(sysParts({ ...base, gpu: null }), today);
  assert.deepEqual(sysParts({ ...base }), today);
  assert.deepEqual(sysParts({ ...base, gpu: { ...l4, count: 1, mem_total: 0 } }), today, 'no VRAM total: nothing to say');
  assert.deepEqual(sysDetail({ ...base, gpu: null }), sysDetail(base));
});

test('GPU: several cards read as the summed VRAM and the highest utilization; the card lists each (#102)', () => {
  const a = { name: 'NVIDIA L4', util_pct: 40, mem_used: 4 * G, mem_total: 22 * G };
  const b = { name: 'NVIDIA L4', util_pct: 90, mem_used: 10 * G, mem_total: 22 * G };
  const s = { ...base, gpu: { name: 'NVIDIA L4', count: 2, util_pct: 90, mem_used: 14 * G, mem_total: 44 * G }, gpus: [a, b] };
  assert.equal(sysParts(s).at(-1)!.v, '32%', 'VRAM summed: 14/44G');
  const rows = sysDetail(s).filter((r) => r.k.startsWith('GPU'));
  assert.deepEqual(rows, [{ k: 'GPU 0', v: '40.0% · 4.00/22.00G (18%) · NVIDIA L4' }, { k: 'GPU 1', v: '90.0% · 10.00/22.00G (45%) · NVIDIA L4' }],
    'one line per GPU, each named by its index: the card keys its rows by label (round 2)');
  // A summary without the per-GPU list still gives one line.
  assert.equal(sysDetail({ ...s, gpus: undefined }).filter((r) => r.k === 'GPU').length, 1);
});

test('GPU: an unreadable utilization drops only the card\u2019s percentage (#102)', () => {
  const s = { ...base, gpu: { ...l4, count: 1, util_pct: null }, gpus: [{ ...l4, util_pct: null }] };
  assert.equal(sysParts(s).at(-1)!.v, '72%');
  assert.deepEqual(sysDetail(s).at(-1), { k: 'GPU', v: '16.13/22.49G (72%) · NVIDIA L4' });
});

// Round 6 (leader note 77): a server name plus four readings do not fit one 284 px row (Aggregate, touch,
// a GPU: -38 px at 320, -13 at 390, validator note 73), and touch has no card; so in exactly that case the
// name takes a row of its own. Everything else is one row.
test('GPU: the strip is two rows only on touch, with a server name and a GPU (#102)', () => {
  const gpu = { ...base, gpu: { ...l4, count: 1 } };
  assert.equal(sysRows(gpu, { touch: true, tag: 'remote-a' }), 2);
  assert.equal(sysRows(gpu, { touch: false, tag: 'remote-a' }), 1, 'the desktop is one 24 px row (#326)');
  assert.equal(sysRows(gpu, { touch: true, tag: null }), 1, 'no name: four fit');
  assert.equal(sysRows(base, { touch: true, tag: 'remote-a' }), 1, 'no GPU: today\u2019s row');
  assert.equal(sysRows({ ...base, gpu: { ...l4, count: 1, mem_total: 0 } }, { touch: true, tag: 'remote-a' }), 1, 'an unshown GPU is no GPU');
  assert.equal(sysRows(null, { touch: true, tag: 'remote-a' }), 1, 'no reading');
});
