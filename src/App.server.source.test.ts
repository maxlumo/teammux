import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./App.svelte', import.meta.url), 'utf8');
const list = await readFile(new URL('./lib/app/ServerList.svelte', import.meta.url), 'utf8');
const picker = source.slice(source.indexOf('{#if serverMenuOpen}'), source.indexOf('<!-- Forgetting a saved server'));

test('server switching is immediate and rename has its own sibling command (#165)', () => {
  assert.doesNotMatch(source, /smClickTimer|smRowClick|smRowDbl/u,
    'do not hold a click to infer a double click; remove the old mechanism whole');
  assert.doesNotMatch(list, /ondblclick/u);
  assert.match(list, /onclick=\{\(\) => onpick\(s\.id\)\}/u);
  assert.match(picker, /onpick=\{\(id\) => \{ serverMenuOpen = false; doServerSwitch\(id\); \}\}/u);
  assert.match(list, /<CommandButton variant="icon" icon="edit"/u);
  assert.match(list, /disabled=\{renaming === s\.id \|\| !!frozen\} onclick=\{\(e: MouseEvent\) => \{ e\.stopPropagation\(\); start\(s, e\.currentTarget as HTMLElement\); \}\}/u,
    'the pencil captures its own row, cannot restart an in-progress edit, and never bubbles into a switch');
  assert.match(source, /function doServerSwitch\(id\) \{[\s\S]*?void switchTo\(target\);/u,
    'a picked row goes through the one switch path');
});
