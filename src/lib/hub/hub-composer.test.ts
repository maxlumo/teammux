import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_TARGET, attachmentBody, attachToken, busyTargetsFor, canAddress, lockedSend, paletteBackendFor, signatureLayout, targetMembers, targetTeam, teamRoot, teamTarget } from './hub-composer.ts';
import { addressed, commandPalette } from './hub.ts';

const roster = [
  { name: 'alice', managed: true, agent: 'kiro' },
  { name: 'bob', managed: true, agent: 'codex' },
  { name: 'shell', managed: false, agent: 'grok' },
];

test('team targets resolve to exactly their current managed members (#239)', () => {
  const agents = [
    { name: 'lead', team: 'dev', managed: true, state: 'idle' },
    { name: 'reviewer', team: 'dev/review', managed: true, state: 'running' },
    { name: 'solo', managed: true, state: 'running' },
    { name: 'direct', team: 'dev', managed: false, state: 'running' },
  ];
  assert.equal(teamRoot('dev/review'), 'dev');
  assert.equal(teamRoot(null), null);
  assert.equal(targetTeam(teamTarget('dev')), 'dev');
  assert.equal(targetTeam('dev'), null);
  assert.notEqual(teamTarget('dev'), 'dev', 'the colon is forbidden in real agent names');
  assert.deepEqual(targetMembers(teamTarget('dev'), agents), ['lead', 'reviewer']);
  assert.deepEqual(targetMembers(ALL_TARGET, agents), ['lead', 'reviewer', 'solo']);
  assert.deepEqual(targetMembers('reviewer', agents), ['reviewer']);
  assert.deepEqual(targetMembers(teamTarget('missing'), agents), []);
  assert.deepEqual(busyTargetsFor(teamTarget('dev'), agents), ['reviewer']);
  assert.deepEqual(busyTargetsFor(ALL_TARGET, agents), ['reviewer', 'solo']);
  assert.deepEqual(busyTargetsFor(teamTarget('dev'), agents.slice(0, 1)), [], 'idle members are not interrupted');
});

test('team command palette uses its member dialect, not the whole room (#239)', () => {
  const agents = [
    { name: 'a', team: 'dev', managed: true, agent: 'kiro' },
    { name: 'b', team: 'dev/review', managed: true, agent: 'kiro' },
    { name: 'solo', managed: true, agent: 'codex' },
  ];
  assert.equal(paletteBackendFor('/', teamTarget('dev'), agents), 'kiro');
  assert.equal(paletteBackendFor('@solo /clear', teamTarget('dev'), agents), 'codex', 'explicit @name wins');
});

test('signature controls share clear text space, not a permanent right column (#186)', () => {
  const box = {
    width: 320, naturalHeight: 104, maxHeight: 240, controlsWidth: 136, controlsHeight: 44, gap: 2,
    textRects: [{ left: 0, right: 300, top: 5, bottom: 21 }, { left: 0, right: 100, top: 75, bottom: 91 }],
  };
  assert.deepEqual(signatureLayout(box), { inputHeight: 104, reserved: 0, overflow: false, collision: false });
  assert.deepEqual(signatureLayout({ ...box, empty: true }),
    { inputHeight: 44, reserved: 0, overflow: false, collision: false });
  assert.equal(signatureLayout({ ...box, textRects: [{ left: 0, right: 182, top: 75, bottom: 91 }] }).reserved, 0);
  assert.equal(signatureLayout({ ...box, textRects: [{ left: 0, right: 182.1, top: 75, bottom: 91 }] }).reserved, 44);
});

test('lifted controls move their box and their band up with them (board #229)', () => {
  // The phone group is 32px centred in a 44px line → bottom: 6px. A second
  // line ending under the controls' PAINT collides; one ending 6px lower than
  // the controls' box (in the lift) does not; the reserved band grows by the
  // lift so the controls clear the text.
  const phone = { width: 320, naturalHeight: 88, maxHeight: 240, controlsWidth: 66, controlsHeight: 32, gap: 2, paintInset: 2, lift: 6 };
  const under = signatureLayout({ ...phone, textRects: [{ left: 0, right: 300, top: 0, bottom: 44 }, { left: 0, right: 300, top: 44, bottom: 88 }] });
  assert.deepEqual(under, { inputHeight: 88, reserved: 38, overflow: false, collision: true });
  const clear = signatureLayout({ ...phone, textRects: [{ left: 0, right: 300, top: 0, bottom: 44 }, { left: 0, right: 240, top: 44, bottom: 88 }] });
  assert.equal(clear.collision, false);
  // A rect that ends inside the lift band (below the controls) does not collide.
  const belowBox = signatureLayout({ ...phone, textRects: [{ left: 0, right: 300, top: 84, bottom: 88 }] });
  assert.equal(belowBox.collision, false);
  // Unlifted (desktop) is exactly the old math.
  const desk = signatureLayout({ ...phone, lift: 0, textRects: [{ left: 0, right: 300, top: 84, bottom: 88 }] });
  assert.equal(desk.collision, true);
});

