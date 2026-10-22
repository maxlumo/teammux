import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const [hub, board, files, chat, feed, helper, save] = await Promise.all([
  read('../hub/Hub.svelte'), read('../hub/Board.svelte'), read('./Files.svelte'), read('../hub/ChatImage.svelte'),
  read('../hub/Feed.svelte'), read('./viewer-download.svelte.ts'), read('./save-file.ts'),
]);

// Board #447: ONE download attempt (save-file.ts), ONE viewer helper, and an open that is one record.

test('every host builds its Lightbox from ONE open record and offers a download only for a server file (#447)', () => {
  assert.match(hub, /\{@const open = shotView\}\s*<Lightbox src=\{open\.src\} onclose=\{closeShot\}\s*ondownload=\{open\.ref \? \(\) => viewerDl\.start\(open\) : undefined\} downloading=\{viewerDl\.busy\(open\)\}\s*status=\{viewerDl\.status\} onstatusdismiss=\{viewerDl\.dismiss\} \/>/u);
  assert.match(board, /\{@const open = shotView\}\s*<Lightbox src=\{open\.src\} onclose=\{closeShot\}\s*ondownload=\{open\.ref \? \(\) => viewerDl\.start\(open\) : undefined\} downloading=\{viewerDl\.busy\(open\)\}\s*status=\{viewerDl\.status\} onstatusdismiss=\{viewerDl\.dismiss\} \/>/u);
  assert.match(files, /\{@const open = imageView\}\s*<Lightbox src=\{open\.src\} alt=\{open\.label\} onclose=\{closeImage\}\s*ondownload=\{open\.ref \? \(\) => viewerDl\.start\(open\) : undefined\} downloading=\{viewerDl\.busy\(open\)\}\s*status=\{viewerDl\.status\} onstatusdismiss=\{viewerDl\.dismiss\} \/>/u);
  for (const [name, source] of [['Hub', hub], ['Board', board], ['Files', files]] as const) {
    assert.doesNotMatch(source, /<Lightbox[^>]*src=\{(shotView|imageView)\}/u, `${name}: the viewer never takes a bare URL`);
    assert.match(source, /(?:shotView|imageView) = \$state\.raw[<(]/u);
  }
  // The Files record is taken in the tap handler, label included, never from the live selection later.
  assert.match(files, /imageView = viewerOpen\(src, currentFile\?\.path \?\? null, currentFile\?\.name \?\? ''\);/u);
  // A composer / attachment thumbnail is a local blob: no reference.
  assert.match(hub, /onpreview=\{\(path\) => showShot\(viewerOpen\(path\)\)\}/u);
  assert.equal(board.match(/onpreview=\{\(u\) => showShot\(viewerOpen\(u\)\)\}/gu)?.length, 3);
});

test('the open retires on the host\'s own visible-and-eligible gate, on its false edge, and on destroy (#447)', () => {
  assert.match(hub, /\$effect\(\(\) => \{ if \(!searchActive\) untrack\(closeShot\); \}\);/u, 'Hub: the gate its search already uses');
  assert.match(hub, /const searchActive = \$derived\(visible && \(scope\.eligible \? scope\.eligible\(\) : true\)\);/u);
  assert.match(board, /\$effect\(\(\) => \{ if \(!eligible\(\)\) untrack\(closeShot\); \}\);/u, 'Board: its own eligible()');
  assert.match(files, /const imageActive = \$derived\(visible && \(scope\.eligible \? scope\.eligible\(\) : true\)\);\s*\$effect\(\(\) => \{ if \(!imageActive\) untrack\(closeImage\); \}\);/u);
  assert.match(hub, /onDestroy\(\(\) => \{ viewClaim\.retire\(\); viewerDl\.dispose\(\); \}\);/u);
  assert.match(board, /viewClaim\.retire\(\); viewerDl\.dispose\(\);/u);
  assert.match(files, /\$effect\(\(\) => \(\) => viewerDl\.dispose\(\)\);/u);
  // closing is ONE function per host: claim, feedback and record together.
  assert.match(hub, /function closeShot\(\) \{\s*viewClaim\.retire\(\);\s*viewerDl\.retire\(\);\s*shotView = null;\s*\}/u);
  assert.match(board, /function closeShot\(\) \{\s*viewClaim\.retire\(\);\s*viewerDl\.retire\(\);\s*shotView = null;\s*\}/u);
  assert.match(files, /function closeImage\(\) \{\s*viewerDl\.retire\(\);\s*imageView = null;\s*\}/u);
});

test('the tap\'s claim and reference travel from the thumbnail to the host (#447)', () => {
  assert.match(chat, /const ref = src;\s*const claim = onviewstart\?\.\(\);\s*resolve\(ref\)\.then\(\(u\) => onview\?\.\(u, claim, isDirectUrl\(ref\) \? null : ref\)\)/u);
  assert.match(feed, /onviewstart=\{onimagestart\} onview=\{onimage\}/u);
  assert.match(hub, /onimagestart=\{\(\) => viewClaim\.begin\(\)\}\s*onimage=\{\(url, claim, ref\) => \{ if \(searchActive && viewClaim\.accept\(claim\)\) showShot\(viewerOpen\(url, ref\)\); \}\}/u, 'an answer opens only while the host is active, for the latest claim');
  assert.match(board, /if \(eligible\(\) && viewClaim\.accept\(c\)\) showShot\(viewerOpen\(u, ref\)\);/u);
  assert.match(board, /const viewClaim = createViewClaim\(\(\) => opGen\);/u);
});

test('one attempt for every caller; the helper takes its token and its guard before any await (#447)', () => {
  assert.doesNotMatch(files, /memorySink|nativeSink|download\(\{/u, 'Files no longer carries the protocol');
  assert.match(files, /return saveServerFile\(saveDeps, path, instance, \{/u);
  assert.match(helper, /void saveServerFile\(deps, record\.ref, record, \{/u, 'the viewer calls the same function');
  const start = helper.slice(helper.indexOf('start(record: ViewerOpen | null): void {'));
  assert.ok(start.indexOf('if (shownOpen === record && !shownEnded) return;') < start.indexOf('lifetime.begin()'), 'a repeated activation returns before it takes a token');
  assert.ok(start.indexOf('lifetime.begin()') < start.indexOf('saveServerFile('), 'and the token exists before the attempt starts');
  assert.match(save, /say\.began\?\.\(rowId\);/u, 'progress is read by the attempt\'s row id');
  assert.match(save, /\(deps\.ready \?\? realmReady\)\(\)/u, 'what Files needed loaded travels with the attempt');
});

test('every way a viewer opens ends the earlier claim and feedback; a download asks the host at the door (#447 review P1-A)', () => {
  assert.match(hub, /function showShot\(record\) \{\s*viewClaim\.retire\(\);\s*viewerDl\.retire\(\);\s*shotView = record;\s*\}/u, 'a local attachment advances the same claim a signed image takes');
  assert.match(board, /function showShot\(record: ViewerOpen\) \{\s*viewClaim\.retire\(\);\s*viewerDl\.retire\(\);\s*shotView = record;\s*\}/u);
  assert.match(hub, /createViewerDownload\(scope, \(record\) => shotView === record && searchActive\)/u, 'the current open, by identity, and the host gate');
  assert.match(board, /createViewerDownload\(scope, \(record\) => shotView === record && eligible\(\)\)/u);
  assert.match(files, /createViewerDownload\(scope, \(record\) => imageView === record && imageActive\)/u);
  assert.match(helper, /if \(!alive \|\| !record \|\| !record\.ref \|\| !isCurrent\(record\)\) return;/u, 'refused before a token, before any await');
  assert.match(save, /await \(deps\.ready \?\? realmReady\)\(\);\s*\/\/[^\n]*\n[^\n]*\n\s*throwIfCancelled\(control\.signal\);\s*const dlInfo/u, 'a cancel or suspend during the preparation ends the attempt before the signature');
});
