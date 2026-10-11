import { mount, tick, unmount } from 'svelte';
import '../../app.css';
import GitPanel from './GitPanel.test.svelte';

type Reply = { code: number; stdout: string; stderr: string };
const requests: { subcmd: string; args: string[]; cwd: string; resolve: (reply: Reply) => void }[] = [];
const errors: string[] = [];
const ok = (stdout = ''): Reply => ({ code: 0, stdout, stderr: '' });
function fail(message: string): never { errors.push(message); throw Error(message); }
let update!: (props: Record<string, unknown>) => void;
Object.assign(window, { gitFixture: {
  requests, errors,
  async gitCmd(subcmd: string, args: string[], cwd: string) {
    if (subcmd === 'rev-parse') return ok('/repo\n');
    if (subcmd === 'branch') return ok('main\n');
    if (subcmd === 'status') return ok(' M first.txt\nM  second.txt\n');
    if (subcmd === 'log') return ok('abc123|subject|today|author\n');
    if (!['add', 'restore', 'push', 'commit'].includes(subcmd)) fail(`Unexpected git verb: ${subcmd}`);
    return new Promise<Reply>(resolve => requests.push({ subcmd, args, cwd, resolve }));
  },
  complete(index: number, stdout: string, stderr = '') {
    requests[index]!.resolve({ code: stderr ? 1 : 0, stdout, stderr });
  },
  update(next: Record<string, unknown>) { update(next); },
  async settle() { for (let i = 0; i < 12; i++) await tick(); },
} });
window.fetch = () => fail('Unexpected fetch');
window.addEventListener('error', event => errors.push(String(event.error)));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
localStorage.setItem('tmux_locale', 'en');
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';
Object.assign(document.body.style, { display: 'flex', flexDirection: 'column', height: '100vh' });
// GitPanel reads its server from its scope (board #335 ②b); the scope speaks
// through whatever `core/ws.ts` resolves to in this build — the controlled
// transport.
const { testScopeContext } = await import('../test/server-scope-host.ts');
const scopeContext = testScopeContext(await import('../core/ws.ts'));
const app = mount(GitPanel, { target: document.body, context: scopeContext, props: {
  cwd: '/repo', onOpenFile() {}, onClose() {},
  register: (fn: typeof update) => { update = fn; },
} });
window.addEventListener('pagehide', () => { void unmount(app); }, { once: true });
