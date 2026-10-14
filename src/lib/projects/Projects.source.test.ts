import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Projects.svelte', import.meta.url), 'utf8');

test('confirmation Back registers no global history or key listener (#167, 2026-09-12)', () => {
  // Projects supplies a callback to Sessions, not another native Back owner.
  assert.doesNotMatch(source, /\b(?:window|document)\.addEventListener\(['"](?:popstate|keydown)['"]/u);
});

test('project confirmation icons distinguish Close from removal (#167, 2026-09-12)', () => {
  // The shared dialog must not derive the glyph from the danger tone.
  assert.match(source, /confirmIcon=\{pending\?\.kind === 'down' \? 'stop' : 'trash'\}/u);
  assert.match(source, /projectArchive'\), icon: 'trash'/u);
});

test('Terminal Projects uses the same update clock as Chat', () => {
  assert.match(source, /import \{ declaredWindowChips, liveWindowChips, projectAgeLabel, shortPath, sortRows \} from '\.\/projects\.ts';/u);
  assert.match(source, /projectList\(\),\s*\n\s*hubRooms\(\)\.catch\(\(\) => null\)/u,
    'the component loads the shared conversation timestamp map');
  assert.match(source, /if \(rooms\) talkMap = rooms\.rooms \?\? \{\};/u,
    'a failed rooms read keeps the last map');
  assert.match(source, /sortRows\(rows, talkMap\)/u, 'sorting consumes that same map');
  assert.equal([...source.matchAll(/projectAgeLabel\(row, talkMap, tick\)/gu)].length, 2,
    'the row and its hover card use the one shared formatter');
});

test('the dense row menu rides the title line, as in Chat (owner, 2026-09-24)', () => {
  assert.match(source, /\.projects\.dense \.line \{ padding-right: 32px; \}/u, 'only the title line keeps the 24+8 room');
  assert.match(source, /\.projects\.dense \.row-menu \{ position: absolute; right: 10px; top: 6px; \}/u);
  assert.doesNotMatch(source, /\.projects\.dense \.proj-top \{[^}]*padding-right/u, 'the windows beneath take the full width');
});

// ── Board #371: the Terminal list is ONE list over the included servers ─────

test('the rows are this server\'s and the other servers\' MERGED by the one comparator, every row on the same grammar (#371)', async () => {
  // One list: the keyed each runs over the MERGED entries, the animated child is
  // the wrapper (a keyed each with `animate:flip` allows no other child), and a
  // foreign row is drawn by the host's snippet.
  assert.match(source, /const entries = \$derived\(mergeTerminalRows\(\{/u);
  assert.match(source, /local: sorted, localTalk: talkMap,/u, 'this server\'s slice is its own sortRows, with its own clock');
  assert.match(source, /\{#each entries as entry \(entry\.key\)\}\s*<div class="entry" animate:flip=\{\{ duration: moveMs\(\) \}\}>/u);
  assert.match(source, /\{:else if foreignRow\}\s*\{@render foreignRow\(entry\)\}/u);
  // THIS server's bare sessions are entries of the same each (review P1).
  assert.match(source, /\{:else if entry\.item\.kind === 'session' && sessionRow\}\s*\{@render sessionRow\(entry\)\}/u);
  assert.match(source, /localSessions: sessionRow \? localSessions : \[\], localTag: scope\.tag \?\? null,/u);
  assert.match(source, /\|\| \(sessionRow && localSessions\.length > 0\)\}/u, 'the section shows for bare sessions alone (no project support, or none answered yet)');
  assert.doesNotMatch(source, /\{#each sorted as/u, 'no second list of the same rows');
  // The section also shows for the other servers' rows alone, but its header
  // and New command belong to THIS server's rows.
  assert.match(source, /\{#if \(supported && sorted\.length > 0\) \|\| \(foreignRow && foreign && foreign\.rows\.length > 0\) \|\| \(sessionRow && localSessions\.length > 0\)\}/u);
  assert.match(source, /\{#if sorted\.length > 0\}\s*<div class="group-label"/u);
  // The tag line: the Chat rows' atom, the scope's LIVE tag (null in Single),
  // sidebar rows only. ONE context read for the api and the tag.
  assert.match(source, /\{#if dense && scope\.tag\}<span class="p-source"><ServerTag name=\{scope\.tag\} \/><\/span>\{\/if\}/u);
  assert.equal(source.match(/useServer(?:Scope|Api|Runtime)\(/gu)?.length, 1, 'one context read');
  // Single is untouched: the dot only moves off-centre when there IS a tag line.
  assert.match(source, /\.projects\.dense \.proj-main:has\(\.p-source\) \{ align-items: flex-start; \}/u);
  assert.match(source, /\.projects\.dense \.proj-main:has\(\.p-source\) \.dot \{ margin-top: 6px; \}/u);
});

test('terminal-merge merges through the union\'s merge with the domain comparator and never sorts the merged list (#371)', async () => {
  const merge = await readFile(new URL('../sessions/terminal-merge.ts', import.meta.url), 'utf8');
  assert.match(merge, /compareRowsWithClock\(\{ row: x\.item\.row, talk: x\.item\.talk \}, \{ row: y\.item\.row, talk: y\.item\.talk \}\)/u, 'the Hub\'s comparator, each row by its OWN clock');
  assert.match(merge, /unionRows<TermItem, Ref>\(slices, \{[\s\S]*?compare: \(x, y\) => cmp\(x, y\),/u, 'through the one merge');
  assert.equal(merge.match(/\.sort\(/gu)?.length, 2, 'only a SLICE is ever ordered, never the merged list: a foreign slice (it arrives in tmux\'s order) and the local slice that gains bare sessions');
  assert.match(merge, /for \(const items of byServer\.values\(\)\) items\.sort/u);
  assert.match(merge, /if \(a\.localSessions\?\.length\) \{[\s\S]*?locals\.sort\(\(x, y\) => cmp\(\{ item: x \}, \{ item: y \}\)\);\s*\}/u, 'and the local slice only when it has bare sessions to place (Single never does)');
  assert.match(merge, /const row: ProjectRow = c \? \{ \.\.\.c\.row, live: true \} : unclocked\(f\.item\.name\);/u, 'a running session is LIVE, with the Hub\'s clock when the host has the project row');
});
