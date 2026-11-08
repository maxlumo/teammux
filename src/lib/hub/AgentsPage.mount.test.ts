// Bound to one server's scope, as App's provider binds it (board #335 ②b-3):
// its RPCs and its backend catalog are that scope's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./AgentsPage.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
let hosted: ReturnType<typeof compileMount> | undefined;
function hostFixture() {
  return hosted ??= compileMount(new URL('./AgentsPage.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
}
const alpha = { name: 'alpha', backend: 'codex', model: '', effort: '', system: 'Original',
  skills: '["missing-skill"]', mcp: '["missing-server",{"name":"inline","expanded":true}]' };
function rpc(extra: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    registryList: async () => ({ agents: [alpha, { ...alpha, name: 'beta' }] }),
    teamsList: async () => ({ teams: [] }),
    skillsList: async () => ({ skills: [] }),
    mcpList: async () => ({ mcp: [] }),
    modelsList: async () => ({ models: [] }),
    // The login answer's caps (board #492): unanswered unless a test says.
    getCaps: () => undefined, onCaps: () => {},
    ...extra,
  };
}
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
function command(app: App, name: string) {
  const button = app.document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  assert.ok(button, name);
  return button;
}
async function openAgent(app: App, name = 'alpha') {
  for (let i = 0; i < 12 && !app.document.querySelector('.r-name'); i++) await app.flush();
  const row = [...app.document.querySelectorAll<HTMLButtonElement>('.side-row')]
    .find(button => button.querySelector('.r-name')?.textContent === name);
  assert.ok(row, name); row.click(); await app.flush();
}
async function text(app: App, value: string) {
  const field = app.document.querySelector<HTMLTextAreaElement>('.editor textarea')!;
  field.value = value;
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
}

test('Agent Save is disabled for an unchanged definition (#156)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc()] });
  try {
    await openAgent(app);
    assert.equal(command(app, 'Save').disabled, true);
  } finally { await app.close(); }
});

test('Agent Cancel protects the draft, and Keep editing preserves its text (#156)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc()] });
  try {
    await openAgent(app);
    await text(app, 'Unsaved draft');
    command(app, 'Cancel').click(); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'cancel cannot silently discard');
    command(app, 'Keep editing').click(); await app.flush();
    assert.equal(app.document.querySelector('textarea')?.value, 'Unsaved draft');
    command(app, 'Cancel').click(); await app.flush();
    command(app, 'Discard').click(); await app.flush();
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('Agent Save freezes one payload, blocks duplicates and retains a failed draft for retry (#156)', async context => {
  const writes: any[] = [];
  let reject!: (reason: Error) => void;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ registrySave: value => { writes.push(value); return new Promise((_, no) => reject = no); } })],
  });
  try {
    await openAgent(app); await text(app, 'Edited');
    command(app, 'Save').click(); command(app, 'Save').click(); await app.flush();
    assert.equal(writes.length, 1, 'one in-flight write');
    assert.equal(command(app, 'Save').getAttribute('aria-busy'), 'true');
    assert.equal(app.document.querySelector('textarea')?.matches(':disabled'), true, 'submitted fields are locked');
    command(app, 'Cancel').click(); await app.flush();
    assert.ok(app.document.querySelector('.editor'), 'pending exit does not drop the submitted draft');
    assert.equal(writes[0].name, 'alpha');
    assert.equal(writes[0].skills, alpha.skills);
    assert.equal(writes[0].mcp, alpha.mcp);
    reject(new Error('Save failed')); await app.flush();
    assert.equal(app.document.querySelector('textarea')?.value, 'Edited');
    assert.equal(command(app, 'Save').disabled, false);
    assert.match(app.document.querySelector('.err')?.textContent ?? '', /Save failed/);
  } finally { await app.close(); }
});

test('the embedding host uses the same discard guard, including a request held during Save (#156)', async context => {
  let leave!: (action: () => void) => void;
  let finish!: () => void;
  let exits = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents', onGuardExit: (guard: typeof leave) => { leave = guard; } },
    modules: [rpc({ registrySave: () => new Promise<void>(yes => finish = yes) })],
  });
  try {
    await openAgent(app); await text(app, 'Changed');
    leave(() => exits++); await app.flush();
    assert.equal(exits, 0);
    command(app, 'Keep editing').click(); await app.flush();
    command(app, 'Save').click(); await app.flush();
    leave(() => exits++); await app.flush();
    assert.equal(exits, 0);
    finish();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(exits, 1, 'a held host request is not silently lost');
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('Back covers global instructions and a failed read cannot enable Save (#156)', async context => {
  let back!: () => boolean;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents', onGoBack: (fn: typeof back) => { back = fn; } },
    modules: [rpc({ globalPromptGet: async () => { throw new Error('Read failed'); } })],
  });
  try {
    app.document.querySelector<HTMLElement>('.ava.global')!.closest('button')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(command(app, 'Save').disabled, true);
    assert.match(app.document.querySelector('.err')?.textContent ?? '', /Read failed/);
    assert.equal(back(), true); await app.flush();
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('a late global read cannot overwrite a newer opening of the same document (#156)', async context => {
  const reads: ((value: unknown) => void)[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ globalPromptGet: () => new Promise(yes => reads.push(yes)) })],
  });
  try {
    const open = () => app.document.querySelector<HTMLElement>('.ava.global')!.closest('button')!.click();
    open(); await app.flush();
    command(app, 'Cancel').click(); await app.flush();
    open(); await app.flush();
    reads[1]!({ text: 'New snapshot', path: '/config/AGENTS.md', max_bytes: 4096 });
    await app.flush();
    reads[0]!({ text: 'Old snapshot', path: '/config/AGENTS.md', max_bytes: 4096 });
    await app.flush();
    assert.equal(app.document.querySelector('textarea')?.value, 'New snapshot');
    assert.equal(command(app, 'Save').disabled, true);
  } finally { await app.close(); }
});

test('Ctrl/Cmd Enter shares Save, ignores IME and blocks repeated submission (#156)', async context => {
  let writes = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ registrySave: () => { writes++; return new Promise(() => {}); } })],
  });
  try {
    await openAgent(app); await text(app, 'Changed');
    const field = app.document.querySelector('textarea')!;
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      field.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, ...ime }));
    }
    assert.equal(writes, 0);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      field.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...modifier }));
    }
    await app.flush();
    assert.equal(writes, 1);
  } finally { await app.close(); }
});

test('an invalid MCP draft disables Save without discarding its JSON (#156)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'mcp' },
    modules: [rpc({ mcpList: async () => ({ mcp: [{ name: 'files', def: '{"command":"test"}' }] }) })],
  });
  try {
    await openAgent(app, 'files');
    assert.equal(command(app, 'Save').disabled, true);
    await text(app, '{');
    assert.equal(command(app, 'Save').disabled, true);
    command(app, 'Cancel').click(); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'));
    command(app, 'Keep editing').click(); await app.flush();
    assert.equal(app.document.querySelector('textarea')?.value, '{');
  } finally { await app.close(); }
});

test('a successful unnamed Skill import returns to its list, not another editor (#156)', async context => {
  const imports: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'skills' },
    modules: [rpc({ skillsImport: async (source: string) => { imports.push(source); return { imported: ['imported'], skipped: [] }; } })],
  });
  try {
    app.document.querySelector<HTMLButtonElement>('.side-row.add')!.click(); await app.flush();
    const source = app.document.querySelectorAll<HTMLInputElement>('.editor input')[1]!;
    source.value = '/fixture';
    source.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    command(app, 'Import').click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(imports, ['/fixture']);
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('a hidden page retains its draft and a held deep link opens only after the captured save (#156)', async context => {
  const fixture = await hostFixture();
  let controls!: { show: (value: boolean) => void; edit: (name: string) => void };
  let finish!: () => void;
  let finishReload!: (value: unknown) => void;
  let reads = 0;
  const writes: any[] = [];
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value },
    modules: [rpc({
      registryList: () => ++reads === 1 ? Promise.resolve({ agents: [alpha, { ...alpha, name: 'beta' }] })
        : new Promise(yes => finishReload = yes),
      registrySave: value => { writes.push(value); return new Promise<void>(yes => finish = yes); },
    })],
  });
  try {
    await openAgent(app); await text(app, 'Persist across tabs');
    controls.show(false); await app.flush();
    controls.show(true); await app.flush();
    assert.equal(app.document.querySelector('textarea')?.value, 'Persist across tabs');
    command(app, 'Save').click(); await app.flush();
    controls.edit('beta'); await app.flush();
    assert.equal(app.document.querySelector('.mid h1')?.textContent, 'alpha');
    finish();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(writes[0].name, 'alpha', 'target captured at activation');
    assert.equal(app.document.querySelector('.mid h1')?.textContent, 'beta');
    finishReload({ agents: [alpha, { ...alpha, name: 'beta' }] });
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(app.document.querySelector('.mid h1')?.textContent, 'beta', 'late catalog refresh does not close the newer editor');
    assert.equal(app.document.querySelector('textarea')?.value, 'Original');
  } finally { await app.close(); }
});

