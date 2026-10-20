// Source contracts of the Hub's search box (board #432). Each pins a decision
// the reviewer made binding, so a later "simplification" fails here instead of
// shipping: the box moves on transform/opacity only, collapses by its whole
// region's focus, is one popover of the existing dialect, reports its jump to
// its own generation, and leaves the feed and the composer alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('the bar is an overlay entered with the shared fade; no width or height is animated (motion.md §3)', async () => {
  const src = await read('./HubSearch.svelte');
  assert.match(src, /class="search-bar appear"/u, 'the existing .appear atom, not a new keyframe');
  assert.match(src, /\.search-bar \{\s*position: absolute; inset: 0;/u, 'it covers the row without taking a slot in it');
  assert.doesNotMatch(src, /transition:\s*[^;}]*\b(width|height|max-width|min-width|inset|left|right|top)\b/u, 'nothing animates layout');
  assert.doesNotMatch(src, /@keyframes/u, 'no private keyframes: the vocabulary has the fade');
  assert.doesNotMatch(src, /svelte\/transition/u, 'exits are cuts, intros are the classes (motion.source.test)');
});

test('the results are the centre’s popover dialect: menu-surface, pop-layer, one resolved menuPlacement + popOrigin', async () => {
  const src = await read('./HubSearch.svelte');
  assert.match(src, /class="search-panel menu-surface menu-list pop-layer"/u);
  assert.match(src, /menuPlacement\(anchor, \{ w: panelW, h: panelH \}, viewBox\(\), POPOVER_GAP, POPOVER_EDGE, 'left'\);\s*\n\s*return \{ pos, origin: popOrigin\(anchor, pos, 'left'\) \};/u,
    'position, room and grow origin come from one placement');
  assert.match(src, /style:--pop-origin=\{place\?\.origin\}/u);
  assert.doesNotMatch(src, /<Dialog|role="menu"/u, 'not a modal and not a menu: a popover dialog');
});

test('collapse is decided by the whole region’s focus, never by the input’s own blur', async () => {
  const src = await read('./HubSearch.svelte');
  assert.doesNotMatch(src, /\bonblur\s*=/u, 'no input blur handler');
  assert.match(src, /onfocusout=\{focusout\}/u);
  assert.equal((src.match(/onfocusout=\{focusout\}/gu) ?? []).length, 2, 'the bar AND the results');
  assert.match(src, /if \(!search\.open \|\| pressInside \|\| inRegion\(document\.activeElement\)\) return;/u, 'a press still down and focus that ended inside both keep it, decided after the move settled');
  assert.doesNotMatch(src, /windowBlurred|relatedTarget/u, 'a blurred window keeps its focused element, so it needs no flag of its own');
  assert.match(src, /if \(!search\.query\.trim\(\)\) search\.close\(\);/u, 'only an EMPTY query collapses');
  assert.match(src, /role="dialog" aria-modal="false" aria-label=\{t\('hubSearch'\)\} tabindex="-1"/u, 'the results are a focusable container, so a click on bare space keeps focus inside');
  assert.match(src, /class="search-bar appear" bind:this=\{barEl\} role="search" tabindex="-1"/u, 'and so is the bar');
});

test('Escape is read in the capture phase and is an IME’s while it composes', async () => {
  const src = await read('./HubSearch.svelte');
  assert.match(src, /<svelte:window onkeydowncapture=/u);
  assert.match(src, /e\.key === 'Escape' && !e\.isComposing && e\.keyCode !== 229/u);
  assert.match(src, /e\.stopPropagation\(\);\s*\n\s*search\.close\(\);/u, 'a dialog behind it does not also close');
});

