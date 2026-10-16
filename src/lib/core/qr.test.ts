import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import decodeQR from 'qr/decode.js';
import { QR_QUIET, qrMatrix, qrPath } from './qr.ts';
import { buildConnectionLink, parseConnectionLink } from './connection-link.ts';

// Fixture credentials are fake. The link is a secret in real use.

/** The matrix as a scanner sees it: dark modules on a light ground, the quiet
 * zone around it, `scale` pixels per module. */
function raster(matrix: boolean[][], scale = 4) {
  const side = (matrix.length + 2 * QR_QUIET) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = ((QR_QUIET + y) * scale + dy) * side * 4 + ((QR_QUIET + x) * scale + dx) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }));
  return { width: side, height: side, data };
}

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TUPLES = [
  { address: 'ws://192.168.1.5:9899', token: TOKEN, socket: '/tmp/tmux-1000/default' },
  { address: 'wss://mac.tail.ts.net/ws', token: TOKEN, socket: '' },
  { address: 'ws://[::1]:19900', token: '', socket: '' },
  { address: 'wss://host.example/a/b?region=eu', token: 'fake-token&=+ %/?#~', socket: '/tmp/fake socket/with a long path/that keeps going/default' },
];

test('encode then decode returns the link, and the link returns the tuple', () => {
  for (const tuple of TUPLES) {
    const link = buildConnectionLink(tuple)!;
    const decoded = decodeQR(raster(qrMatrix(link)));
    assert.equal(decoded, link, 'the code carries exactly the link');
    const parsed = parseConnectionLink(decoded);
    assert.deepEqual(parsed, { kind: 'link', link: { address: tuple.address, token: tuple.token, socket: tuple.socket } });
  }
});

test('a code decodes at the scale a phone screen gives it', () => {
  const link = buildConnectionLink(TUPLES[0]!)!;
  for (const scale of [3, 4, 8]) assert.equal(decodeQR(raster(qrMatrix(link), scale)), link, `scale ${scale}`);
});

test('the matrix is the bare symbol: a square of a real version, with a finder pattern in three corners and no padding ring', () => {
  for (const tuple of TUPLES) {
    const matrix = qrMatrix(buildConnectionLink(tuple)!);
    const n = matrix.length;
    assert.ok(n >= 21 && (n - 17) % 4 === 0, `a QR version (21 + 4 per step), not a padded one: ${n}`);
    assert.ok(matrix.every((row) => row.length === n), 'square');
    const finder = (top: number, left: number) => [0, 6].every((i) => [0, 1, 2, 3, 4, 5, 6].every((j) => matrix[top + i]![left + j] && matrix[top + j]![left + i]));
    assert.ok(finder(0, 0) && finder(0, n - 7) && finder(n - 7, 0), 'the finder patterns sit in the corners of the matrix itself');
  }
});

test('the drawing path is one rectangle per run of dark modules and covers exactly the dark modules', () => {
  const matrix = qrMatrix(buildConnectionLink(TUPLES[1]!)!);
  const path = qrPath(matrix);
  assert.match(path, /^(M\d+ \d+h\d+v1h-\d+z)+$/u);
  const drawn = matrix.map((row) => row.map(() => false));
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/gu).map((m) => [m[0], Number(m[1]), Number(m[2]), Number(m[3])] as const)) {
    for (let i = 0; i < w; i++) drawn[y]![x + i] = true;
  }
  assert.deepEqual(drawn, matrix);
  assert.equal(qrPath([[false, false], [false, false]]), '', 'an empty code draws nothing');
});

test('the module keeps no copy of what it encodes and says nothing about it', async () => {
  const source = await readFile(new URL('./qr.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|fetch\(|XMLHttpRequest|navigator\./u);
});