test('the input mode is offered only where the server says the backend switches, and saves steer (#245)', async context => {
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes });
  const writes: any[] = [];
  const app = await fixture.mount(context, {
    props: { ready: () => {}, backends: [served('kiro', true), served('codex', true), served('claude', false)] },
    modules: [rpc({
      registryList: async () => ({ agents: [alpha, { ...alpha, name: 'cc', backend: 'claude' }] }),
      registrySave: async (value: unknown) => { writes.push(value); },
    })],
  });
  const field = () => app.document.querySelector<HTMLButtonElement>('[aria-label="While busy"]');
  try {
    await openAgent(app, 'cc');
    assert.equal(field(), null, 'claude: no switch, no field');
    command(app, 'Cancel').click(); await app.flush();
    await openAgent(app, 'alpha');
    assert.equal(field()?.querySelector('.sel-value')?.textContent, 'Queue', 'queue is the default');
    const steerHint = () => [...app.document.querySelectorAll('.editor .hint')].find(h => /wrong sender/u.test(h.textContent ?? ''));
    assert.equal(steerHint(), undefined, 'no warning while queued');
    field()!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === 'Steer')!.click();
    await app.flush();
    assert.match(steerHint()?.textContent ?? '', /no delivery receipt.*wrong sender/u, 'steer says what it costs');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    assert.equal(writes[0]?.input_mode, 'steer');
  } finally { await app.close(); }
});

test('a saved steer survives a missing capability list, and a late list reveals the field (#245, validator 19:33)', async context => {
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes });
  const writes: any[] = [];
  let controls!: { serve: (list: unknown) => void };
  const app = await fixture.mount(context, {
    // No backends_list yet (fetch pending, failed, or an older server).
    props: { ready: (value: typeof controls) => controls = value, backends: null },
    modules: [rpc({
      registryList: async () => ({ agents: [{ ...alpha, backend: 'kiro', input_mode: 'steer' }, { ...alpha, name: 'q', backend: 'kiro', input_mode: 'queue' }] }),
      registrySave: async (value: unknown) => { writes.push(value); },
    })],
  });
  const field = () => app.document.querySelector<HTMLButtonElement>('[aria-label="While busy"]');
  try {
    await openAgent(app, 'alpha');
    assert.equal(field()?.querySelector('.sel-value')?.textContent, 'Steer', 'a saved steer is shown even with no list');
    await text(app, 'Edited while the list is missing');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    assert.equal(writes[0]?.input_mode, 'steer', 'an unchanged backend keeps its steer');
    for (let i = 0; i < 5; i++) await app.flush();
    await openAgent(app, 'q');
    assert.equal(field(), null, 'queue on an unknown capability: no field yet');
    controls.serve([served('kiro', true), served('claude', false)]);
    await app.flush();
    assert.equal(field()?.querySelector('.sel-value')?.textContent, 'Queue', 'the late list reveals the field in the open editor');
    // With the list known, an explicit move to a backend without the switch
    // resets a steer draft (the one place the editor changes it).
    field()!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === 'Steer')!.click();
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('[aria-label="Backend"]')!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === 'claude')!.click();
    await app.flush();
    assert.equal(field(), null, 'claude: the field goes with the switch');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && writes.length < 2; i++) await app.flush();
    assert.deepEqual([writes[1]?.backend, writes[1]?.input_mode], ['claude', 'queue']);
  } finally { await app.close(); }
});

test('Team disclosure is not an edit; its actual role uses the guarded Save (#156)', async context => {
  const writes: any[] = [];
  const team = { name: 'squad', description: 'Rules', members: JSON.stringify([
    { name: 'dev', base: 'alpha', role: 'Implement' }, { name: 'reviewer', base: 'beta', role: 'Review' },
  ]) };
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'teams' },
    modules: [rpc({ teamsList: async () => ({ teams: [team] }), teamsSave: async value => { writes.push(value); return {}; } })],
  });
  try {
    await openAgent(app, 'squad');
    assert.equal(command(app, 'Save').disabled, true);
    app.document.querySelectorAll<HTMLButtonElement>('.member-summary')[1]!.click(); await app.flush();
    assert.equal(command(app, 'Save').disabled, true, 'folding does not mutate the payload');
    const role = app.document.querySelector<HTMLTextAreaElement>('.member-body textarea')!;
    role.value = 'Review carefully';
    role.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    command(app, 'Save').click(); command(app, 'Save').click();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].members)[1].role, 'Review carefully');
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

// Owner #336: "在启动 Agent 的时候如果是 kiro 默认就给我使用 steer 模式吧". A NEW
// draft starts in the mode the server names for its backend, and an explicit
// backend pick takes that backend's default. A STORED definition is opened
// with the mode it was saved with (the #245 tests above: a stored queue kiro
// shows Queue).
test('a new kiro agent or bare kiro member starts in steer, and a backend pick takes its default (#336)', async context => {
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean, default_input_mode?: 'steer') =>
    ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes, ...(default_input_mode ? { default_input_mode } : {}) });
  const writes: any[] = [];
  const teamWrites: any[] = [];
  const team = { name: 'squad', description: '', members: JSON.stringify([{ name: 'dev', base: 'alpha', role: 'Implement' }]) };
  let controls!: { section: (value: string) => void };
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value, backends: [served('kiro', true, 'steer'), served('codex', true), served('claude', false)] },
    modules: [rpc({
      registrySave: async (value: unknown) => { writes.push(value); },
      teamsList: async () => ({ teams: [team] }),
      teamsSave: async (value: any) => { teamWrites.push(value); return {}; },
    })],
  });
  const mode = (root: ParentNode = app.document) => root.querySelector<HTMLButtonElement>('[aria-label="While busy"]')?.querySelector('.sel-value')?.textContent ?? null;
  const pick = async (label: string, option: string, root: ParentNode = app.document) => {
    root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === option)!.click();
    await app.flush();
  };
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.side-row.add'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.side-row.add')!.click(); await app.flush();
    assert.equal(mode(), 'Steer', 'a new agent on the default backend (kiro) starts in steer');
    await pick('Backend', 'codex');
    assert.equal(mode(), 'Queue', 'codex can switch, but its default is queue');
    await pick('Backend', 'claude');
    assert.equal(mode(), null, 'claude: no switch, no field');
    await pick('Backend', 'kiro');
    assert.equal(mode(), 'Steer', 'back on kiro: its default again');
    const name = app.document.querySelector<HTMLInputElement>('.editor input[placeholder="reviewer"]')!;
    name.value = 'fresh';
    name.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    assert.deepEqual([writes[0]?.backend, writes[0]?.input_mode], ['kiro', 'steer'], 'and it saves steer');

    for (let i = 0; i < 5; i++) await app.flush();
    controls.section('teams'); await app.flush();
    await openAgent(app, 'squad');
    const member = () => app.document.querySelectorAll<HTMLElement>('.member')[0]!;
    await pick('Member source', 'Bare coding agent', member());
    assert.equal(mode(member()), 'Steer', 'a member turned into a new bare kiro starts in steer');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !teamWrites.length; i++) await app.flush();
    const members = JSON.parse(teamWrites[0].members);
    assert.deepEqual([members[0].agent?.backend, members[0].agent?.input_mode], ['kiro', 'steer']);
  } finally { await app.close(); }
});

