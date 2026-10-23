import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubBackRegistry } from './hub-back.ts';
import type { HubBackLayer } from './hub-back.ts';

// #168 removes agentMenu/recipient/send-arm whole; surviving priority is unchanged.
// The contract is independent of the implementation's order table.
const priority: HubBackLayer[] = [
  'lightbox', 'contextMenu', 'turnRail', 'palette',
  'action', 'trash', 'picker', 'create', 'rename', 'search', 'filter', 'files', 'drawer', 'sidebar',
];

test('registry dispatch follows the fixed priority, not registration order', () => {
  const registry = createHubBackRegistry();
  const trace: HubBackLayer[] = [];
  for (const layer of [...priority].reverse()) {
    registry.register(layer, () => { trace.push(layer); return false; });
  }
  assert.equal(registry.back(), false);
  assert.deepEqual(trace, priority);
});

test('every layer can consume once, and all pairwise overlaps peel by priority', () => {
  const check = (open: HubBackLayer[]) => {
    const registry = createHubBackRegistry();
    const active = new Set(open);
    const trace: HubBackLayer[] = [];
    for (const layer of [...priority].reverse()) {
      registry.register(layer, () => {
        if (!active.delete(layer)) return false;
        trace.push(layer);
        return true;
      });
    }
    for (const _layer of open) assert.equal(registry.back(), true);
    assert.equal(registry.back(), false);
    assert.deepEqual(trace, open);
  };
  for (let i = 0; i < priority.length; i++) {
    check([priority[i]!]);
    for (let j = i + 1; j < priority.length; j++) check([priority[i]!, priority[j]!]);
  }
});

test('repeated Back reaches the compact list floor without cycling it closed', () => {
  const registry = createHubBackRegistry();
  let open = true;
  let compact = true;
  let sideOpen = false;
  registry.register('palette', () => {
    if (!open) return false;
    open = false;
    return true;
  });
  registry.register('sidebar', () => {
    if (compact && !sideOpen) { sideOpen = true; return true; }
    return false;
  });
  assert.equal(registry.back(), true);
  assert.equal(sideOpen, false);
  assert.equal(registry.back(), true);
  assert.equal(sideOpen, true);
  assert.equal(registry.back(), false);
  assert.equal(registry.back(), false);
  assert.equal(sideOpen, true);
  compact = false; sideOpen = false;
  assert.equal(registry.back(), false, 'desktop has no compact floor lift');
});

test('a busy confirmation consumes Back; the next call reads its live busy state (#167)', () => {
  const registry = createHubBackRegistry();
  let pending = true;
  let acting = true;
  let drawerOpen = true;
  registry.register('action', () => {
    if (!pending) return false;
    if (!acting) pending = false;
    return true;
  });
  registry.register('drawer', () => {
    if (!drawerOpen) return false;
    drawerOpen = false;
    return true;
  });
  assert.equal(registry.back(), true);
  assert.equal(pending, true);
  // #167 deliberately reverses fallthrough: a pending action must not close
  // the drawer under its own confirmation.
  assert.equal(drawerOpen, true);
  acting = false;
  assert.equal(registry.back(), true);
  assert.equal(pending, false);
  assert.equal(drawerOpen, true);
  assert.equal(registry.back(), true);
  assert.equal(drawerOpen, false);
  assert.equal(registry.back(), false);
});

test('Files consumes before the drawer only when its guarded delegate returns true', () => {
  const registry = createHubBackRegistry();
  let open = false;
  let view = 'term';
  let delegate: (() => boolean) | undefined;
  let calls = 0;
  registry.register('files', () => {
    if (open && view === 'files' && delegate?.()) return true;
    return false;
  });
  registry.register('drawer', () => {
    if (!open) return false;
    open = false;
    return true;
  });
  delegate = () => { calls++; return true; };
  assert.equal(registry.back(), false);
  open = true;
  assert.equal(registry.back(), true);
  assert.equal(calls, 0, 'a closed drawer or another partition never calls Files');
  open = true; view = 'files';
  assert.equal(registry.back(), true);
  assert.equal(open, true);
  assert.equal(calls, 1);
  delegate = () => { calls++; return false; };
  assert.equal(registry.back(), true);
  assert.equal(open, false);
  open = true; delegate = undefined;
  assert.equal(registry.back(), true);
  assert.equal(open, false);
});

test('disposal removes only its registration, including same-function replacements', () => {
  const registry = createHubBackRegistry();
  const callback = () => true;
  const disposeOld = registry.register('palette', callback);
  const disposeCurrent = registry.register('palette', callback);
  disposeOld();
  assert.equal(registry.back(), true, 'an old disposer cannot remove a new registration of the same callback');
  disposeCurrent();
  disposeCurrent();
  assert.equal(registry.back(), false);
  const dispose = registry.register('palette', () => false);
  registry.register('palette', callback);
  dispose();
  assert.equal(registry.back(), true);
});

test('registries are per owner, and missing callbacks are skipped', () => {
  const first = createHubBackRegistry();
  const second = createHubBackRegistry();
  const dispose = first.register('drawer', () => true);
  assert.equal(first.back(), true);
  assert.equal(second.back(), false);
  dispose();
  assert.equal(first.back(), false);
});