test('results draw text nodes and marks, never HTML', async () => {
  const src = await read('./HubSearch.svelte');
  assert.doesNotMatch(src, /\{@html/u);
  assert.doesNotMatch(src, /innerHTML/u);
});

test('the feed and the composer know nothing of the search box', async () => {
  for (const file of ['./Feed.svelte', './Composer.svelte']) {
    const src = await read(file);
    assert.doesNotMatch(src, /HubSearch|hub-search|createHubSearch/u, `${file}: the box lives in the Hub header alone`);
  }
});

test('a hit opens through the bell’s jump with its own report; it is never recorded as a notification', async () => {
  const hub = await read('./Hub.svelte');
  assert.match(hub, /const done = report \?\? \{ viewed: \(\) => centre\.viewed\(alert\.key\), failed: \(reason\) => centre\.failed\(alert\.key, reason\) \};/u,
    'absent a report, the bell’s own way, unchanged');
  const open = hub.slice(hub.indexOf('async function openAt'), hub.indexOf('// Leaving the Hub page'));
  assert.doesNotMatch(open.replace(/const done = [^\n]*\n/u, ''), /centre\.(failed|viewed)\(/u, 'every refusal and the landing in openAt go through the report');
  assert.match(hub, /centre\.requestJump\(\s*\{ server: serverId\(\), room: hit\.room, session: '', id: String\(hit\.id\), seq: hit\.seq \},\s*\{ viewed: \(\) => \{ if \(search\.isCurrent\(g\)\) search\.close\(\); \}, failed: \(reason\) => search\.fail\(g, reason\) \},\s*\)/u);
  const jump = hub.slice(hub.indexOf('function jumpToHit'), hub.indexOf('function jumpToHit') + 700);
  assert.doesNotMatch(jump, /centre\.record|search:/u, 'no AlertLog entry, no search: key prefix');
  assert.match(hub, /\$effect\(\(\) => \{ if \(centre\.anchor && search\.open\) untrack\(\(\) => search\.close\(\)\); \}\);/u, 'one popover at a time');
  assert.match(hub, /onclick=\{\(\) => \{ centre\.close\(\); search\.show\(\); \}\}/u, 'and the other direction');
});

test('the request is invalidated at the input, and an answer needs a current generation', async () => {
  const src = await read('./hub-search.svelte.ts');
  assert.match(src, /function run\(now: boolean\) \{\s*\n\s*const g = bump\(\);/u, 'bump first, synchronously, before any debounce');
  assert.equal((src.match(/if \(g !== gen \|\| !state\.open\) return;/gu) ?? []).length, 3, 'before sending and after the answer, and on a failure');
  assert.match(src, /clearTimeout\(timer\)/u);
});

test('the client sends all/global only when set, so the default stays any-term', async () => {
  const api = await read('../core/ws-api.ts');
  assert.match(api, /\.\.\.\(opts\.all \? \{ all: true \} : \{\}\), \.\.\.\(opts\.global \? \{ global: true \} : \{\}\)/u);
  assert.match(api, /hubSearch: 'read'/u);
});

test('spacing comes from the existing tokens; the only literal lengths are the popover’s own geometry caps (#432 review P2)', async () => {
  const src = await read('./HubSearch.svelte');
  const css = src.slice(src.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//gu, '');
  const withoutPanel = css.replace(/\.search-panel \{[^}]*\}/u, '');
  assert.doesNotMatch(withoutPanel, /\d+px/u, 'no literal pixel value outside the popover’s width/height cap');
  assert.match(css, /\.search-bar \{[^}]*padding: inherit;/u, 'the bar sits where the header’s own content sits, whatever its padding is');
});

test('the term cap is one number on both sides, and the chip is capped on the button itself (#432 review)', async () => {
  const rust = await read('../../../src-tauri/src/server/hub_rpc.rs');
  const ts = await read('./hub-search.ts');
  const server = /const MAX_SEARCH_TERMS: usize = (\d+);/u.exec(rust)?.[1];
  const client = /export const SEARCH_MAX_TERMS = (\d+);/u.exec(ts)?.[1];
  assert.ok(server && server === client, `server ${server} and client ${client} state the same cap`);
  const hub = await read('./Hub.svelte');
  const css = hub.slice(hub.indexOf('<style>'));
  assert.match(css, /\.filter-face :global\(\.command-button\) \{ flex: 0 1 auto; min-width: 0; max-width: 100%; \}/u,
    'CommandButton’s root is flex: none; without this the cap on the wrapper clips nothing and a long name overflows the tools after it');
  assert.match(css, /\.filter-face :global\(\.command-label\) \{[^}]*text-overflow: ellipsis;/u, 'and only the label ellipsizes, so the icon and the hit box stay');
  assert.match(hub, /title=\{t\('hubSearchOnly'\)\.replace\('\{name\}', filterName\(filterAgent\)\)\}/u, 'the chip’s accessible name says it is the search and names the full filter');
});

test('the token keeps its name until the field is at its minimum (#432 validator P2-D)', async () => {
  const src = await read('./HubSearch.svelte');
  assert.match(src, /\.search-token \{[^}]*flex: 0 0 auto; max-width: 50%;/u, 'it does not shrink with the field; only a very long name is cut, at half the bar');
});