// Reviewer P2 on 99e233c3: the default is where a NEW draft STARTS. A mode
// the person picked, or a stored one, is not moved to a default by a backend
// pick or by a backend list that lands late; only a steer the picked backend
// cannot carry becomes queue (the #245 rule above).
test('a picked or stored mode survives a backend pick, and a late list moves only an untouched new draft (#336)', async context => {
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean, default_input_mode?: 'steer') =>
    ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes, ...(default_input_mode ? { default_input_mode } : {}) });
  const list = [served('kiro', true, 'steer'), served('codex', true), served('claude', false)];
  let controls!: { serve: (value: unknown) => void };
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value, backends: null },
    modules: [rpc({ registryList: async () => ({ agents: [alpha, { ...alpha, name: 'ks', backend: 'kiro', input_mode: 'steer' }] }) })],
  });
  const mode = () => app.document.querySelector('[aria-label="While busy"] .sel-value')?.textContent ?? null;
  const pick = async (label: string, option: string) => {
    app.document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === option)!.click();
    await app.flush();
  };
  const newAgent = async () => { app.document.querySelector<HTMLButtonElement>('.side-row.add')!.click(); await app.flush(); };
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.side-row.add'); i++) await app.flush();
    await newAgent();
    assert.equal(mode(), null, 'no list yet: a queue draft shows no field');
    controls.serve(list); await app.flush();
    assert.equal(mode(), 'Steer', 'the late list gives the untouched new kiro its default');
    command(app, 'Cancel').click(); await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'following the default is not an edit: no discard prompt');

    await newAgent();
    await pick('While busy', 'Queue');
    await pick('Backend', 'codex');
    assert.equal(mode(), 'Queue', 'a picked queue stays queue on codex');
    await pick('Backend', 'kiro');
    assert.equal(mode(), 'Queue', 'and on kiro: the pick is not replaced by the default');
    controls.serve(list); await app.flush();
    assert.equal(mode(), 'Queue', 'nor by a list that lands again');
    command(app, 'Cancel').click(); await app.flush();
    command(app, 'Discard').click(); await app.flush();

    await openAgent(app, 'alpha');
    assert.equal(mode(), 'Queue', 'a stored codex def (no mode = queue)');
    await pick('Backend', 'kiro');
    assert.equal(mode(), 'Queue', 'moved to kiro, it keeps its stored queue');
    command(app, 'Cancel').click(); await app.flush();
    command(app, 'Discard').click(); await app.flush();
    await openAgent(app, 'ks');
    await pick('Backend', 'codex');
    assert.equal(mode(), 'Steer', 'a stored kiro steer moved to codex keeps steer: codex carries it');
  } finally { await app.close(); }
});

test('a server that names no default keeps a new draft at queue (#336)', async context => {
  const fixture = await hostFixture();
  const app = await fixture.mount(context, {
    // An older server: input_modes, but no default_input_mode.
    props: { ready: () => {}, backends: [{ name: 'kiro', icon: '/assets/kiro.svg', color: '--backend-kiro', efforts: [], input_modes: true }] },
    modules: [rpc()],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.side-row.add'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.side-row.add')!.click(); await app.flush();
    assert.equal(app.document.querySelector('[aria-label="While busy"] .sel-value')?.textContent, 'Queue');
  } finally { await app.close(); }
});

test('a team\'s bare member takes the same input-mode field (#245)', async context => {
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes });
  const writes: any[] = [];
  const team = { name: 'squad', description: '', members: JSON.stringify([
    { name: 'dev', base: 'alpha', role: 'Implement' },
    { name: 'raw', base: '', role: 'Raw', agent: { name: 'raw', backend: 'kiro', model: '', effort: '', input_mode: 'queue', system: 'Bare.', skills: '[]', mcp: '[]' } },
  ]) };
  let controls!: { section: (value: string) => void };
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value, backends: [served('kiro', true), served('codex', true), served('claude', false)] },
    modules: [rpc({ teamsList: async () => ({ teams: [team] }), teamsSave: async (value: any) => { writes.push(value); return {}; } })],
  });
  try {
    controls.section('teams'); await app.flush();
    await openAgent(app, 'squad');
    const bareField = () => app.document.querySelectorAll<HTMLElement>('.member')[1]?.querySelector<HTMLButtonElement>('[aria-label="While busy"]');
    app.document.querySelectorAll<HTMLButtonElement>('.member-summary')[1]!.click(); await app.flush();
    assert.ok(bareField(), 'the bare member has the field');
    bareField()!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === 'Steer')!.click();
    await app.flush();
    assert.ok([...app.document.querySelectorAll('.editor .hint')].some(h => /wrong sender/u.test(h.textContent ?? '')), 'the same cost hint');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    const members = JSON.parse(writes[0].members);
    assert.equal(members[1].agent.input_mode, 'steer', 'the bare member saves steer');
    assert.equal(members[0].agent, null, 'the derived member carries no definition of its own');
    assert.equal(members[0].input_mode, '', 'an untouched derived member inherits');
  } finally { await app.close(); }
});

test('a member derived from a registry agent overrides its input mode, or inherits it (#254)', async context => {
  // Owner 2026-09-28: "team 内的 agent … 应该需要能单独配置". The same field, with
  // an "inherit (<base's mode>)" default, only where the BASE's backend switches.
  const fixture = await hostFixture();
  const served = (name: string, input_modes: boolean) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes });
  const writes: any[] = [];
  const team = { name: 'squad', description: '', members: JSON.stringify([
    { name: 'dev', base: 'kb', role: 'Implement' },
    { name: 'cc', base: 'cb', role: 'Review' },
  ]) };
  let controls!: { section: (value: string) => void };
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value, backends: [served('kiro', true), served('claude', false)] },
    modules: [rpc({
      registryList: async () => ({ agents: [{ ...alpha, name: 'kb', backend: 'kiro', input_mode: 'steer' }, { ...alpha, name: 'cb', backend: 'claude' }] }),
      teamsList: async () => ({ teams: [team] }),
      teamsSave: async (value: any) => { writes.push(value); return {}; },
    })],
  });
  try {
    controls.section('teams'); await app.flush();
    await openAgent(app, 'squad');
    const body = (i: number) => app.document.querySelectorAll<HTMLElement>('.member')[i];
    const field = (i: number) => body(i)?.querySelector<HTMLButtonElement>('[aria-label="While busy"]');
    assert.equal(field(0)?.querySelector('.sel-value')?.textContent, 'same as base (Steer)', 'empty inherits, and says what it inherits');
    assert.ok([...body(0)!.querySelectorAll('.hint')].some(h => /wrong sender/u.test(h.textContent ?? '')), 'an inherited steer still says what it costs');
    app.document.querySelectorAll<HTMLButtonElement>('.member-summary')[1]!.click(); await app.flush();
    assert.equal(field(1), null, 'a claude base cannot switch: no field');
    app.document.querySelectorAll<HTMLButtonElement>('.member-summary')[0]!.click(); await app.flush(); // one open at a time
    field(0)!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(o => o.textContent?.trim() === 'Queue')!.click();
    await app.flush();
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    const members = JSON.parse(writes[0].members);
    assert.deepEqual([members[0].input_mode, members[1].input_mode], ['queue', ''], 'the override is saved; the claude member stays inherit');
    assert.equal(members[0].agent, null, 'still a derived member');
  } finally { await app.close(); }
});

test('Escape enters the same dirty-exit guard after the Select has dismissed itself (#156)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc()] });
  try {
    await openAgent(app); await text(app, 'Unsaved');
    const select = app.document.querySelector<HTMLButtonElement>('.sel-trigger')!;
    select.click(); await app.flush();
    const escape = () => select.dispatchEvent(new app.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    escape(); await app.flush();
    assert.equal(app.document.querySelector('[role=listbox]'), null);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'first Escape belongs to the Select');
    escape(); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'), 'second Escape protects the draft');
  } finally { await app.close(); }
});

test('Skill refresh invalidates older same-path file and file-list replies (#156)', async context => {
  const files: ((value: unknown) => void)[] = [], lists: ((value: unknown) => void)[] = [];
  const skill = { name: 'docs', source: '/fixture/docs', description: 'Documentation' };
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'skills' },
    modules: [rpc({
      skillsList: async () => ({ skills: [skill] }),
      skillsRefresh: async () => ({}),
      skillsFiles: () => new Promise(yes => lists.push(yes)),
      skillsFile: () => new Promise(yes => files.push(yes)),
    })],
  });
  try {
    await openAgent(app, 'docs');
    command(app, 'Refresh').click();
    for (let i = 0; i < 5; i++) await app.flush();
    lists[1]!({ files: [{ path: 'SKILL.md', size: 200 }, { path: 'new.txt', size: 10 }] });
    files[1]!({ content: 'New documentation' });
    await app.flush();
    files[0]!({ content: 'Old documentation' });
    lists[0]!({ files: [{ path: 'SKILL.md', size: 100 }] });
    await app.flush();
    assert.match(app.document.querySelector('.md-doc')?.textContent ?? '', /New documentation/);
    assert.equal(app.document.querySelectorAll('.file-row').length, 2);
  } finally { await app.close(); }
});

test('compact configuration confirmations use the existing sheet form (#156)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' }, modules: [rpc()],
    setup(window) {
      const match = window.matchMedia;
      window.matchMedia = query => Object.assign(match(query), { matches: query === '(max-width: 760px)' });
    },
  });
  try {
    await openAgent(app); await text(app, 'Unsaved');
    command(app, 'Cancel').click(); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]')?.classList.contains('sheet'));
  } finally { await app.close(); }
});

test('a built-in Skill description is readable without an edit affordance (#156)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'skills' },
    modules: [rpc({
      skillsList: async () => ({ skills: [{ name: 'builtin', source: 'builtin', description: 'Read-only description' }] }),
      skillsFiles: async () => ({ files: [] }), skillsFile: async () => ({ content: '' }),
    })],
  });
  try {
    await openAgent(app, 'builtin');
    assert.equal(app.document.querySelector('.desc-view'), null);
    assert.equal(app.document.querySelector('.desc-readonly')?.textContent, 'Read-only description');
    assert.equal(command(app, 'Save').disabled, true);
  } finally { await app.close(); }
});

