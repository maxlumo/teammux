export type LocationLike = { protocol: string; host: string };

export const STANDALONE_WS_DEFAULT = 'ws://127.0.0.1:9899';

/** The address a fresh page starts with (a saved one always wins — the
 * caller only asks when nothing is saved). Vite dev: its own origin's /ws
 * proxy. A page the GATEWAY served (it carries `<meta name="tmm-gateway">`,
 * board #323): that gateway, on the same origin — host, port and ws/wss
 * all come from the page's own URL, never from anything in the HTML. */
export function defaultConnectionAddress(location: LocationLike, dev: boolean, hosted = false): string {
  if (!location.host) return STANDALONE_WS_DEFAULT;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (hosted && (location.protocol === 'http:' || location.protocol === 'https:')) return `${scheme}//${location.host}`;
  if (!dev) return STANDALONE_WS_DEFAULT;
  return `${scheme}//${location.host}/ws`;
}

/** Was this page served by a Teammux gateway? */
export function hostedByGateway(doc: { querySelector: (s: string) => unknown } | undefined): boolean {
  return !!doc?.querySelector('meta[name="tmm-gateway"]');
}

export type ConnectFieldsState = { address: string; token: string; socket: string };
export type LocalConfig = { url?: string; token?: string; tmux_socket?: string | null };

/** Is `addr` the local connection `localUrl` names? (a bare host:port
 * is read with the scheme `localUrl` uses; a trailing slash is ignored) */
export function isLocalTarget(addr: string, localUrl: string): boolean {
  if (!addr.trim() || !localUrl) return false;
  const proto = localUrl.startsWith('wss://') ? 'https:' : 'http:';
  return normalizeAddress(addr, proto).replace(/\/+$/, '') === localUrl.replace(/\/+$/, '');
}

/** What the desktop app may fill in from this machine's config (board
 * #323). The TARGET is decided first: a saved address, else one the person
 * typed while the config loaded, else this machine's own `url`. The
 * address is filled only when nothing is saved and nobody changed it. The
 * local token and socket belong to the LOCAL gateway, so they are filled
 * only when the target IS that gateway — never next to a saved or typed
 * remote address — and, field by field, only when nothing is saved for it
 * and the person has not changed it since the page opened. */
export function localAutofill(saved: { address: string | null; token: string | null; socket: string | null }, initial: ConnectFieldsState, current: ConnectFieldsState, cfg: LocalConfig): Partial<ConnectFieldsState> {
  const out: Partial<ConnectFieldsState> = {};
  if (!cfg.url) return out;
  const edited = current.address !== initial.address;
  const target = saved.address || (edited ? current.address : cfg.url);
  if (!saved.address && !edited) out.address = cfg.url;
  if (!isLocalTarget(target, cfg.url)) return out;
  if (!saved.token && current.token === initial.token && cfg.token) out.token = cfg.token;
  if (!saved.socket && current.socket === initial.socket && cfg.tmux_socket) out.socket = cfg.tmux_socket;
  return out;
}

/** The values autofill put in, and for which address. */
export type Autofilled = { address: string; token?: string; socket?: string };

/** The person moved the address away from the local gateway the autofill
 * was for: the auto-filled credentials that are still untouched go (they
 * belong to that gateway), anything the person typed or picked stays. A
 * field whose record is gone (`undefined`) is never touched. */
export function dropAutofilled(auto: Autofilled | null, current: ConnectFieldsState): { clear: Partial<ConnectFieldsState>; keep: Autofilled | null } {
  if (!auto || isLocalTarget(current.address, auto.address)) return { clear: {}, keep: auto };
  const clear: Partial<ConnectFieldsState> = {};
  if (auto.token !== undefined && current.token === auto.token) clear.token = '';
  if (auto.socket !== undefined && current.socket === auto.socket) clear.socket = '';
  return { clear, keep: null };
}

/** A typed address as a ws URL: a bare host gets the scheme the page needs
 * (an https page can only open wss://). One rule for every connect form. */
export function normalizeAddress(addr: string, protocol: string): string {
  const a = addr.trim();
  if (a.startsWith('ws://') || a.startsWith('wss://')) return a;
  return (protocol === 'https:' ? 'wss://' : 'ws://') + a;
}
