export const DEV_WEB_PORT = 5173;
export const DEV_SERVER_PORT = 9899;
export const DEV_WS_PATH = '/ws';
export const DEV_DOWNLOAD_PATH = '/dl';
export const DEV_SERVER_PORT_ENV = 'TMUX_MOBILE_DEV_SERVER_PORT';

export function devServerPort(env = process.env) {
  const raw = env[DEV_SERVER_PORT_ENV] || env.PORT || String(DEV_SERVER_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid internal dev server port: ${raw}`);
  }
  return port;
}

export function devServerTargets(env = process.env) {
  const port = devServerPort(env);
  return {
    ws: `ws://127.0.0.1:${port}`,
    http: `http://127.0.0.1:${port}`,
  };
}

// Where the Vite dev server listens (board #393, security review). LOOPBACK by
// default: the only intended path to it from outside this host is the reverse
// SSH tunnel, which dials 127.0.0.1, and a 0.0.0.0 listener was reachable from
// the whole security group — it served `.tmm/agents/*/launch.json` (agents'
// environments) and `temp/` in the clear, measured. A person who wants the dev
// server on the LAN says so: `TMUX_MOBILE_DEV_HOST=0.0.0.0 npm run dev:all`
// (`TAURI_DEV_HOST` is Tauri's own name for mobile dev and is honoured too).
export const DEV_HOST_ENV = 'TMUX_MOBILE_DEV_HOST';
export const DEV_HOST_DEFAULT = '127.0.0.1';

export function devHost(env = process.env) {
  return String(env[DEV_HOST_ENV] ?? '').trim() || String(env.TAURI_DEV_HOST ?? '').trim() || DEV_HOST_DEFAULT;
}