// #167, 2026-09-12: baseline errors were already visible in the modal note.
// Separate alert/error ownership while preserving busy/Back and retry behavior.
for (const kind of ['agent', 'team', 'skill', 'mcp'] as const) {
  test(`${kind} deletion preserves busy Back and retry with a separate modal alert (#167)`, async context => {
    const names = { agent: 'alpha', team: 'squad', skill: 'docs', mcp: 'files' };
    const section = { agent: 'agents', team: 'teams', skill: 'skills', mcp: 'mcp' }[kind];
    const deletes = { agent: 'registryDelete', team: 'teamsDelete', skill: 'skillsDelete', mcp: 'mcpDelete' };
    const calls: string[] = [];
    let back!: () => boolean, reject!: (error: Error) => void;
    const app = await (await compiled).mount(context, {
      props: { visible: true, section, onGoBack: (value: typeof back) => back = value },
      modules: [rpc({
        teamsList: async () => ({ teams: [{ name: 'squad', description: '', members: '[{"name":"dev","base":"alpha"}]' }] }),
        skillsList: async () => ({ skills: [{ name: 'docs', source: '/fixture', description: '' }] }),
        skillsFiles: async () => ({ files: [] }), skillsFile: async () => ({ content: '' }),
        mcpList: async () => ({ mcp: [{ name: 'files', def: '{"command":"test"}' }] }),
        [deletes[kind]]: (name: string) => { calls.push(name); return new Promise((_, no) => reject = no); },
      })],
    });
    try {
      await openAgent(app, names[kind]);
      command(app, 'Delete').click(); await app.flush();
      const confirm = () => app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
      confirm().click(); confirm().click(); await app.flush();
      assert.equal(back(), true, 'busy Back is consumed');
      app.document.querySelector<HTMLElement>('.dlg-backdrop')!.click();
      const escape = new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      app.window.dispatchEvent(escape); await app.flush();
      assert.equal(escape.defaultPrevented, true);
      assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
      assert.deepEqual(calls, [names[kind]]);
      reject(new Error('Deletion refused')); await app.flush();
      assert.ok(app.document.querySelector('[role=alertdialog]'), 'existing retry guard stays intact');
      assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Deletion refused/);
      assert.doesNotMatch(app.document.querySelector('.dlg-note')?.textContent ?? '', /Deletion refused/);
      assert.equal(confirm().disabled, false);
      confirm().click(); await app.flush();
      assert.deepEqual(calls, [names[kind], names[kind]]);
      assert.equal(app.document.querySelector('[role=alertdialog] [role=alert]'), null);
    } finally { await app.close(); }
  });
}

test('a completed deletion releases the editor before a failed refresh and cannot clear a newer deletion (#167)', async context => {
  const reads: ((error: Error) => void)[] = [];
  const writes: string[] = [];
  let initial = true, finishBeta!: () => void;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({
      registryList: () => {
        if (initial) { initial = false; return Promise.resolve({ agents: [alpha, { ...alpha, name: 'beta' }] }); }
        return new Promise((_, no) => reads.push(no));
      },
      registryDelete: name => {
        writes.push(name);
        return name === 'alpha' ? Promise.resolve() : new Promise<void>(yes => finishBeta = yes);
      },
    })],
  });
  try {
    await openAgent(app);
    command(app, 'Delete').click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
    await openAgent(app, 'beta');
    assert.equal(app.document.querySelector('.mid h1')?.textContent, 'beta', 'catalog refresh is not a pending mutation');
    command(app, 'Delete').click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    reads[0]!(new Error('Catalog unavailable'));
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true',
      'old refresh cleanup cannot clear the new mutation busy state');
    assert.deepEqual(writes, ['alpha', 'beta']);
    finishBeta();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('a committed host section change invalidates old delete completion and cleanup (#167)', async context => {
  const fixture = await hostFixture();
  let controls!: { section: (value: string) => void };
  let rejectOld!: (error: Error) => void, rejectNew!: (error: Error) => void;
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value },
    modules: [rpc({
      teamsList: async () => ({ teams: [{ name: 'squad', description: '', members: '[{"name":"dev","base":"alpha"}]' }] }),
      registryDelete: () => new Promise((_, no) => rejectOld = no),
      teamsDelete: () => new Promise((_, no) => rejectNew = no),
    })],
  });
  try {
    await openAgent(app);
    command(app, 'Delete').click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    controls.section('teams'); await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'the host committed a different view');
    await openAgent(app, 'squad');
    command(app, 'Delete').click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    rejectOld(new Error('Old rejection')); await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]')?.getAttribute('aria-busy'), 'true');
    assert.equal(app.document.querySelector('[role=alertdialog] [role=alert]'), null);
    rejectNew(new Error('Current rejection')); await app.flush();
    assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Current rejection/);
  } finally { await app.close(); }
});

test('a save the server could not apply to running agents is said on the page, and is not undone (#411)', async context => {
  for (const props of [{ visible: true }, { visible: true, section: 'agents' }]) {
    const writes: any[] = [];
    const app = await (await compiled).mount(context, {
      props,
      modules: [rpc({
        registrySave: async (value: unknown) => {
          writes.push(value);
          return { ok: true, name: 'alpha', unapplied: [
            { project: '/work/tmux-mobile', window: 'dsh-1', definition: 'alpha', kind: 'failed', error: 'permission denied' },
            { project: '/work/other', window: 'dsh-2', definition: '', kind: 'unknown', error: 'its recipe is not readable' },
          ] };
        },
      })],
    });
    try {
      await openAgent(app); await text(app, 'Edited persona');
      command(app, 'Save').click();
      for (let i = 0; i < 8 && !app.document.querySelector('[role=alert]'); i++) await app.flush();
      assert.equal(writes.length, 1, 'the save went through');
      assert.equal(app.document.querySelector('.editor'), null, 'the editor closed: the declaration is saved, not rolled back');
      const alert = app.document.querySelector('[role=alert]')?.textContent ?? '';
      assert.match(alert, /Saved, but running agents still use the old settings/u, JSON.stringify(props));
      assert.match(alert, /dsh-1 \(tmux-mobile\): permission denied/u, 'it names the window, its project and the reason');
      const [failed = '', unconfirmed = ''] = alert.split('application not confirmed');
      assert.ok(!failed.includes('dsh-2') && unconfirmed.includes('dsh-2 (other): its recipe is not readable') && !unconfirmed.includes('dsh-1'), 'a home that could not be confirmed is not claimed to run the old settings');
    } finally { await app.close(); }
  }
});

test('a save every running agent took shows no alert (#411)', async context => {
  const app = await (await compiled).mount(context, {
    props: { visible: true },
    modules: [rpc({ registrySave: async () => ({ ok: true, name: 'alpha' }) })],
  });
  try {
    await openAgent(app); await text(app, 'Edited persona');
    command(app, 'Save').click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.document.querySelector('.editor'), null);
    assert.equal(app.document.querySelector('[role=alert]'), null);
  } finally { await app.close(); }
});

test('a refused definition list says why where its rows would be, and opens nothing to save (#451 delta 2)', async context => {
  const writes: unknown[] = [];
  const reason = "agent 'old': its stored mcp is not valid JSON of the expected shape, so no agent definition is listed";
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ registryList: async () => { throw Object.assign(new Error(reason), { code: -32603 }); }, registrySave: (v: unknown) => { writes.push(v); return Promise.resolve({}); } })],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('[role=alert]'); i++) await app.flush();
    assert.equal(app.document.querySelector('[role=alert]')?.textContent, reason);
    const rows = [...app.document.querySelectorAll('.side-row .r-name')].map(n => n.textContent);
    assert.ok(!rows.includes('alpha') && !rows.includes('old'), `no definition row: ${rows}`);
    assert.equal(app.document.querySelector('.editor'), null, 'no draft opens');
    assert.deepEqual(writes, [], 'and nothing can be saved from it');
  } finally { await app.close(); }
});

test('an inline MCP server the editor does not show goes back with its "<set>" markers, byte for byte (#451)', async context => {
  const writes: any[] = [];
  const masked = { ...alpha, mcp: '["files",{"name":"inline","command":"c","env":{"KIRO_API_KEY":"<set>"},"headers":{"Authorization":"<set>"}}]' };
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ registryList: async () => ({ agents: [masked] }), registrySave: (v: unknown) => { writes.push(v); return Promise.resolve({}); } })],
  });
  try {
    await openAgent(app); await text(app, 'Only the persona changed');
    command(app, 'Save').click(); await app.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].system, 'Only the persona changed');
    assert.equal(writes[0].mcp, masked.mcp, 'the server restores each marker from the stored row');
  } finally { await app.close(); }
});

