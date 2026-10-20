// Board #57 — new-message notifications: the GATE is the design, so the gate
// is what these tests pin, in both layers. Layer 1: seen keys — hub_log's
// since_ts poll is inclusive and cache-restored rooms re-pull, so a replayed
// batch must alert at most once, and first pages / watched batches / muted
// periods must never BACKFILL later. Layer 2: the news gate — own words, app
// narration and ambient progress are not news; nothing fires while looking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  notifiable, notifyText, excerpt, cueDue, msgKey, sift, playCue, notifyNews,
  isAway, roomProjectName, systemNotify, taskFinished, DEFAULT_LEVEL, NOTIFY_LEVELS, notifyLevel, setNotifyLevel,
  CUE_COOLDOWN_MS, CUE_SRC, SEEN_CAP, newsKind, bellKind,
  type FeedMsg, type NotifyState, type NotifyEnv, type NotifyLevel,
} from './notifications.ts';

const away = { first: false, away: true };
const fresh = (): NotifyState => ({ seen: new Set(), lastCueAt: 0 });
/** A notifyNews harness with counting channels and the mute injectable. */
function harness(enabled = true) {
  const fired: { cue: number; sys: string[] } = { cue: 0, sys: [] };
  const effects = {
    cue: () => { fired.cue++; return true; },
    sys: (t: { title: string; body: string; tag?: string }) => { fired.sys.push(t.title); return true; },
    enabled: () => enabled,
  };
  return { fired, effects };
}

// ─── Layer 2: the news gate ─────────────────────────────────────────────────

test('notifiable: an agent message to you while away is news; one to another agent is not (#334)', () => {
  const toMe = { ...away, level: 'replies' as const };
  assert.equal(notifiable([{ from: 'builder-2', body: 'done with the parser', ts: 5, to: ['human'] }], toMe).length, 1);
  assert.equal(notifiable([{ from: 'builder-2', body: 'over to you', ts: 5, to: ['validator'] }], toMe).length, 0);
  assert.equal(notifiable([{ from: 'builder-2', body: 'to the room', ts: 5 }], toMe).length, 0);
});

test('notifiable: the first page is history, never news', () => {
  assert.equal(notifiable([{ from: 'builder-2', body: 'hello', ts: 5 }], { first: true, away: true }).length, 0);
});

test('notifiable: a reader looking at the room is never interrupted', () => {
  assert.equal(notifiable([{ from: 'builder-2', body: 'hello', ts: 5 }], { first: false, away: false }).length, 0);
});

test('notifiable: your own words and nameless rows are not news', () => {
  assert.equal(notifiable([{ from: 'human', body: 'hi' }, { body: 'orphan' }, { from: '', body: 'x' }], away).length, 0);
});

test('notifiable: app narration ([tmm] sys lines) is not news', () => {
  assert.equal(notifiable([{ from: 'builder-2', body: '[tmm] spawned dev — brief' }], away).length, 0);
  assert.equal(notifiable([{ from: 'builder-2', body: '[tmm] board #7 todo → doing — Fix parser' }], away).length, 0, 'starting a task is not finishing it');
});

test('notifiable: an agent moving an issue to review/done IS news — "谁完成了什么任务" (board #72)', () => {
  const out = notifiable([
    { from: 'builder-2', body: '[tmm] board #7 doing → review — Fix parser' },
    { from: 'lead', body: '[tmm] board #7 review → done — Fix parser' },
    { from: 'human', body: '[tmm] board #8 doing → done — Mine' },
  ], away);
  assert.equal(out.length, 2, 'the human moving their own issue is not news');
  assert.deepEqual(taskFinished('[tmm] board #7 doing → review — Fix parser'), { id: '7', to: 'review', title: 'Fix parser' });
  assert.equal(taskFinished('[tmm] board #7 todo → doing — Fix parser'), null);
  assert.equal(taskFinished('board #7 doing → review'), null, 'only a lifecycle line, never a message that quotes one');
  assert.equal(excerpt('[tmm] board #7 doing → review — Fix parser'), '#7 → review · Fix parser');
});