test('a tall touch target checks the previous line too (#186)', () => {
  assert.deepEqual(signatureLayout({
    width: 320, naturalHeight: 84, maxHeight: 240, controlsWidth: 136, controlsHeight: 44, gap: 2,
    textRects: [{ left: 0, right: 310, top: 32, bottom: 50 }, { left: 0, right: 40, top: 52, bottom: 70 }],
  }), { inputHeight: 84, reserved: 44, overflow: false, collision: true });
});

test('ink collides with paint: a pointer command beside a two-line draft shares the last line (board #203)', () => {
  // Owner 2026-09-17: "到了第二行 这 3 个按钮好像就被撑到下一行了 中间多出了空白的一行".
  // Desktop: 28px commands (paint inset 2) beside 20.25px lines (ink inset
  // 3.375): the first line's RECT dips 2px into the hit box, its ink does not.
  const desktop = {
    width: 1156, naturalHeight: 48, maxHeight: 240, controlsWidth: 88, controlsHeight: 28, gap: 2,
    paintInset: 2, inkInset: 3.375,
    textRects: [{ left: 0, right: 1140, top: 3.875, bottom: 24.125 }, { left: 0, right: 40, top: 24.125, bottom: 44.375 }],
  };
  assert.deepEqual(signatureLayout(desktop), { inputHeight: 48, reserved: 0, overflow: false, collision: false });
  assert.equal(signatureLayout({ ...desktop, paintInset: 0, inkInset: 0 }).reserved, 28, 'negative control: hit box vs rect reserved the empty band');
  // A last line that runs under the commands still reserves the band.
  assert.equal(signatureLayout({ ...desktop, textRects: [desktop.textRects[0]!, { left: 0, right: 1101, top: 24.125, bottom: 44.375 }] }).reserved, 28);
  // Touch: a 44px command's paint (inset 6) does reach the previous line's ink.
  assert.equal(signatureLayout({
    width: 320, naturalHeight: 64.25, maxHeight: 240, controlsWidth: 136, controlsHeight: 44, gap: 2, paintInset: 6, inkInset: 3.375,
    textRects: [{ left: 0, right: 310, top: 11.875, bottom: 32.125 }, { left: 0, right: 40, top: 32.125, bottom: 52.375 }],
  }).reserved, 44, 'the phone keeps its band (#186)');
});

test('scroll-capped drafts keep full width and a separate bottom action band (#186)', () => {
  const layout = signatureLayout({
    width: 320, naturalHeight: 600, maxHeight: 240, controlsWidth: 136, controlsHeight: 44, gap: 2,
    textRects: [],
  });
  assert.deepEqual(layout, { inputHeight: 196, reserved: 44, overflow: true, collision: false });
});

// #168: card Stop and double Ctrl+C share exactly this target boundary.
test('interrupt targets include only busy managed members of the selected card', () => {
  const agents = [
    ...['running', 'working', 'waiting', 'blocked', 'idle', 'done', 'unknown']
      .map((state) => ({ name: state, state, managed: true })),
    { name: 'shell', state: 'running', managed: false },
    { name: 'missing-state', managed: true },
  ];
  assert.deepEqual(busyTargetsFor(ALL_TARGET, agents), ['running', 'working', 'waiting', 'blocked']);
  for (const name of ['running', 'working', 'waiting', 'blocked']) {
    assert.deepEqual(busyTargetsFor(name, agents), [name]);
  }
  for (const name of ['', 'idle', 'done', 'unknown', 'shell', 'missing-state', 'absent']) {
    assert.deepEqual(busyTargetsFor(name, agents), [], name);
  }
  assert.deepEqual(busyTargetsFor(ALL_TARGET, []), []);
});

test('interrupt targets are a deduplicated activation snapshot, not live roster objects', () => {
  const agents = [
    { name: 'alice', state: 'running', managed: true },
    { name: 'alice', state: 'working', managed: true },
    { name: 'bob', state: 'idle', managed: true },
  ];
  const captured = busyTargetsFor(ALL_TARGET, agents);
  assert.deepEqual(captured, ['alice']);
  agents[0]!.name = 'renamed';
  agents[2]!.state = 'waiting';
  assert.deepEqual(captured, ['alice']);
  assert.deepEqual(busyTargetsFor(ALL_TARGET, agents), ['renamed', 'alice', 'bob']);
});

test('palette uses a leading addressee before the recipient chip', () => {
  assert.equal(paletteBackendFor(' @bob /', 'alice', roster), 'codex');
  assert.equal(paletteBackendFor('note @bob /', 'alice', roster), 'kiro');
  assert.equal(paletteBackendFor('@bob', 'alice', roster), 'kiro',
    'the existing prefix grammar requires whitespace after the name');
  assert.equal(paletteBackendFor('@bob\n/', 'alice', roster), 'codex');
});

test('direct or unknown targets never fall back to the chip or another agent', () => {
  assert.equal(paletteBackendFor('@shell /', 'alice', roster), '');
  assert.equal(paletteBackendFor('@missing /', 'alice', roster), '');
  assert.equal(paletteBackendFor('/', 'shell', roster), '');
  assert.equal(paletteBackendFor('/', 'missing', roster), '');
});