// Reviewer P1-B on #451: a list read BEFORE the refusal must not stay saveable — its old
// "[]" carries no marker, and a marker-free save is the repair path, so it would overwrite
// the field the server just refused to list. Closed or open, nothing of that kind saves.
for (const open of [false, true]) {
  test(`a list refused after a good read closes ${open ? 'the open draft' : 'its cached rows'} to saving, keeping the text (#451 P1-B)`, async context => {
    const fixture = await hostFixture();
    let controls!: { show: (value: boolean) => void };
    let reads = 0;
    const writes: unknown[] = [];
    const reason = "agent 'alpha': its stored mcp is not valid JSON of the expected shape, so no agent definition is listed";
    const app = await fixture.mount(context, {
      props: { ready: (value: typeof controls) => controls = value },
      modules: [rpc({
        registryList: async () => {
          if (++reads === 1) return { agents: [alpha] };
          throw Object.assign(new Error(reason), { code: -32603 });
        },
        registrySave: (v: unknown) => { writes.push(v); return Promise.resolve({}); },
      })],
    });
    try {
      if (open) { await openAgent(app); await text(app, 'Only the persona changed'); }
      else for (let i = 0; i < 12 && !app.document.querySelector('.r-name'); i++) await app.flush();
      controls.show(false); await app.flush();
      controls.show(true);
      for (let i = 0; i < 8; i++) await app.flush();
      assert.equal(reads, 2, 'the page read the list again');
      const rows = [...app.document.querySelectorAll('.side-row .r-name')].map(n => n.textContent);
      assert.ok(!rows.includes('alpha'), `the cached row is not offered: ${rows}`);
      if (open) {
        assert.equal(app.document.querySelector('textarea')?.value, 'Only the persona changed', 'the draft text is kept');
        assert.equal(command(app, 'Save').disabled, true, 'but it cannot be saved');
        assert.match(app.document.querySelector('.editor .err')?.textContent ?? '', /not valid JSON/u, 'and it says why');
        command(app, 'Save').click(); await app.flush();
      } else {
        assert.equal(app.document.querySelector('.editor'), null, 'no editor can be opened from it');
      }
      assert.deepEqual(writes, [], 'nothing was saved');
    } finally { await app.close(); }
  });
}

test('a timed-out list read is not a refusal: the last rows stay editable (#451 P1-B)', async context => {
  const fixture = await hostFixture();
  let controls!: { show: (value: boolean) => void };
  let reads = 0;
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value },
    modules: [rpc({ registryList: async () => { if (++reads === 1) return { agents: [alpha] }; throw new Error('RPC timeout'); } })],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.r-name'); i++) await app.flush();
    controls.show(false); await app.flush();
    controls.show(true);
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(reads, 2);
    assert.equal(app.document.querySelector('[role=alert]'), null, 'no refusal is shown');
    await openAgent(app);
    assert.ok(app.document.querySelector('.editor'), 'the last list is still there to edit');
  } finally { await app.close(); }
});

// Reviewer P1-B residual on #451: list answers are ordered by request, per kind. Read 1 lands;
// read 2 is HELD; read 3 answers at once; then read 2 is released. Only the newest read may
// publish rows, a refusal or a recovery.
async function heldReads(context: any, second: 'success' | 'refusal', third: 'success' | 'refusal') {
  const fixture = await hostFixture();
  let controls!: { show: (value: boolean) => void };
  let reads = 0;
  let release!: () => void;
  const writes: unknown[] = [];
  const reason = "agent 'alpha': its stored mcp is not valid JSON of the expected shape, so no agent definition is listed";
  const refused = () => Object.assign(new Error(reason), { code: -32603 });
  const answer = (kind: 'success' | 'refusal') => kind === 'success' ? Promise.resolve({ agents: [alpha] }) : Promise.reject(refused());
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value },
    modules: [rpc({
      registryList: () => {
        const n = ++reads;
        if (n === 1) return Promise.resolve({ agents: [alpha] });
        if (n === 2) return new Promise((yes, no) => { release = () => second === 'success' ? yes({ agents: [alpha] }) : no(refused()); });
        return answer(third);
      },
      registrySave: (v: unknown) => { writes.push(v); return Promise.resolve({}); },
    })],
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await app.flush(); };
  const again = async () => { controls.show(false); await app.flush(); controls.show(true); await settle(); };
  for (let i = 0; i < 12 && !app.document.querySelector('.r-name'); i++) await app.flush();
  await again(); // read 2, held
  await again(); // read 3, answered
  release(); await settle();
  const offered = () => [...app.document.querySelectorAll('.side-row .r-name')].some(n => n.textContent === 'alpha');
  return { app, reads: () => reads, writes, offered };
}

test('an older success held in flight does not lift a newer refusal (#451 P1-B residual)', async context => {
  const { app, reads, writes, offered } = await heldReads(context, 'success', 'refusal');
  try {
    assert.equal(reads(), 3);
    assert.equal(offered(), false, 'the rows stay closed after the late success');
    assert.match(app.document.querySelector('[role=alert]')?.textContent ?? '', /not valid JSON/u, 'and the refusal stays said');
    assert.equal(app.document.querySelector('.editor'), null);
    assert.deepEqual(writes, [], 'no payload');
  } finally { await app.close(); }
});

test('an older refusal held in flight does not close a newer success (#451 P1-B residual)', async context => {
  const { app, reads, offered } = await heldReads(context, 'refusal', 'success');
  try {
    assert.equal(reads(), 3);
    assert.equal(offered(), true, 'the newest read lists the rows');
    assert.equal(app.document.querySelector('[role=alert]'), null, 'and no stale refusal covers them');
    await openAgent(app);
    assert.ok(app.document.querySelector('.editor'));
  } finally { await app.close(); }
});

test('a new successful read after a refusal reopens the kind, and clears only the refusal it left (#451 P1-B residual)', async context => {
  const fixture = await hostFixture();
  let controls!: { show: (value: boolean) => void };
  let reads = 0;
  const reason = "agent 'alpha': its stored mcp is not valid JSON of the expected shape, so no agent definition is listed";
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value },
    modules: [rpc({ registryList: async () => {
      if (++reads === 2) throw Object.assign(new Error(reason), { code: -32603 });
      return { agents: [alpha] };
    } })],
  });
  try {
    await openAgent(app); await text(app, 'Kept through the refusal');
    const again = async () => { controls.show(false); await app.flush(); controls.show(true); for (let i = 0; i < 8; i++) await app.flush(); };
    await again();
    assert.equal(command(app, 'Save').disabled, true);
    assert.match(app.document.querySelector('.editor .err')?.textContent ?? '', /not valid JSON/u);
    await again();
    assert.equal(reads, 3);
    assert.equal(app.document.querySelector('textarea')?.value, 'Kept through the refusal');
    assert.equal(command(app, 'Save').disabled, false, 'the draft can be saved again');
    assert.equal(app.document.querySelector('.editor .err'), null, 'the refusal it showed is gone');
  } finally { await app.close(); }
});

// ── Backends (board #492 phase 2): the category, the phone section, and the
// one shown-predicate over the server's `backends_check` cap. ──────────────
const KIRO_ROW = {
  name: 'kiro', program: 'kiro-cli',
  installed: { state: 'present', path: '/home/u/.local/bin/kiro-cli', version: '1.2.3', reason: null },
  set_up: { state: 'unknown', basis: 'presence', via: null, missing: [], reason: 'test_only' },
  answers: { state: 'unknown', count: null, reason: 'test_only' },
};
/** A server whose login caps a test can change (a reconnect, another server). */
function capsServer(initial: string[] | undefined) {
  let now = initial;
  const watchers: ((caps: string[] | undefined) => void)[] = [];
  const checks: string[] = [];
  const modules = rpc({
    getCaps: () => now,
    onCaps: (cb: (caps: string[] | undefined) => void) => { watchers.push(cb); },
    backendsCheck: async (test?: string) => { checks.push(test ?? 'refresh'); return { backends: [KIRO_ROW], scope: 'default', baseline: null }; },
  });
  const set = async (app: App, caps: string[] | undefined) => {
    now = caps;
    for (const w of watchers) w(caps);
    for (let i = 0; i < 6; i++) await app.flush();
  };
  return { modules, set, checks };
}
const categories = (app: App) => [...app.document.querySelectorAll('.sidebar .side-row .r-name')].map((n) => n.textContent);
const settle = async (app: App) => { for (let i = 0; i < 8; i++) await app.flush(); };