test('notifiable: ambient [tmm status] progress is not news, [tmm done] is', () => {
  const out = notifiable([
    { from: 'builder-2', body: '[tmm status working] refactoring the parser' },
    { from: 'builder-2', body: '[tmm done] parser refactored, 12 tests green' },
  ], away);
  assert.equal(out.length, 1);
  assert.match(out[0]?.body ?? '', /\[tmm done\]/u);
});

test('notifiable: the LEVEL is three nested rungs over the bell — Finished ⊂ To me ⊂ To me + progress (#72, #334)', () => {
  const me = ['human'];
  const batch: FeedMsg[] = [
    { from: 'b', body: 'a reply to you', to: me },
    { from: 'b', body: 'a reply to an agent', to: ['dev'] },
    { from: 'b', body: '[tmm done] shipped it' },
    { from: 'b', body: '[tmm] board #3 doing → review — Task' },
    { from: 'b', body: '[tmm status working] still at it', to: me },
    { from: 'b', body: '[tmm status working] unaddressed' },
    { from: 'b', body: '[tmm] spawned dev — brief' },
  ];
  const bodies = (level: 'done' | 'replies' | 'all') => notifiable(batch, { ...away, level }).map((m) => m.body);
  assert.deepEqual(bodies('done'), ['[tmm done] shipped it', '[tmm] board #3 doing → review — Task']);
  assert.deepEqual(bodies('replies'), ['a reply to you', '[tmm done] shipped it', '[tmm] board #3 doing → review — Task']);
  assert.deepEqual(bodies('all'), ['a reply to you', '[tmm done] shipped it', '[tmm] board #3 doing → review — Task', '[tmm status working] still at it']);
  assert.equal(DEFAULT_LEVEL, 'done', 'Finished is the default (#333)');
  assert.deepEqual(notifiable(batch, away), notifiable(batch, { ...away, level: DEFAULT_LEVEL }), 'no level = the default');
  assert.deepEqual([...NOTIFY_LEVELS], ['done', 'replies', 'all'], 'the Settings row offers them in rising order');
});

// ─── Layer 1: seen keys — replays and backfill ──────────────────────────────

test('msgKey: id wins, else the from/ts/body triple', () => {
  assert.equal(msgKey({ id: 7, from: 'a', ts: 1, body: 'x' }), '#7');
  assert.equal(msgKey({ from: 'a', ts: 1, body: 'x' }), 'a\u00001\u0000x');
  assert.notEqual(msgKey({ from: 'a', ts: 1, body: 'x' }), msgKey({ from: 'a', ts: 1, body: 'y' }));
});

test('sift: splits never-seen, remembers everything, stays bounded', () => {
  const seen = new Set<string>();
  const batch: FeedMsg[] = [{ from: 'a', ts: 1, body: 'x' }, { from: 'b', ts: 2, body: 'y' }];
  assert.equal(sift(batch, seen).length, 2);
  assert.equal(sift(batch, seen).length, 0); // the replay
  const cap = 10;
  for (let i = 0; i < 30; i++) sift([{ from: 'c', ts: i, body: 'z' }], seen, cap);
  assert.ok(seen.size <= cap);
});

test('notifyNews: the same batch replayed alerts exactly once', () => {
  const st = fresh();
  const { fired, effects } = harness();
  const batch: FeedMsg[] = [{ from: 'builder-2', ts: 100, body: '[tmm done] reply' }];
  assert.equal(notifyNews(batch, { ...away, project: 'p' }, st, effects), true);
  assert.equal(notifyNews(batch, { ...away, project: 'p' }, st, effects), false); // inclusive since_ts re-pull
  assert.equal(fired.cue, 1);
  assert.equal(fired.sys.length, 1);
});

