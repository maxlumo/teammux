import test from 'node:test';
import assert from 'node:assert/strict';
test('the scope hands pages an eligibility that follows the runtime s REAL detach, through one stamp (board #357)', async () => {
  const { readFile } = await import('node:fs/promises');
  const scope = await readFile(new URL('./ServerScope.svelte', import.meta.url), 'utf8');
  const live = await readFile(new URL('./runtime-liveness.svelte.ts', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('./server-runtime.ts', import.meta.url), 'utf8');
  assert.match(scope, /const liveness = observeLiveness\(runtime\);\s*onDestroy\(liveness\.stop\);/u);
  assert.match(scope, /get eligible\(\) \{ return \(\) => \{ void liveness\.read\(\); return eligible \? eligible\(\) : true; \}; \}/u, 'the eligibility READS the stamp: an effect that asked reruns on a detach');
  assert.match(live, /const off = runtime\?\.onDetach\?\.\(\(\) => \{ stamp\+\+; \}\);/u, 'the runtime s edge becomes a stamp');
  assert.doesNotMatch(live, /setInterval|setTimeout|requestAnimationFrame/u, 'no poller');
  // The runtime stays rune-free; the notification fires once, after the flag.
  assert.doesNotMatch(runtime, /\$state|\$effect/u);
  assert.match(runtime, /function detach\(\) \{\s*if \(dead\) return;\s*dead = true;\s*for \(const listener of \[\.\.\.detachListeners\]\)/u);
});