test('desktop: Backends is a category only on a server that announces the check, and opening it runs one Refresh (#492)', async context => {
  const old = capsServer([]);
  let app = await (await compiled).mount(context, { props: { visible: true }, modules: [old.modules] });
  try {
    await settle(app);
    assert.ok(!categories(app).includes('Backends'), 'a server known to lack it has no entry');
    assert.deepEqual(old.checks, []);
  } finally { await app.close(); }
  const current = capsServer(['mcp_masked', 'backends_check']);
  app = await (await compiled).mount(context, { props: { visible: true }, modules: [current.modules] });
  try {
    await settle(app);
    assert.deepEqual(categories(app).slice(-2), ['MCP servers', 'Backends'], 'the sixth category, after MCP');
    assert.deepEqual(current.checks, [], 'the page\u2019s mount runs no check');
    const row = [...app.document.querySelectorAll<HTMLButtonElement>('.sidebar .side-row')].find((b) => b.textContent?.includes('Backends'))!;
    row.click(); await settle(app);
    assert.deepEqual(current.checks, ['refresh'], 'entering the section runs its one Refresh');
    assert.equal(app.document.querySelector('.cat-rows'), null, 'no roster column: the section is the main column');
    assert.match(app.document.querySelector('main.mid')?.textContent ?? '', /kiro[\s\S]*1\.2\.3/u);
    row.click(); await settle(app);
    assert.deepEqual(current.checks, ['refresh'], 'choosing the open category again is not a new entry');
  } finally { await app.close(); }
});

test('desktop: a stored Backends category on a server known to lack the check falls back to Agents; caps unknown keeps it (#492 P1-B)', async context => {
  const old = capsServer([]);
  let app = await (await compiled).mount(context, {
    props: { visible: true }, modules: [old.modules],
    setup(window) { window.localStorage.setItem('tmux_agents_cat', 'backends'); },
  });
  try {
    await settle(app);
    assert.equal(app.document.querySelector('.sidebar .side-row.open .r-name')?.textContent, 'Agents', 'the existing invalid-category fallback');
    assert.equal(app.document.querySelector('.backends'), null, 'no empty page');
    assert.deepEqual(old.checks, []);
  } finally { await app.close(); }
  const s = capsServer(['backends_check']);
  app = await (await compiled).mount(context, {
    props: { visible: true }, modules: [s.modules],
    setup(window) { window.localStorage.setItem('tmux_agents_cat', 'backends'); },
  });
  try {
    await settle(app);
    assert.deepEqual(s.checks, ['refresh'], 'a stored category on screen is an entry');
    await s.set(app, undefined);
    assert.ok(categories(app).includes('Backends'), 'a reconnect keeps the category');
    assert.match(app.document.querySelector('.backends')?.textContent ?? '', /Waiting for the connection to check\.[\s\S]*kiro[\s\S]*1\.2\.3/u,
      'and its last results, said to be waiting');
    await s.set(app, ['backends_check']);
    assert.deepEqual(s.checks, ['refresh'], 'and nothing re-runs by itself');
    await s.set(app, []);
    assert.ok(!categories(app).includes('Backends'), 'now known to lack it: no entry');
    assert.equal(app.document.querySelector('.sidebar .side-row.open .r-name')?.textContent, 'Agents');
  } finally { await app.close(); }
});

test('phone: the Backends section is the section alone, its path selectable on the row, one Refresh when shown (#492)', async context => {
  const s = capsServer(['backends_check']);
  const app = await (await compiled).mount(context, { props: { visible: false, section: 'backends' }, modules: [s.modules] });
  try {
    await settle(app);
    assert.deepEqual(s.checks, [], 'a hidden page has not been entered');
    await app.setProps({ visible: true }); await settle(app);
    assert.deepEqual(s.checks, ['refresh']);
    assert.ok(app.document.querySelector('.agents-root.solo'), 'one column: no roster sidebar beside it');
    assert.equal(app.document.querySelector('.backends')?.closest('.page-head'), null);
    assert.equal(app.document.querySelector('main.mid .page-head'), null, 'Settings owns the head on the phone');
    assert.equal(app.document.querySelector('.fact-path')?.textContent, '/home/u/.local/bin/kiro-cli');
  } finally { await app.close(); }
});

// Board #511 P3: the model field's label, Retry and request scoping.
const modelField = (app: App) => app.document.querySelector<HTMLInputElement>('.editor input[aria-label="Model"]')!;
const hints = (app: App) => [...app.document.querySelectorAll('.editor .hint')].map((p) => p.textContent ?? '');
const answer = (extra: Record<string, unknown> = {}) => ({ backend: 'codex', models: ['m1', 'm2'], kind: 'authoritative', complete: true,
  list_reason: null, default: 'gpt-base', default_reason: null, ...extra });

test('the empty model field wears the baseline default, and a stored model is never replaced by it (#511)', async context => {
  const stored = { ...alpha, name: 'beta', model: 'my-pin' };
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    registryList: async () => ({ agents: [alpha, stored] }),
    modelsList: async () => answer(),
  })] });
  try {
    await openAgent(app);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).value, '', 'the field stays empty');
    assert.equal(modelField(app).placeholder, 'default: gpt-base', 'only the label says the default');
    await openAgent(app, 'beta');
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).value, 'my-pin', 'a stored model is kept as stored');
  } finally { await app.close(); }
});

test('a failed model list offers Retry, a list that does not exist does not (#511)', async context => {
  let calls = 0;
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    modelsList: async () => { calls++; if (calls === 1) throw new Error('lost'); return answer(); },
  })] });
  try {
    await openAgent(app);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.ok(hints(app).some((h) => h.includes('could not be read')), `failure said: ${hints(app)}`);
    assert.equal(modelField(app).placeholder, 'default unknown', 'a failure is not an empty catalogue with a default');
    command(app, 'Retry').click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(calls, 2, 'Retry asked again');
    assert.ok(!hints(app).some((h) => h.includes('could not be read')), 'and the failure is gone');
    assert.equal(modelField(app).placeholder, 'default: gpt-base');
  } finally { await app.close(); }

  const none = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    modelsList: async () => answer({ models: null, kind: null, list_reason: 'not_listed', default: 'deepseek-flash' }),
  })] });
  try {
    await openAgent(none);
    for (let i = 0; i < 4; i++) await none.flush();
    assert.equal(none.document.querySelector('.editor [aria-label="Retry"]'), null, 'no list is a fact: no Retry');
    assert.equal(modelField(none).placeholder, 'default: deepseek-flash', 'the default survives without a list');
  } finally { await none.close(); }

  const old = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    modelsList: async () => ({ backend: 'codex', models: ['m1'] }),
  })] });
  try {
    await openAgent(old);
    for (let i = 0; i < 4; i++) await old.flush();
    assert.equal(modelField(old).placeholder, 'backend default', 'an older server: the generic label');
    assert.equal(old.document.querySelector('.editor [aria-label="Retry"]'), null);
  } finally { await old.close(); }
});

test('a late answer after switching backend lands on its own backend, never on the one shown (#511)', async context => {
  const pending: Record<string, (r: unknown) => void> = {};
  const kiroDef = { ...alpha, name: 'beta', backend: 'kiro' };
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    registryList: async () => ({ agents: [alpha, kiroDef] }),
    modelsList: (backend: string) => new Promise((resolve) => { pending[backend] = resolve; }),
  })] });
  try {
    await openAgent(app);            // codex: asked, unanswered
    await openAgent(app, 'beta');    // kiro: asked, unanswered
    for (let i = 0; i < 4; i++) await app.flush();
    pending.codex!(answer({ default: 'codex-base' }));   // the late answer
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'backend default', 'codex\'s answer does not paint kiro\'s field');
    pending.kiro!(answer({ backend: 'kiro', default: null, default_reason: 'not_derivable' }));
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'backend default', 'kiro has no derivable default');
    await openAgent(app);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'default: codex-base', 'and codex kept its own answer');
  } finally { await app.close(); }
});

// P3 review P1-A: a default that could not be read is its own failure beside a
// good list, with Retry, and never the generic "backend default".
test('a default that could not be read beside a good list says so and offers Retry (#511)', async context => {
  let calls = 0;
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    modelsList: async () => { calls++; return calls === 1 ? answer({ default: null, default_reason: 'unreadable' }) : answer(); },
  })] });
  try {
    await openAgent(app);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'default unknown');
    assert.ok(hints(app).some((h) => h.includes('default model this server would start')), `the default's failure: ${hints(app)}`);
    assert.ok(!hints(app).some((h) => h.includes('model list could not be read')), 'the list itself is fine');
    command(app, 'Retry').click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(calls, 2, 'Retry asked again');
    assert.equal(modelField(app).placeholder, 'default: gpt-base');
    assert.equal(app.document.querySelector('.editor [aria-label="Retry"]'), null);
  } finally { await app.close(); }
});

// P3 review P2-C: a new visit to the editor reads the default afresh; it is
// never kept as a startup fact for the page's life.
test('a new editor visit reads the models afresh, and the field stays empty (#511)', async context => {
  let baseline = 'first';
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({
    modelsList: async () => answer({ default: baseline }),
  })] });
  try {
    await openAgent(app);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'default: first');
    baseline = 'second';
    await openAgent(app, 'beta');
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(modelField(app).placeholder, 'default: second', 'the next visit asked again');
    assert.equal(modelField(app).value, '', 'and the label is never written into the field');
  } finally { await app.close(); }
});