test('notifyNews: a first page (initial load / project switch / cache restore) never backfills', () => {
  const st = fresh();
  const { fired, effects } = harness();
  const history: FeedMsg[] = [{ from: 'builder-2', ts: 1, body: 'old reply' }];
  assert.equal(notifyNews(history, { first: true, away: true, project: 'p' }, st, effects), false);
  // the same rows come back on the next incremental poll — still not news
  assert.equal(notifyNews(history, { ...away, project: 'p' }, st, effects), false);
  assert.equal(fired.cue, 0);
});

test('notifyNews: messages watched while looking never re-alert after tabbing away', () => {
  const st = fresh();
  const { fired, effects } = harness();
  const batch: FeedMsg[] = [{ from: 'builder-2', ts: 5, body: 'seen live' }];
  assert.equal(notifyNews(batch, { first: false, away: false, project: 'p' }, st, effects), false);
  assert.equal(notifyNews(batch, { ...away, project: 'p' }, st, effects), false); // same-ts re-pull, now away
  assert.equal(fired.cue, 0);
});

test('notifyNews: a muted period is remembered, not deferred', () => {
  const st = fresh();
  const muted = harness(false);
  const batch: FeedMsg[] = [{ from: 'builder-2', ts: 9, body: 'while muted' }];
  assert.equal(notifyNews(batch, { ...away, project: 'p' }, st, muted.effects), false);
  const unmuted = harness(true);
  assert.equal(notifyNews(batch, { ...away, project: 'p' }, st, unmuted.effects), false); // no backfill on unmute
  assert.equal(unmuted.fired.cue, 0);
});

// ─── The cue: cooldown + failure semantics ──────────────────────────────────

test('cueDue: one cue per cooldown window', () => {
  assert.equal(cueDue(0, CUE_COOLDOWN_MS), true);
  assert.equal(cueDue(1000, 1000 + CUE_COOLDOWN_MS - 1), false);
  assert.equal(cueDue(1000, 1000 + CUE_COOLDOWN_MS), true);
});

test('playCue: a resolved play consumes the window; a second same-tick call does not double-fire', async () => {
  const st = fresh();
  let plays = 0;
  const play = () => { plays++; return Promise.resolve(); };
  assert.equal(playCue(1000, st, play), true);
  assert.equal(playCue(1000, st, play), false); // claimed up front
  await Promise.resolve();
  assert.equal(st.lastCueAt, 1000);
  assert.equal(plays, 1);
});

test('playCue: a REJECTED play rolls the window back — autoplay block must not swallow the first real cue', async () => {
  const st = fresh();
  const play = () => Promise.reject(new Error('autoplay blocked'));
  assert.equal(playCue(1000, st, play), true);
  await Promise.resolve(); await Promise.resolve(); // let the rejection land
  assert.equal(st.lastCueAt, 0, 'the failed attempt consumed nothing');
  let ok = 0;
  assert.equal(playCue(1500, st, () => { ok++; return Promise.resolve(); }), true, 'the next cue plays immediately');
  assert.equal(ok, 1);
});

test('playCue: a DEFERRED old rejection cannot reopen the window a newer cue claimed', async () => {
  const st = fresh();
  let rejectA: (e: Error) => void = () => {};
  const playA = () => new Promise<void>((_res, rej) => { rejectA = rej; });
  assert.equal(playCue(1000, st, playA), true);           // A claims, hangs
  const tB = 1000 + CUE_COOLDOWN_MS;
  assert.equal(playCue(tB, st, () => Promise.resolve()), true); // B claims later, succeeds
  rejectA(new Error('late autoplay block'));              // A's rejection lands AFTER B
  await Promise.resolve(); await Promise.resolve();
  assert.equal(st.lastCueAt, tB, "A's late catch must not roll back B's claim");
  assert.equal(playCue(tB + 1, st, () => Promise.resolve()), false, 'the cooldown B claimed still holds');
});

// ─── Text ───────────────────────────────────────────────────────────────────

