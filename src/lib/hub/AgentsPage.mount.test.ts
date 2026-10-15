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
