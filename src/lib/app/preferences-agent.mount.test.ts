import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Through the host that gives the embedded editor its guest scope, as App
// does (board #335 ②b-3): the editor's RPCs are that scope's.
const compiled = compileMount(new URL('./Preferences.test.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)]);
const alpha = { name: 'alpha', backend: 'codex', model: '', system: 'Original', skills: '[]', mcp: '[]' };
const rpc = {
  registryList: async () => ({ agents: [alpha] }),
  teamsList: async () => ({ teams: [] }), skillsList: async () => ({ skills: [] }),
  mcpList: async () => ({ mcp: [] }), modelsList: async () => ({ models: [] }),
};
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function edit(app: App) {
  for (let i = 0; i < 8; i++) await app.flush();
  const row = [...app.document.querySelectorAll<HTMLButtonElement>('.agents-embed .side-row')]
    .find(button => button.querySelector('.r-name')?.textContent === 'alpha');
  assert.ok(row); row.click(); await app.flush();
  const prompt = app.document.querySelector<HTMLTextAreaElement>('.editor textarea')!;
  prompt.value = 'Unsaved';
  prompt.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
}
function category(app: App, name: string) {
  const button = [...app.document.querySelectorAll<HTMLButtonElement>('.preferences > .sidebar .side-row')]
    .find(button => button.textContent?.trim() === name);
  assert.ok(button); button.click();
}

test('real Settings and Agent share one confirmation when changing an edited category (#156)', async context => {
  const app = await (await compiled).mount(context, {
    props: { showAgents: true }, modules: [rpc],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      // The font-availability sweep (#233) runs at mount; jsdom's canvas
      // fallback reports "not implemented" through the virtual console.
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  try {
    await edit(app);
    category(app, 'Teams'); await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    assert.ok(app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[aria-label="Discard"]')!.click();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'teams');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'an accepted section is not guarded a second time');
    assert.equal(app.document.querySelector('.editor'), null);
  } finally { await app.close(); }
});

test('real Settings defers its category exit until the Agent Save completes (#156)', async context => {
  let finish!: () => void;
  const app = await (await compiled).mount(context, {
    props: { showAgents: true },
    modules: [{ ...rpc, registrySave: () => new Promise<void>(yes => finish = yes) }],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'agents');
      window.HTMLCanvasElement.prototype.getContext = () => null; // see above
    },
  });
  try {
    await edit(app);
    app.document.querySelector<HTMLButtonElement>('[aria-label="Save"]')!.click(); await app.flush();
    category(app, 'Appearance'); await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    finish();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance');
    assert.equal(app.document.querySelector('.agents-embed'), null);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});