test('notifyText: names only, deduped, last body excerpted', () => {
  const { title, body } = notifyText(
    [{ from: 'a', body: 'first' }, { from: 'b', body: 'second' }, { from: 'a', body: 'third' }],
    'proj',
  );
  assert.equal(title, 'a, b · proj');
  assert.equal(body, 'third');
  assert.equal(notifyText([{ from: 'a', body: 'x' }], 'proj').tag, 'tmm:proj', 'one tray card per project, replaced not stacked');
});

test('notifyText (#335 ③c-4): the tag is the room ON ITS SERVER, so two servers `app` are two cards; the title names the server only when told to', () => {
  const a = notifyText([{ from: 'dev', body: 'x' }], 'app', { server: 'srv-a', room: 'proj:app' });
  const b = notifyText([{ from: 'dev', body: 'x' }], 'app', { server: 'srv-b', room: 'proj:app' });
  assert.notEqual(a.tag, b.tag, 'a same-named room on another server is another card');
  assert.equal(a.tag, 'tmm:srv-a|proj:app');
  assert.equal(a.title, 'dev · app', 'Single, or one included server: no server in the title');
  assert.equal(notifyText([{ from: 'dev', body: 'x' }], 'app', { server: 'srv-a', room: 'proj:app', serverName: 'alpha' }).title, 'dev · alpha · app', 'Aggregate with several included: the server is named');
});

// ─── Where the check runs (board #72) ───────────────────────────────────────

test('isAway: hidden, unfocused, or another page on screen', () => {
  const doc = (hidden: boolean, focus: boolean) => ({ hidden, hasFocus: () => focus });
  assert.equal(isAway(true, doc(false, true)), false, 'looking at the Hub');
  assert.equal(isAway(false, doc(false, true)), true, 'Terminal/Files/Board on screen');
  assert.equal(isAway(true, doc(true, true)), true, 'tab hidden');
  assert.equal(isAway(true, doc(false, false)), true, 'window unfocused');
});

test('roomProjectName: the recorded room wins, then proj:<session>, then the room itself', () => {
  const rows = [
    { project: { name: 'Renamed', session: 'new-name', room: 'proj:old-name' } },
    { project: { name: 'Plain', session: 'plain', room: null } },
  ];
  assert.equal(roomProjectName(rows, 'proj:old-name'), 'Renamed', 'a renamed project keeps its recorded room');
  assert.equal(roomProjectName(rows, 'proj:plain'), 'Plain');
  assert.equal(roomProjectName(rows, 'proj:unknown'), 'unknown', 'never an empty title');
});

// ─── The system channel on a phone (board #72) ──────────────────────────────