// P3 review P1-B: a team member's model field gets the same notes and Retry.
// A derived member's empty field inherits its BASE definition, so it never
// wears the backend's baseline and the default's failure is not its fact.
test('team members show a failed or cut model list with Retry, and a derived member still inherits (#511)', async context => {
  const team = { name: 'squad', description: '', members: JSON.stringify([
    { name: 'raw', base: '', role: 'Raw', agent: { name: 'raw', backend: 'kiro', model: '', effort: '', input_mode: 'queue', system: 'Bare.', skills: '[]', mcp: '[]' } },
    { name: 'dev', base: 'alpha', role: 'Implement', model: 'pinned' },
    { name: 'rev', base: 'alpha', role: 'Review' },
  ]) };
  const calls: Record<string, number> = {};
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'teams' }, modules: [rpc({
    teamsList: async () => ({ teams: [team] }),
    modelsList: async (backend: string) => {
      calls[backend] = (calls[backend] ?? 0) + 1;
      if (calls[backend] === 1) throw new Error('lost');
      return backend === 'kiro'
        ? answer({ backend, kind: 'suggestions', complete: false, list_reason: 'overflow', default: 'k-base' })
        : answer({ backend, default: null, default_reason: 'unreadable' });
    },
  })] });
  const body = (i: number) => app.document.querySelectorAll<HTMLElement>('.member')[i]!;
  const notes = (i: number) => [...body(i).querySelectorAll('.hint')].map((h) => h.textContent ?? '');
  const field = (i: number) => body(i).querySelector<HTMLInputElement>('input[aria-label="Model"]')!;
  const open = async (i: number) => { app.document.querySelectorAll<HTMLButtonElement>('.member-summary')[i]!.click(); await app.flush(); };
  try {
    await openAgent(app, 'squad');
    for (let i = 0; i < 4; i++) await app.flush();
    // The bare member: both facts failed with the call.
    assert.ok(notes(0).some((h) => h.includes('model list could not be read')), `bare failure: ${notes(0)}`);
    assert.equal(field(0).placeholder, 'default unknown');
    body(0).querySelector<HTMLButtonElement>('[aria-label="Retry"]')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(calls.kiro, 2, 'Retry asked again');
    assert.ok(notes(0).some((h) => h.includes('Only part of the declared models')), `cut list said: ${notes(0)}`);
    assert.equal(field(0).placeholder, 'default: k-base');
    // The derived members: the same list failure and Retry, but the field inherits.
    await open(1);
    assert.ok(notes(1).some((h) => h.includes('model list could not be read')), `derived failure: ${notes(1)}`);
    assert.equal(field(1).value, 'pinned', 'a stored override is kept');
    body(1).querySelector<HTMLButtonElement>('[aria-label="Retry"]')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(calls.codex, 2);
    assert.deepEqual(notes(1).filter((h) => h.includes('could not be read')), [], 'the backend default is not a derived member\'s fact');
    assert.equal(body(1).querySelector('[aria-label="Retry"]'), null);
    await open(2);
    assert.equal(field(2).value, '', 'an empty override stays empty');
    assert.equal(field(2).placeholder, 'same as base', 'and inherits its base, never the backend default');
  } finally { await app.close(); }
});

// Board #7 (owner 2026-11-05 05:43): harness defaults, the one divider, then
// custom agents; an agent whose harness this server cannot run is greyed,
// says why in words, and still opens. Grouping and availability are the
// server's (registry_list); this pins how the page shows them.
const listed = [
  { ...alpha, name: 'kiro', backend: 'kiro', group: 'default', availability: { state: 'available' } },
  { ...alpha, name: 'grok', backend: 'grok', group: 'default', availability: { state: 'unavailable', reason: 'not_found', missing: [] } },
  { ...alpha, name: 'dsh', backend: 'dsh', group: 'default', availability: { state: 'unavailable', reason: 'not_found', missing: [] } },
  { ...alpha, name: 'pentester', backend: 'kiro', group: 'custom', availability: { state: 'available' } },
];
async function groupedList(app: App) {
  for (let i = 0; i < 12 && !app.document.querySelector('.agent-group'); i++) await app.flush();
  const groups = [...app.document.querySelectorAll('.agent-group')];
  return groups.map((g) => ({
    head: g.querySelector('.side-h')?.textContent?.trim(),
    rows: [...g.querySelectorAll('.side-row:not(.add)')].map((r) => r.querySelector('.r-name')?.textContent),
  }));
}
for (const layout of ['desktop', 'compact'] as const) {
  test(`the Agents list shows harness defaults, a divider, then custom agents, greying an unusable harness in words (${layout}, #7)`, async context => {
    const app = await (await compiled).mount(context, {
      props: layout === 'compact' ? { visible: true, section: 'agents' } : { visible: true },
      modules: [rpc({ registryList: async () => ({ agents: listed }) })],
      setup(window) {
        if (layout !== 'compact') return;
        const match = window.matchMedia;
        window.matchMedia = query => Object.assign(match(query), { matches: query === '(max-width: 760px)' });
      },
    });
    try {
      assert.deepEqual(await groupedList(app), [
        { head: 'Harness defaults', rows: ['kiro', 'grok', 'dsh'] },
        { head: 'Custom agents', rows: ['pentester'] },
      ]);
      const custom = app.document.querySelectorAll('.agent-group')[1]!;
      assert.ok(custom.classList.contains('divided'), 'the custom group opens with the divider');
      const row = (name: string) => [...app.document.querySelectorAll<HTMLButtonElement>('.agent-group .side-row')].find((r) => r.querySelector('.r-name')?.textContent === name)!;
      // Board #84 (owner 2026-11-08 16:04): greyed in its row, ONE line high
      // like every other row; the reason stays in words as the row's title
      // and as a hint in its editor (#7: not colour alone).
      assert.ok(row('grok').classList.contains('unavailable'));
      assert.equal(row('grok').querySelector('.r-sub'), null, 'no second line');
      assert.equal(row('grok').querySelector('.r-dot'), null, 'no extra dot');
      assert.equal(row('grok').title, 'Unavailable: grok not on the managed PATH', 'the reason in words, not colour alone');
      assert.ok(!row('kiro').classList.contains('unavailable'));
      assert.equal(row('kiro').querySelector('.r-sub'), null);
      assert.equal(row('kiro').title, '', 'an available row carries no reason');
      // Unavailable is still readable: its definition opens, and says why.
      row('grok').click(); await app.flush();
      assert.ok(app.document.querySelector('.editor'), 'an unavailable definition still opens');
      assert.ok([...app.document.querySelectorAll('.editor .hint')].some((h) => h.textContent?.trim() === 'Unavailable: grok not on the managed PATH'), 'the editor says why');
      row('kiro').click(); await app.flush();
      assert.ok(![...app.document.querySelectorAll('.editor .hint')].some((h) => h.textContent?.includes('Unavailable')), 'an available definition shows no reason');
    } finally { await app.close(); }
  });
}

// Board #84 (owner 2026-11-08 16:04): a harness default keeps its backend.
// Its editor shows the backend greyed (the server refuses a change too);
// a custom agent's backend stays a choice.
test('a harness default shows its backend greyed; a custom agent keeps the choice (#84)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({ registryList: async () => ({ agents: listed }) })] });
  try {
    await groupedList(app);
    const row = (name: string) => [...app.document.querySelectorAll<HTMLButtonElement>('.agent-group .side-row')].find((r) => r.querySelector('.r-name')?.textContent === name)!;
    const backend = () => app.document.querySelector<HTMLButtonElement>('.editor [aria-label="Backend"]')!;
    row('kiro').click(); await app.flush();
    assert.equal(backend().disabled, true, 'a harness default stays on its backend');
    assert.match(backend().textContent ?? '', /kiro/u, 'and shows it');
    assert.equal(app.document.querySelector<HTMLInputElement>('.editor input.config-input')!.readOnly, true, 'name read-only as before');
    row('pentester').click(); await app.flush();
    assert.equal(backend().disabled, false, 'a custom agent can move');
  } finally { await app.close(); }
});

