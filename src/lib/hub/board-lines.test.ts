import test from 'node:test';
import assert from 'node:assert/strict';

// Board #150: the Board's two answer lines, moved out of Board.svelte unchanged. The expected
// values are the English table's own words.
(globalThis as any).$state = (value: unknown) => value;
(globalThis as any).localStorage = { getItem: () => 'en', setItem: () => {} };
(globalThis as any).document ??= { documentElement: { lang: 'en' } };
const { dispatchLine, saveError } = await import('./board-lines.ts');

test('a save refusal: the two gates in the page\u2019s words, anything else as the server said it', () => {
  assert.equal(saveError({ code: 'server_too_old' }), 'This server is older than the app. Update the server to assign.');
  assert.equal(saveError({ code: 'login_pending' }), 'Still connecting to the server. Try again in a moment.');
  assert.equal(saveError(new Error('disk full')), 'disk full');
  assert.equal(saveError('plain'), 'plain');
});

test('the line owed when the assignee was not reached, and none when it was', () => {
  assert.equal(dispatchLine({ dispatch: 'failed', dispatch_error: 'pane gone' }, 'dev'), 'Saved, but dev was not told: pane gone.');
  assert.equal(dispatchLine({ dispatch: 'offline', offline: [{ why: 'stopped' }] }, 'dev'), 'Saved, but dev was not reached (stopped); nothing is queued for it.');
  assert.equal(dispatchLine({ dispatch: 'offline', dispatch_error: 'no tmux' }, 'dev'), 'Saved, but dev was not reached (no tmux); nothing is queued for it.');
  assert.equal(dispatchLine({ dispatch: 'sent' }, 'dev'), '');
  assert.equal(dispatchLine(null, 'dev'), '');
});
