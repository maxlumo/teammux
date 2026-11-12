import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #109 S6 (validator note 22, leader's ruling): the Dashboard's agent
// landing is bound to {server, session, agent} from the tap. It waits for THAT
// room's roster; a room change voids it, with no replay on return.
const compiled = compileMount(new URL('./Hub.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
async function flush(app: App) { for (let i = 0; i < 20; i++) await app.flush(); }

test('a landing for fixture/alice never filters another room, and is not replayed on return (#109 S6)', async (context) => {
  let release!: () => void;
  const alice = { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' };
  const modules = {
    projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({ project: { id: session, session, name: session, path: `/${session}` }, live: true, slots: [] })) }),
    listSessionsWithPanes: async () => ({ panes: [] }),
    hubRooms: async () => ({ rooms: {}, states: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }),
    registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }),
    // fixture's first roster is held; other has an alice of its own.
    hubAgents: async (s: string) => (s === 'fixture' && !release
      ? new Promise((ok) => { release = () => ok({ agents: [alice] }); })
      : { agents: s === 'fixture' ? [alice] : [alice, { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle' }] }),
    hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    addAgentRenamedListener: () => undefined, removeAgentRenamedListener: () => undefined,
    getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team'], onCaps: () => undefined,
  };
  const app = await (await compiled).mount(context, {
    props: { visible: true, selectRequest: { serverId: 'test', session: 'fixture', agent: 'alice', n: 1 } },
    setup(w: any) { w.Element.prototype.getAnimations = () => []; w.localStorage.setItem('tmux_hub_project', 'fixture'); w.localStorage.setItem('tmux_locale', 'en'); },
    modules: [modules],
  });
  try {
    await flush(app);
    assert.equal(app.document.querySelector('.filter-face'), null, 'fixture s roster has not answered');
    app.document.querySelector<HTMLElement>('[aria-label="other"] .proj-pick')!.click(); await flush(app);
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'other');
    assert.equal(app.document.querySelector('.filter-face'), null, 'never filter OTHER for a landing to fixture');
    release(); await flush(app);
    app.document.querySelector<HTMLElement>('[aria-label="fixture"] .proj-pick')!.click(); await flush(app);
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'fixture');
    assert.equal(app.document.querySelector('.filter-face'), null, 'the voided landing is not replayed on return');
  } finally { await app.close(); }
});

test('a focus move voids the landing, even on the same server and session; no replay on return (#109 S6)', async (context) => {
  let release!: () => void;
  const modules = {
    projectList: async () => ({ projects: [{ project: { id: 'fixture', session: 'fixture', name: 'fixture', path: '/fixture' }, live: true, slots: [] }] }),
    listSessionsWithPanes: async () => ({ panes: [] }),
    hubRooms: async () => ({ rooms: {}, states: {} }), hubUnread: async () => ({ rooms: {} }), hubRead: async () => ({ rooms: {} }),
    registryList: async () => ({ agents: [] }), teamsList: async () => ({ teams: [] }),
    hubAgents: async () => new Promise((ok) => { release = () => ok({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' }] }); }),
    hubLog: async () => ({ messages: [], has_more: false }), hubActivity: async () => ({ events: [], has_more: false }),
    addTeamMessageListener: () => undefined, removeTeamMessageListener: () => undefined,
    addAgentRenamedListener: () => undefined, removeAgentRenamedListener: () => undefined,
    getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team'], onCaps: () => undefined,
  };
  const app = await (await compiled).mount(context, {
    props: { visible: true, selectRequest: { serverId: 'test', session: 'fixture', agent: 'alice', n: 1 } },
    setup(w: any) { w.Element.prototype.getAnimations = () => []; w.localStorage.setItem('tmux_hub_project', 'fixture'); w.localStorage.setItem('tmux_locale', 'en'); },
    modules: [modules],
  });
  try {
    await flush(app);
    await app.setScope({ eligible: false }); await app.setProps({ visible: false }); await flush(app);
    release(); await flush(app);
    await app.setScope({ eligible: true }); await app.setProps({ visible: true }); await flush(app);
    assert.equal(app.document.querySelector('.filter-face'), null, 'void once focus leaves; no replay when it returns');
  } finally { await app.close(); }
});