test('all and room choices offer a palette only for one managed dialect', () => {
  const homogeneous = [
    roster[0]!,
    { name: 'reviewer', managed: true, agent: 'kiro' },
    roster[2]!,
  ];
  for (const recipient of [ALL_TARGET, '']) {
    assert.equal(paletteBackendFor('/', recipient, homogeneous), 'kiro',
      'a direct window does not make a managed roster mixed');
    assert.equal(paletteBackendFor('/', recipient, roster), 'mixed');
    assert.equal(commandPalette('/', [], paletteBackendFor('/', recipient, roster)), null);
    assert.equal(paletteBackendFor('/', recipient, []), 'mixed');
  }
});

test('an explicit all prefix retains its existing named-target lookup', () => {
  // Do not turn the prefix parser into mentionTokens during a mechanical move.
  assert.equal(paletteBackendFor('@all /', 'alice', roster), '');
});

test('missing backend values stay empty, not a guessed dialect', () => {
  const unknown = [{ name: 'unknown', managed: true }];
  assert.equal(paletteBackendFor(null, 'unknown', unknown), '');
  assert.equal(paletteBackendFor(undefined, '', unknown), '');
  assert.equal(paletteBackendFor('/', '', [...unknown, roster[0]!]), 'mixed');
});

const image = { kind: 'image' as const, n: 1, path: '/work/shot.webp' };
const file = { kind: 'file' as const, n: 2, path: '/work/report.pdf' };

test('attachment tokens use one spelling for staging, removal and interpolation', () => {
  assert.equal(attachToken(image), '[img:1]');
  assert.equal(attachToken(file), '[file:2]');
});

test('images and files replace tokens at their positions, not in upload order', () => {
  const raw = 'Read [file:2], then inspect [img:1].';
  const body = attachmentBody(raw, [image, file]);
  assert.equal(body, 'Read /work/report.pdf, then inspect ![](/work/shot.webp).');
  assert.equal(addressed(body, 'alice'),
    '@alice Read /work/report.pdf, then inspect ![](/work/shot.webp).');
});

test('deleted tokens append references in attachment order without dropping content', () => {
  assert.equal(attachmentBody('Read this', [image, file]),
    'Read this\n![](/work/shot.webp)\n/work/report.pdf');
  assert.equal(attachmentBody('', [file, image]), '/work/report.pdf\n![](/work/shot.webp)');
  assert.equal(attachmentBody('See [img:1]', [image, file]),
    'See ![](/work/shot.webp)\n/work/report.pdf');
});

test('interpolation replaces only the first matching token and leaves unknown tokens', () => {
  assert.equal(attachmentBody('[img:1] [img:1] [file:99]', [image]),
    '![](/work/shot.webp) [img:1] [file:99]');
  assert.equal(attachmentBody('[img:10] [img:1]', [image]),
    '[img:10] ![](/work/shot.webp)');
  assert.equal(attachmentBody(' \n text \n ', []), ' \n text \n ',
    'trimming remains the send caller responsibility');
});

test('interpolation preserves String.replace replacement-string semantics', () => {
  // A replacement callback would change dollar expansion in existing paths.
  assert.equal(attachmentBody('[file:2]', [{ ...file, path: '/work/$&.txt' }]),
    '/work/[file:2].txt');
});

test('the reading-filter lock admits the shown agent alone, and checks what a send reaches (#482)', () => {
  // Off ('' — no filter, or "Only mine"): every target goes.
  for (const target of ['bob', ALL_TARGET, teamTarget('squad'), '']) assert.equal(canAddress(target, ''), true, target);
  // On bob: bob alone, whoever asks.
  assert.equal(canAddress('bob', 'bob'), true);
  for (const target of ['alice', ALL_TARGET, teamTarget('squad'), '']) assert.equal(canAddress(target, 'bob'), false, target);
  // On a stopped bob: nobody — the one state live→stopped also reaches (review P1-B).
  assert.equal(canAddress('', 'bob', false), true);
  for (const target of ['bob', 'alice', ALL_TARGET, teamTarget('squad')]) assert.equal(canAddress(target, 'bob', false), false, `${target} while bob is stopped`);
  assert.equal(lockedSend('', true, 'alice', ['carol']), null, 'no filter, no check');
  assert.equal(lockedSend('bob', true, 'bob', []), null);
  assert.equal(lockedSend('bob', true, 'bob', ['bob', '']), null, 'bob by name, or an empty slash target');
  assert.deepEqual(lockedSend('bob', true, 'bob', ['alice', 'all', 'alice']), { kind: 'beyond', names: ['alice', 'all'] });
  assert.deepEqual(lockedSend('bob', false, '', []), { kind: 'unreachable' }, 'a stopped bob receives nothing');
  assert.deepEqual(lockedSend('bob', true, 'alice', []), { kind: 'unreachable' }, 'a target that is not bob is never sent to');
});
