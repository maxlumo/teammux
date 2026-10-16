import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startNativeScan, type ScannerPlugin } from './qr-native.ts';

function plugin(over: Partial<ScannerPlugin> & { permission?: string; afterRequest?: string; scanned?: () => Promise<{ content: string }> } = {}) {
  const calls: string[] = [];
  const options: unknown[] = [];
  const fake: ScannerPlugin = {
    Format: { QRCode: 'QR_CODE' },
    checkPermissions: async () => { calls.push('check'); return over.permission ?? 'granted'; },
    requestPermissions: async () => { calls.push('request'); return over.afterRequest ?? 'granted'; },
    scan: async (o) => { calls.push('scan'); options.push(o); return over.scanned ? over.scanned() : { content: 'wss://h/ws?token=FAKE&socket=' }; },
    cancel: async () => { calls.push('cancel'); },
    ...over,
  };
  return { fake, calls, options };
}

test('a granted camera scans windowed for a QR code only, hands back the text, and shows the live view only when there is one', async () => {
  const p = plugin();
  let live = 0;
  const run = startNativeScan(() => { live++; assert.deepEqual(p.calls, ['check'], 'the page turns transparent after the permission, before the scan'); }, async () => p.fake);
  assert.deepEqual(await run.done, { kind: 'text', text: 'wss://h/ws?token=FAKE&socket=' });
  assert.equal(live, 1);
  assert.deepEqual(p.calls, ['check', 'scan'], 'no request when already granted');
  assert.deepEqual(p.options, [{ windowed: true, formats: ['QR_CODE'] }]);
});

test('an ungranted camera is asked for once, and a refusal is "denied" with the page never made transparent', async () => {
  const p = plugin({ permission: 'prompt', afterRequest: 'denied' });
  const run = startNativeScan(() => assert.fail('no live view behind a permission prompt'), async () => p.fake);
  assert.deepEqual(await run.done, { kind: 'denied' });
  assert.deepEqual(p.calls, ['check', 'request']);
  const again = plugin({ permission: 'prompt' });
  assert.deepEqual(await startNativeScan(() => {}, async () => again.fake).done, { kind: 'text', text: 'wss://h/ws?token=FAKE&socket=' });
  assert.deepEqual(again.calls, ['check', 'request', 'scan']);
});

test('cancelling stops the camera once, and the scan that rejects because of it is "cancelled", not a failure', async () => {
  let reject!: (e: Error) => void;
  const p = plugin({ scanned: () => new Promise((_, no) => { reject = no; }) });
  const run = startNativeScan(() => {}, async () => p.fake);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run.cancel(); run.cancel();
  reject(new Error('cancelled'));
  assert.deepEqual(await run.done, { kind: 'cancelled' });
  assert.equal(p.calls.filter((c) => c === 'cancel').length, 1);
});

test('a scan that never settles, as on a device with no camera, still ends when the person cancels', async () => {
  const p = plugin({ scanned: () => new Promise(() => {}) });
  const run = startNativeScan(() => {}, async () => p.fake);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  run.cancel();
  assert.deepEqual(await run.done, { kind: 'cancelled' });
});

test('a plugin that cannot load, or a scan that fails by itself, is "failed" and says nothing about why', async () => {
  assert.deepEqual(await startNativeScan(() => {}, async () => { throw new Error('no plugin'); }).done, { kind: 'failed' });
  const p = plugin({ scanned: async () => { throw new Error('boom SECRET'); } });
  assert.deepEqual(await startNativeScan(() => {}, async () => p.fake).done, { kind: 'failed' });
  assert.deepEqual(await startNativeScan(() => {}, async () => plugin({ scanned: async () => ({ content: '' }) }).fake).done, { kind: 'failed' }, 'an empty read is no read');
});

test('cancelling before the permission answer never starts the camera', async () => {
  const p = plugin({ permission: 'prompt' });
  const run = startNativeScan(() => assert.fail('no live view'), async () => p.fake);
  run.cancel();
  assert.deepEqual(await run.done, { kind: 'cancelled' });
  assert.ok(!p.calls.includes('scan'));
});

test('the module reads nothing but the plugin, and keeps and logs nothing', async () => {
  const source = await readFile(new URL('./qr-native.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|decodeQR/u);
});
