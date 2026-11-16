// Board #144 through the real Hub wiring: a bubble's relative path link carries its ORIGINAL
// reference and session to Files, so Files' not-found asks fs_find_tail for exactly that.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

let compilation: ReturnType<typeof compileMount> | undefined;
const compiledHub = () => compilation ??= compileMount(new URL('./Hub.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
], { serverScope: true });

function roomFixture() {
  return {
    rpc: {
      projectList: async () => ({ projects: [{ project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' }, live: true, slots: [] }] }),
      listSessionsWithPanes: async () => ({ panes: [] }),
      hubRooms: async () => ({ rooms: {}, states: {} }),
      hubUnread: async () => ({ rooms: {} }),
      hubRead: async () => ({ rooms: {} }),
      registryList: async () => ({ agents: [] }),
      teamsList: async () => ({ teams: [] }),
      hubAgents: async () => ({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' }] }),
      hubLog: async () => ({ messages: [], has_more: false }),
      hubActivity: async () => ({ events: [], has_more: false }),
      addTeamMessageListener: () => undefined,
      removeTeamMessageListener: () => undefined,
      addAgentRenamedListener: () => undefined,
      removeAgentRenamedListener: () => undefined,
      getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team'],
      onCaps: () => undefined,
    },
  };
}

test('a bubble\'s relative path the project root lacks is searched with its original reference (#144)', { timeout: 60000 }, async (context) => {
  const { rpc } = roomFixture();
  const asked: string[][] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: false },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_sidebar', '1');
      window.ResizeObserver = class { cb: (e: unknown[]) => void; constructor(cb: (e: unknown[]) => void) { this.cb = cb; } observe(el: Element) { this.cb([{ target: el, contentRect: { width: 1234, height: 700 } }]); } unobserve() {} disconnect() {} } as never;
    },
    modules: [{
      ...rpc,
      getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team', 'path_find'],
      hubLog: async () => ({ messages: [{ seq: 1, id: 'm1', ts: 1800000000000, from: 'alice', to: ['human'], body: 'see [the shot](temp/111/out.png)', room: 'proj:fixture', kind: 'msg' }], has_more: false }),
      fsStat: async (path: string) => { throw new Error(`No such file or directory (os error 2): ${path}`); },
      fsFindTail: async (session: string, ref: string) => { asked.push([session, ref]); return { root: '/fixture', matches: [], more: false }; },
      fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }), getPrefs: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }),
    }],
  });
  const settle = async () => { for (let i = 0; i < 16; i++) await app.flush(); };
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.bubble a'); i++) await app.flush();
    const link = app.document.querySelector<HTMLAnchorElement>('.bubble a')!;
    assert.ok(link, 'the bubble renders the path link');
    link.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); await settle();
    assert.deepEqual(asked, [['fixture', 'temp/111/out.png']], 'the original reference, the bubble\'s session');
  } finally { await app.close(); }
});
