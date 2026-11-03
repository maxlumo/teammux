import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import type { ProjectRow } from '../projects/projects.ts';
import type { SidebarPane } from './sidebar.ts';

const compiled = compileMount(new URL('./Sidebar.svelte', import.meta.url), [], { serverScope: true });

test('a live row whose session has two same-named agent windows mounts with both chips', async (context) => {
  // 2026-11-03, owner report: an adopted session with two windows tmux named
  // `omp` threw each_key_duplicate on load and nothing in the app responded.
  const rows: ProjectRow[] = [{
    project: {
      id: 'p0', session: '0', name: '0', path: '/w', created_at: 1, last_seen_at: 1,
      adopted: true, autostart: false, archived: false,
    },
    live: true, slots: [],
  }];
  const pane = (window: number, window_name: string, agent: string): SidebarPane =>
    ({ session: '0', window, window_name, active: true, current_command: agent, agent });
  const app = await (await compiled).mount(context, {
    props: {
      rows, selected: '0', tick: 1_800_000_000_000, talkMap: {}, agentStates: {},
      panes: [pane(0, 'omp', 'omp'), pane(1, 'omp', 'omp'), pane(2, 'zsh', '')],
    },
    modules: [],
    setup(win) {
      win.Element.prototype.getAnimations = () => [];
      win.Element.prototype.animate = function () { return { cancel() {}, finish() {}, onfinish: null, finished: Promise.resolve() } as unknown as Animation; };
    },
  });
  try {
    const names = [...app.document.querySelectorAll('.proj-row .side-win-name')].map((el) => el.textContent);
    assert.deepEqual(names, ['omp', 'omp']);
  } finally { await app.close(); }
});
