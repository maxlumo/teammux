// The connection link (board #401): ONE format for a connection that travels
// outside the app, independent of any front end.
//
//   <gateway address>?token=<token>&socket=<tmux socket>
//
// e.g. `wss://mac.tail.ts.net/ws?token=T&socket=%2Ftmp%2Fsock` or
// `ws://192.168.1.5:9899?token=T`. It is the address a person would type, with
// the credentials as query parameters; `token` and `socket` are optional.
// Pasting it into any address field fills address, token and socket (the
// fields keep only the address — the token never stays in plain view).
//
// The links the app used to copy are still accepted, and opening one in the
// browser still connects:
//
//   <front end>/?addr=<gateway address>&token=<token>&socket=<socket>
//
// where `address=` and `server=` are aliases of `addr=`, and the parameters may
// sit in the `#hash?` part. One parser reads both (`parseConnectionLink`) and
// one builder writes the new form (`buildConnectionLink`); nothing else in the
// app spells either. Pure, framework-free, and it never logs or throws on
// its input: a token is a secret.

export interface ConnectionLink {
  /** The gateway address, canonical (a lone trailing `/` dropped), or `''`
   * when an old link carried credentials but no address. */
  address: string;
  /** `null` when the link has no `token` parameter (an empty one is `''`). */
  token: string | null;
  /** `null` when the link has no `socket` parameter. */
  socket: string | null;
}

/** `ws://host:9899/` and `ws://host:9899` name the same gateway; the saved
 * registry holds the second spelling, so the link yields it. A path
 * (`wss://host/ws`) is kept as it is, and the scheme is lower case (the
 * connect form's own check is case-sensitive). */
function canonicalAddress(base: string): string {
  return base.replace(/^(wss?:\/\/[^/?#]+)\/$/iu, '$1').replace(/^(wss?):\/\//iu, (_, scheme: string) => `${scheme.toLowerCase()}://`);
}

/** The link that carries `conn` out of the app. The address is the gateway's
 * (`ws://` or `wss://`); an empty token or socket is simply left out. */
export function buildConnectionLink(conn: { address: string; token?: string; socket?: string }): string {
  const params = new URLSearchParams();
  if (conn.token) params.set('token', conn.token);
  if (conn.socket) params.set('socket', conn.socket);
  const query = params.toString();
  const address = conn.address.trim();
  if (!query) return address;
  return `${address}${address.includes('?') ? '&' : '?'}${query}`;
}

/** The parameters of the old form: those of the query, else of the `#hash?`
 * part (where a hash-routed front end puts them). */
function frontEndParams(url: URL): URLSearchParams {
  if (url.search) return new URLSearchParams(url.search);
  const at = url.hash.indexOf('?');
  return new URLSearchParams(at >= 0 ? url.hash.slice(at + 1) : '');
}

/**
 * The connection a pasted or opened text names, or null when it names none.
 * A bare address (`ws://host:9899`, `host:9899`) is not a link: it carries no
 * credentials, and the field keeps it as typed.
 *
 *   - `ws://` / `wss://` with a non-empty `token` or `socket` parameter: the
 *     new form. Other query parameters stay part of the address.
 *   - any other absolute URL with `addr`, `address` or `server`, or with a
 *     `token` parameter: the old front-end form. An address without a scheme
 *     is read with the link's own (`https:` → `wss://`, else `ws://`).
 */
export function parseConnectionLink(text: string): ConnectionLink | null {
  const raw = text.trim();
  if (!raw || /\s/u.test(raw)) return null;
  if (/^wss?:\/\//iu.test(raw)) {
    const hash = raw.indexOf('#');
    const body = hash >= 0 ? raw.slice(0, hash) : raw;
    const q = body.indexOf('?');
    if (q < 0) return null;
    const params = new URLSearchParams(body.slice(q + 1));
    const token = params.get('token');
    const socket = params.get('socket');
    if (!token && !socket) return null;
    params.delete('token');
    params.delete('socket');
    const rest = params.toString();
    return {
      address: canonicalAddress(body.slice(0, q)) + (rest ? `?${rest}` : ''),
      token,
      socket,
    };
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return null;          // `host:9899?token=x` is not a URL
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const params = frontEndParams(url);
  const addr = (params.get('addr') || params.get('address') || params.get('server') || '').trim();
  const token = params.get('token');
  if (!addr && token == null) return null;
  let address = addr;
  if (address && !/^wss?:\/\//iu.test(address)) address = (url.protocol === 'https:' ? 'wss://' : 'ws://') + address;
  return { address: canonicalAddress(address), token, socket: params.get('socket') };
}