// Board #84 round 1 (reviewer note 9, orchestrator ruling note 11): the
// editor's reason is a statement about the LISTED definition's backend, read
// from the listed row, never from the draft. A custom agent moved to another
// backend shows none until saved and re-listed; a report that lands while
// the editor is open shows it without reopening.
test('the editor says why only for the listed backend, and follows the list (#84 round 1)', async context => {
  const grokker = { ...alpha, name: 'grokker', backend: 'grok', group: 'custom', availability: { state: 'unavailable', reason: 'not_found', missing: [] } };
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc({ registryList: async () => ({ agents: [...listed, grokker] }) })] });
  try {
    await groupedList(app);
    const row = (name: string) => [...app.document.querySelectorAll<HTMLButtonElement>('.agent-group .side-row')].find((r) => r.querySelector('.r-name')?.textContent === name)!;
    const why = () => [...app.document.querySelectorAll('.editor .hint')].map((h) => h.textContent?.trim()).filter((h) => h?.startsWith('Unavailable'));
    const pick = async (b: string) => {
      app.document.querySelector<HTMLButtonElement>('.editor [aria-label="Backend"]')!.click(); await app.flush();
      [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) => o.textContent?.trim() === b)!.click(); await app.flush();
    };
    row('grokker').click(); await app.flush();
    assert.deepEqual(why(), ['Unavailable: grok not on the managed PATH']);
    await pick('kiro');
    assert.deepEqual(why(), [], 'kiro is not what the server found unusable');
    await pick('grok');
    assert.deepEqual(why(), ['Unavailable: grok not on the managed PATH'], 'back on the listed backend');
  } finally { await app.close(); }
});

test('a report that lands while an editor is open shows its reason there (#84 round 1)', async context => {
  let landed = false;
  let release!: () => void;
  const unknown = listed.map((d) => ({ ...d, availability: { state: 'unknown' } }));
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({
      registryList: async () => ({ agents: landed ? listed : unknown }),
      backendsCheck: () => new Promise<void>((ok) => { release = () => { landed = true; ok(); }; }),
    })],
  });
  try {
    await groupedList(app);
    const grok = () => [...app.document.querySelectorAll<HTMLButtonElement>('.agent-group .side-row')].find((r) => r.querySelector('.r-name')?.textContent === 'grok')!;
    const why = () => [...app.document.querySelectorAll('.editor .hint')].map((h) => h.textContent?.trim()).filter((h) => h?.startsWith('Unavailable'));
    grok().click(); await app.flush();
    assert.deepEqual(why(), [], 'unknown says nothing');
    release();
    for (let i = 0; i < 12 && !grok().classList.contains('unavailable'); i++) await app.flush();
    assert.deepEqual(why(), ['Unavailable: grok not on the managed PATH'], 'the open editor follows the re-list');
  } finally { await app.close(); }
});

test('an older server names no group: the flat list stays, with no headings (#7)', async context => {
  const app = await (await compiled).mount(context, { props: { visible: true, section: 'agents' }, modules: [rpc()] });
  try {
    await openAgent(app);
    assert.equal(app.document.querySelector('.agent-group'), null);
  } finally { await app.close(); }
});

// Board #7 round 2 (reviewer 08:57, orchestrator D2: "the page updates when it
// lands"): an Agents page opened on a server that has not checked yet reads
// every agent as unknown, waits for the server's ONE in-flight check
// (backends_check {first}), and greys by itself when it lands: no reload, no
// visibility change, no second probe.
test('an open Agents page greys an unusable harness when the first background check lands, by itself (#7 round 2)', async context => {
  let landed = false;
  let release!: () => void;
  const firstCalls: unknown[] = [];
  let lists = 0;
  const unknown = listed.map((d) => ({ ...d, availability: { state: 'unknown' } }));
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({
      registryList: async () => { lists++; return { agents: landed ? listed : unknown }; },
      backendsCheck: (...args: unknown[]) => { firstCalls.push(args); return new Promise<void>((ok) => { release = () => { landed = true; ok(); }; }); },
    })],
  });
  try {
    const grok = () => [...app.document.querySelectorAll<HTMLButtonElement>('.agent-group .side-row')].find((r) => r.querySelector('.r-name')?.textContent === 'grok');
    for (let i = 0; i < 12 && !grok(); i++) await app.flush();
    assert.ok(grok(), 'the grouped list is shown');
    assert.ok(!grok()!.classList.contains('unavailable'), 'unknown greys nothing');
    assert.equal(firstCalls.length, 1, 'the page waits for the one check');
    assert.equal(JSON.stringify(firstCalls[0]), '[{"first":true}]', 'through backends_check {first}');
    const before = lists;
    release();
    for (let i = 0; i < 12 && !grok()?.classList.contains('unavailable'); i++) await app.flush();
    assert.ok(grok()!.classList.contains('unavailable'), 'greyed when the check lands, with nothing else happening');
    assert.equal(lists, before + 1, 'one re-list');
    assert.equal(firstCalls.length, 1, 'and no second wait');
  } finally { await app.close(); }
});

test('a page whose list is already decided waits for nothing (#7 round 2)', async context => {
  let firstCalls = 0;
  const app = await (await compiled).mount(context, {
    props: { visible: true, section: 'agents' },
    modules: [rpc({ registryList: async () => ({ agents: listed }), backendsCheck: async () => { firstCalls++; } })],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.agent-group'); i++) await app.flush();
    await app.flush();
    assert.equal(firstCalls, 0);
  } finally { await app.close(); }
});

test('omp’s own tools are one switch, shown only for omp, off by default, saved when turned on (#72)', async context => {
  const fixture = await hostFixture();
  const served = (name: string) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes: false });
  const writes: any[] = [];
  const app = await fixture.mount(context, {
    props: { ready: () => {}, backends: [served('omp'), served('claude')] },
    modules: [rpc({
      registryList: async () => ({ agents: [{ ...alpha, name: 'om', backend: 'omp' }, { ...alpha, name: 'cc', backend: 'claude' }] }),
      registrySave: async (value: unknown) => { writes.push(value); },
      getCaps: () => ['mcp_masked', 'omp_tools'],
    })],
  });
  const sw = () => app.document.querySelector<HTMLButtonElement>('[role=switch][aria-label^="omp’s own tools"]');
  try {
    await openAgent(app, 'cc');
    assert.equal(sw(), null, 'claude: no switch');
    command(app, 'Cancel').click(); await app.flush();
    await openAgent(app, 'om');
    assert.equal(sw()?.getAttribute('aria-checked'), 'false', 'off by default');
    sw()!.click(); await app.flush();
    assert.equal(sw()?.getAttribute('aria-checked'), 'true');
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    assert.equal(writes[0]?.omp_tools, true);
  } finally { await app.close(); }
});

test('a server that does not keep omp\u2019s own-tools switch is not offered it, and says to update (#72 R1)', async context => {
  const fixture = await hostFixture();
  const app = await fixture.mount(context, {
    props: { ready: () => {}, backends: [{ name: 'omp', icon: '/assets/omp.svg', color: '--backend-omp', efforts: [], input_modes: false }] },
    modules: [rpc({ registryList: async () => ({ agents: [{ ...alpha, name: 'om', backend: 'omp' }] }), getCaps: () => ['mcp_masked'] })],
  });
  try {
    await openAgent(app, 'om');
    assert.equal(app.document.querySelector('[role=switch][aria-label^="omp\u2019s own tools"]'), null, 'no switch the server would drop');
    assert.ok([...app.document.querySelectorAll('.editor .hint')].some(h => /older than the app.*omp\u2019s own tools/u.test(h.textContent ?? '')), 'it says why');
  } finally { await app.close(); }
});

test('an inline omp member keeps its stored own-tools switch through an unrelated edit (#72 R1)', async context => {
  const fixture = await hostFixture();
  const writes: any[] = [];
  const team = { name: 'squad', description: '', members: JSON.stringify([
    { name: 'raw', base: '', role: 'Raw', agent: { name: 'raw', backend: 'omp', model: '', effort: '', input_mode: 'queue', omp_tools: true, system: 'Bare.', skills: '[]', mcp: '[]' } },
  ]) };
  let controls!: { section: (value: string) => void };
  const app = await fixture.mount(context, {
    props: { ready: (value: typeof controls) => controls = value, backends: [{ name: 'omp', icon: '/assets/omp.svg', color: '--backend-omp', efforts: [], input_modes: false }] },
    modules: [rpc({ teamsList: async () => ({ teams: [team] }), teamsSave: async (value: any) => { writes.push(value); return {}; }, getCaps: () => ['mcp_masked', 'omp_tools'] })],
  });
  try {
    controls.section('teams'); await app.flush();
    await openAgent(app, 'squad');
    assert.equal(app.document.querySelector('[role=switch][aria-label^="omp’s own tools"]')?.getAttribute('aria-checked'), 'true', 'the stored on is shown');
    const role = app.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('.member [aria-label="Role"], .member textarea');
    assert.ok(role, 'a role field');
    role!.value = 'Raw, edited'; role!.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    command(app, 'Save').click();
    for (let i = 0; i < 5 && !writes.length; i++) await app.flush();
    assert.equal(JSON.parse(writes[0].members)[0].agent.omp_tools, true, 'an unrelated edit never turns it off');
  } finally { await app.close(); }
});
