// Board #91: the Terminal and Sessions pages read a renamed agent's label
// through the ONE reading (names.ts, via watchLabels), never their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p: string) => readFile(new URL(p, import.meta.url), 'utf8');

test('the Terminal and Sessions pages show and search labels only through names.ts (#91)', async () => {
  const [terminal, sessions, helper] = await Promise.all([read('../terminal/Terminal.svelte'), read('../sessions/Sessions.svelte'), read('./session-labels.svelte.ts')]);
  assert.match(helper, /import \{ agentNames, patchNames, NO_LABELS[^}]*\} from '\.\/names\.ts';/u, 'the helper applies the server\u2019s table through names.ts');
  assert.match(terminal, /const labels = watchLabels\(runtime\);/u);
  assert.match(terminal, /labels\.names\(w\.session\)\.shown\(w\.window_name\)/u, 'the tab shows the label by the one reading');
  assert.match(terminal, /return \{ title: `\$\{w\.window\}:\$\{w\.window_name\}`, lines \};/u, 'the hover card keeps the physical window name');
  assert.match(sessions, /searchMatches\(p, q, labels\?\.names\(p\.session\) \?\? NO_LABELS/u, 'the search reads the label by the one reading');
  for (const [file, text] of [['Terminal.svelte', terminal], ['Sessions.svelte', sessions]] as const) {
    assert.doesNotMatch(text, /\.labels\?*\.find\(|\.label \?\?|aliases\.includes/u, `${file}: no label resolution of its own`);
  }
});