function swEnv(permission: string | null, reg: boolean, constructThrows = false) {
  const log: string[] = [];
  const env: NotifyEnv = {
    permission,
    construct: (title) => { if (constructThrows) throw new TypeError('Illegal constructor'); log.push(`new:${title}`); },
    registration: async () => (reg ? { showNotification: async (title) => { log.push(`sw:${title}`); } } : undefined),
  };
  return { env, log };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('systemNotify: with a service worker the WORKER shows it — Android Chrome refuses the page constructor', async () => {
  const { env, log } = swEnv('granted', true, true);
  assert.equal(systemNotify({ title: 't', body: 'b', tag: 'tmm:p' }, env), true);
  await settle();
  assert.deepEqual(log, ['sw:t'], 'the constructor was never tried');
});

test('systemNotify: without a registration the page constructor is the fallback', async () => {
  const { env, log } = swEnv('granted', false);
  assert.equal(systemNotify({ title: 't', body: 'b' }, env), true);
  await settle();
  assert.deepEqual(log, ['new:t']);
});

test('systemNotify: not granted (or no API) attempts nothing — prompting is the Settings toggle\'s job', async () => {
  for (const p of ['default', 'denied', null]) {
    const { env, log } = swEnv(p, true);
    assert.equal(systemNotify({ title: 't', body: 'b' }, env), false);
    await settle();
    assert.deepEqual(log, []);
  }
});

test('excerpt: status marker gives way to its text, images to prose, 120-char cap', () => {
  assert.equal(excerpt('[tmm done] shipped the thing'), 'shipped the thing');
  assert.equal(excerpt('look ![](/tmp/shot.png) here'), 'look here');
  const cut = excerpt('x'.repeat(300));
  assert.equal(cut.length, 120);
  assert.ok(cut.endsWith('…'));
});

// ─── Source pins: the wiring that regresses silently ────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const hub = readFileSync(join(here, 'Hub.svelte'), 'utf8');

test('Hub notifies from the PUSH first and the poll second, both through isAway (board #72)', () => {
  // The poll stops with the page (`if (!visible) return` guards its effect),
  // so a poll-only notifier could never reach a reader on another page. The
  // push handler is the primary site; the poll is the fallback; sift dedups.
  const calls = hub.match(/notifyNews\(/gu) ?? [];
  assert.equal(calls.length, 2);
  assert.match(hub, /notifyNews\(messages, newsCtx\(room\(s\), s, first\), undefined, newsEffects\)/u, 'the poll site');
  const push = hub.slice(hub.indexOf('const onPush = (m) => {'), hub.indexOf('if (!selected || m?.room !== room(selected)) return;'));
  assert.match(push, /notifyNews\(\[m\], newsCtx\(m\.room, session, false\), undefined, newsEffects\)/u, 'a push is never history');
  // ONE context builder (#322): another room is away by definition, the
  // selected one asks the document; the title names the project.
  const ctx = hub.slice(hub.indexOf('function newsCtx('), hub.indexOf('const newsEffects'));
  assert.match(ctx, /const away = !here \|\| isAway\(visible\);/u);
  assert.match(ctx, /project: roomProjectName\(rows, roomName\)/u);
  assert.match(ctx, /server: serverId\(\), room: roomName, session,/u, 'records and dedupe keys carry the server');
  assert.ok(!/document\.hidden \|\| !document\.hasFocus\(\)/u.test(hub), 'ONE away verdict — the helper, never an inline copy');
});

const prefs = readFileSync(join(here, '..', 'app', 'Preferences.svelte'), 'utf8');

test('the permission request and the audio unlock ride the ONE mute switch, never the header or the send path (board #72, #423)', () => {
  const sendBody = hub.slice(hub.indexOf('async function send()'), hub.indexOf('async function send()') + 4000);
  assert.ok(!sendBody.includes('ensurePermission'), 'send() asks for nothing');
  assert.ok(!hub.includes('ensurePermission') && !hub.includes('setNotifyEnabled') && !hub.includes('notifySwitch.set'),
    'the Hub header carries no notification switch — a header keeps no spare switches, and on a phone it cost the row a button');
  // Board #322: the phone's bell there OPENS the centre (a record), it is not
  // a switch; since #423 it only SHOWS the switch (bell-off while muted).
  assert.match(hub, /icon=\{notifySwitch\.on \? 'bell' : 'bell-off'\} label=[^\n]*hasPopup="dialog" expanded=\{!!centre\.anchor\}\s*onclick=\{\(e\) => centre\.toggle\(e\.currentTarget\)\}/u);
  // ONE door writes the switch (board #423): Settings' toggle and the
  // centre's Mute both call it, and only turning it ON asks and unlocks.
  // #156 keeps this ordering inside a serialized pending/error operation.
  const door = readFileSync(join(here, 'notify-switch.svelte.ts'), 'utf8');
  // The gate and the face agree: `on` moves only after the key really did
  // (review P1), and only turning ON asks and unlocks.
  assert.match(door, /if \(!setNotifyEnabled\(next\)\) return false;\s*on = notifyEnabled\(\);\s*if \(!next\) return true;\s*previewCue\(\);\s*await ensurePermission\(\);\s*permission = notifyPermission\(\);/u);
  const toggle = prefs.slice(prefs.indexOf('async function setNotify('), prefs.indexOf('async function testNotify('));
  assert.match(toggle, /await notifySwitch\.set\(on\)/u, 'Settings goes through the door');
  assert.ok(!/setNotifyEnabled/u.test(prefs), 'and never writes the key itself');
  const centreSrc = readFileSync(join(here, 'NotifyCentre.svelte'), 'utf8');
  assert.match(centreSrc, /await notifySwitch\.set\(!notifySwitch\.on\)/u, 'the centre s Mute goes through the same door');
  const asks = prefs.match(/await ensurePermission\(\)/gu) ?? [];
  assert.equal(asks.length, 1, 'Settings asks on its own only in the test row; the toggle asks through the door');
  assert.match(prefs, /\{t\('hubNotify'\)\}/u, 'a labelled setting-row');
  // Its OWN category (owner, 2026-09-02: "应该在一个单独的 notification 二级页面"),
  // right after Appearance, never a row under it.
  assert.match(prefs, /\{ id: 'appearance', label: \(\) => t\('settingsAppearance'\) \},\s*\n\s*\{ id: 'chat', label: \(\) => t\('settingsChat'\) \},\s*\n\s*\{ id: 'notifications', label: \(\) => t\('settingsNotifications'\) \},/u,
    'Notifications stays its own category (owner, 2026-09-02), after the Chat category that took the feed rows (2026-09-25)');
  const appearance = prefs.slice(prefs.indexOf("{#if tab === 'appearance'}"), prefs.indexOf("{:else if tab === 'notifications'}"));
  assert.ok(appearance.length > 0 && !appearance.includes('hubNotify'), 'no notification row under Appearance');
  assert.match(prefs, /storedTab === 'notifications'/u, 'the category is restorable');
  assert.match(prefs, /systemNotify\(\{ title: t\('hubNotifyTestTitle'\)/u, 'a test row — the real alert only fires while you are NOT looking');
  assert.match(prefs, /options=\{NOTIFY_LEVELS\.map\(\(l\) => \(\{ value: l, label: t\('hubNotifyLevel_' \+ l\) \}\)\)\}/u,
    'the level row (a ui/Segmented) is driven by the ONE list, in its order');
  assert.match(prefs, /setNotifyLevel\(l\)/u);
  // Asking whenever not yet granted is what reaches Android's runtime prompt:
  // the Tauri shim reports `denied` before the first ask.
  const notif = readFileSync(join(here, 'notifications.ts'), 'utf8');
  assert.match(notif, /Notification\.permission !== 'granted'\) \{\s*\n\s*await Notification\.requestPermission\(\)/u);
  assert.match(prefs, /\{:else if notifyPerm === 'unsupported'\}<small class="config-note">\{t\('hubNotifySoundOnly'\)\}<\/small>/u,
    'an unsupported webview explicitly says sound is the whole channel');
});

test('the placeholder cue asset exists where CUE_SRC points', () => {
  const wav = readFileSync(join(here, '..', '..', '..', 'public', CUE_SRC));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.ok(wav.length > 1000 && wav.length < 200_000, 'a short cue, not a soundtrack');
  assert.ok(SEEN_CAP >= 100, 'the seen memory holds a real conversation');
});

test('newsKind is the server\'s one rule: rooms.rs news_kind_is_one_rule, read here (#322)', () => {
  const rust = readFileSync(new URL('../../../src-tauri/src/projects/rooms.rs', import.meta.url), 'utf8');
  const table = rust.slice(rust.indexOf('fn news_kind_is_one_rule'), rust.indexOf('fn unread_counts_news_above'));
  const rows = [...table.matchAll(/^\s*\(("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), "([a-z]+)"\),$/gmu)];
  assert.ok(rows.length >= 16, `the shared table was found: ${rows.length} rows`);
  // Rust's \u{XXXX} escape is JSON's \uXXXX.
  const str = (lit: string) => JSON.parse(lit.replace(/\\u\{([0-9a-f]{4})\}/giu, '\\u$1')) as string;
  for (const [, from, body, kind] of rows) {
    assert.equal(newsKind({ from: str(from!), body: str(body!) }), kind, `${from}: ${body}`);
  }
});

test('the server\'s unconfirmed report is an alert: unread, a bell entry, rings at every level, and only its own shape (#437)', () => {
  const report = { from: 'tmm', body: "[tmm] unconfirmed engineer — no confirmation was seen for engineer's message of 08:40; it may be waiting in its composer, or the confirmation is late. Look at its pane first; do not resend or press Enter because of this line alone." };
  assert.equal(newsKind(report), 'alert', 'room unread counts it');
  assert.equal(bellKind(report), 'alert', 'a bell entry with no recipient: the person is who it is for');
  for (const level of NOTIFY_LEVELS) assert.deepEqual(notifiable([report], { ...away, level }).map((m) => m.body), [report.body], `rings at ${level}`);
  assert.deepEqual(notifiable([report], { first: false, away: false }), [], 'not while the reader is looking');
  assert.deepEqual(notifiable([report], { first: true, away: true }), [], 'a first page is history, never news');
  // Only the server's own report: an agent quoting it, or another shape, is not.
  assert.equal(newsKind({ from: 'lead', body: report.body }), 'none');
  assert.equal(newsKind({ from: 'tmm', body: '[tmm] unconfirmed dev, I think' }), 'none');
  assert.equal(newsKind({ from: 'lead', body: 'unconfirmed dev — no confirmation was seen for x' }), 'reply');
});

test('levels ring what they rang before #322: a legacy [tmm done] rings at done, replies and all', () => {
  const msgs = [
    { from: 'lead', body: '[tmm done] shipped' },
    { from: 'lead', body: '[tmm] board #2 doing → review — x' },
    { from: 'lead', body: 'a reply', to: ['human'] },
    { from: 'lead', body: '[tmm status running] busy', to: ['human'] },
    { from: 'lead', body: '[tmm] spawned dev' },
    { from: 'human', body: 'me' },
  ];
  const bodies = (level: NotifyLevel) => notifiable(msgs, { ...away, level }).map((m) => m.body);
  assert.deepEqual(bodies('done'), [msgs[0]!.body, msgs[1]!.body]);
  assert.deepEqual(bodies('replies'), [msgs[0]!.body, msgs[1]!.body, msgs[2]!.body]);
  assert.deepEqual(bodies('all'), [msgs[0]!.body, msgs[1]!.body, msgs[2]!.body, msgs[3]!.body]);
});

test('notifyNews records before it rings: muted, level-filtered and watched news is still recorded once (#322)', () => {
  const recorded: { body?: string; kind: string; viewed?: boolean }[] = [];
  const record = (m: FeedMsg, c: { kind: string; viewed?: boolean }) => { recorded.push({ body: m.body, kind: c.kind, viewed: c.viewed }); };
  const st = fresh();
  const muted = { ...harness(false).effects, level: () => 'done' as const, record };
  const ctx = { first: false, away: true, project: 'p', server: 's1', room: 'proj:p', viewed: false };
  const batch: FeedMsg[] = [
    { id: 1, from: 'dev', body: 'a reply', to: ['human'] },
    { id: 2, from: 'dev', body: '[tmm status running] busy', to: ['human'] },
    { id: 3, from: 'dev', body: '[tmm] spawned x' },
    { id: 4, from: 'human', body: 'mine' },
  ];
  assert.equal(notifyNews(batch, ctx, st, muted), false, 'muted: no cue');
  assert.deepEqual(recorded.map((r) => r.kind), ['reply', 'status'], 'bell news of every kind is recorded, not own words or narration');
  notifyNews(batch, ctx, st, muted);
  assert.equal(recorded.length, 2, 'a replay is not recorded twice (one sift)');
  // Another server's message with the same id is its own message.
  notifyNews([batch[0]!], { ...ctx, server: 's2' }, st, muted);
  assert.equal(recorded.length, 3, 'dedupe keys carry the server');
  // A first page is remembered, never recorded.
  notifyNews([{ id: 9, from: 'dev', body: 'old' }], { ...ctx, first: true }, st, muted);
  assert.equal(recorded.length, 3);
  // The caller's at-tail verdict rides into the record.
  notifyNews([{ id: 10, from: 'dev', body: 'seen live', to: ['human'] }], { ...ctx, away: false, viewed: true }, st, { ...harness().effects, record });
  assert.equal(recorded.at(-1)!.viewed, true);
});

test('the bell holds finished tasks and what is addressed to you; agent↔agent talk is room unread only (#334)', () => {
  const recorded: string[] = [];
  const effects = { ...harness().effects, level: () => 'all' as const, record: (m: FeedMsg) => { recorded.push(String(m.id)); } };
  const ctx = { first: false, away: true, project: 'p', server: 's1', room: 'proj:p' };
  const batch: FeedMsg[] = [
    { id: 'plain', from: 'dev', body: 'handing this to qa', to: ['qa'] },
    { id: 'room', from: 'dev', body: 'thinking out loud' },
    { id: 'note', from: 'dev', body: '[tmm status working] busy' },
    { id: 'done', from: 'dev', body: '[tmm done] parser shipped', to: ['lead'] },
    { id: 'me', from: 'dev', body: 'your call', to: ['qa', 'human'] },
  ];
  assert.equal(notifyNews(batch, ctx, fresh(), effects), true);
  assert.deepEqual(recorded, ['done', 'me'], 'recorded = what may ring');
  assert.deepEqual(batch.map((m) => bellKind(m)), ['none', 'none', 'none', 'finished', 'reply']);
  assert.deepEqual(batch.map((m) => newsKind(m)), ['reply', 'reply', 'status', 'finished', 'reply'], 'all still room unread (the sidebar count, the roster dot)');
  // Nothing addressed to you and nothing finished: no record, no cue.
  const quiet = harness();
  assert.equal(notifyNews([{ id: 'x', from: 'dev', body: 'agent chat', to: ['qa'] }], ctx, fresh(), { ...quiet.effects, record: () => assert.fail('not a bell entry') }), false);
  assert.equal(quiet.fired.cue, 0);
});

test('the bell is per MESSAGE, not per turn: a review move then a reply to you are two entries; the next turn is its own (#334)', () => {
  const recorded: string[] = [];
  const effects = { ...harness().effects, record: (m: FeedMsg) => { recorded.push(String(m.id)); } };
  const ctx = { first: false, away: true, project: 'p', server: 's1', room: 'proj:p' };
  const st = fresh();
  notifyNews([
    { id: 't1-move', from: 'dev', body: '[tmm] board #4 doing → review — Parser' },
    { id: 't1-final', from: 'dev', body: 'parser is in review', to: ['human'] },
  ], ctx, st, effects);
  assert.deepEqual(recorded, ['t1-move', 't1-final'], 'no turn identity on a message: no merge');
  notifyNews([{ id: 't2-final', from: 'dev', body: 'and the docs too', to: ['human'] }], ctx, st, effects);
  assert.deepEqual(recorded, ['t1-move', 't1-final', 't2-final'], 'the next turn is not suppressed');
});

test('the default level is Finished only when nothing is stored; every stored choice survives (#333)', () => {
  const store = new Map<string, string>();
  const prev = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  try {
    assert.equal(notifyLevel(), 'done', 'a fresh install');
    for (const level of NOTIFY_LEVELS) {
      setNotifyLevel(level);
      assert.equal(notifyLevel(), level, `a stored ${level} is kept`);
    }
    store.set('tmux_notify_level', 'loud');
    assert.equal(notifyLevel(), 'done', 'an unknown value reads as the default');
  } finally { (globalThis as any).localStorage = prev; }
});
