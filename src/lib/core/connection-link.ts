// The connection link (board #401): ONE format for a connection that travels
// outside the app, independent of any front end.
//
//   <gateway address>?token=<token>&socket=<tmux socket>
//
// e.g. `wss://mac.tail.ts.net/ws?token=T&socket=%2Ftmp%2Fsock` or
// `ws://192.168.1.5:9899?token=T&socket=`. It is the address a person would
// type, with the credentials as query parameters. A BUILT link always carries
// both parameters, empty when the tuple has nothing for them, so it is always
// recognisable as a link and an empty value means "none" (it clears the field
// it is pasted over). A bare address, typed by hand, is not a link.
// Pasting it into any address field fills address, token and socket (the field
// keeps only the address — the token never stays in plain view).
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
//
// The endpoint's own query (`wss://h/ws?x=1`) survives byte for byte. What it
// cannot hold is a `token` or `socket` key: that would be indistinguishable
// from the credentials, so the builder refuses it and the parser calls such a
// link unusable. Neither ever echoes the text it was given.

export interface ConnectionLink {
  /** The gateway address, canonical (a lone trailing `/` dropped). Never empty. */
  address: string;
  /** `null` when the link has no `token` parameter; an empty one is `''`. */
  token: string | null;
  /** `null` when the link has no `socket` parameter; an empty one is `''`. */
  socket: string | null;
}

/** What `parseConnectionLink` found in a text.
 *  - `none`: not a link (a bare address, plain text): leave it as typed.
 *  - `link`: a usable connection.
 *  - `unusable`: carries a credential, but must not be used or kept in view:
 *    `no-address` (credentials without a usable server: the old token-only
 *    link, a link naming no host, free text with a `?token=` in it) or
 *    `ambiguous` (a repeated `token`/`socket` key, or an endpoint query that
 *    already holds one). */
export type ParsedLink =
  | { kind: 'none' }
  | { kind: 'link'; link: ConnectionLink }
  | { kind: 'unusable'; reason: 'no-address' | 'ambiguous' };

const NONE: ParsedLink = { kind: 'none' };
const CREDENTIAL_KEYS = new Set(['token', 'socket']);

/** `ws://host:9899/` and `ws://host:9899` name the same gateway; the saved
 * registry holds the second spelling, so the link yields it. A path
 * (`wss://host/ws`) is kept as it is, and the scheme is lower case (the
 * connect form's own check is case-sensitive). */
function canonicalAddress(base: string): string {
  return base.replace(/^(wss?:\/\/[^/?#]+)\/$/iu, '$1').replace(/^(wss?):\/\//iu, (_, scheme: string) => `${scheme.toLowerCase()}://`);
}

/** The key of one `a=b` query segment, decoded the way `URLSearchParams` does. */
function keyOf(segment: string): string {
  return new URLSearchParams(segment).keys().next().value ?? '';
}

/** A raw query split into the segments that carry credentials and the rest,
 * which stays VERBATIM (so an endpoint query survives byte for byte). */
function splitQuery(rawQuery: string): { credentials: URLSearchParams; rest: string; repeated: boolean } {
  const kept: string[] = [];
  const cred: string[] = [];
  for (const segment of rawQuery.split('&')) {
    if (!segment) continue;
    (CREDENTIAL_KEYS.has(keyOf(segment)) ? cred : kept).push(segment);
  }
  const credentials = new URLSearchParams(cred.join('&'));
  return {
    credentials,
    rest: kept.join('&'),
    repeated: credentials.getAll('token').length > 1 || credentials.getAll('socket').length > 1,
  };
}

/** Text that is not a usable link but carries a credential parameter
 * (`text ?token=T`, `token=T`, `host:9899?token=x`, a malformed URL): it must
 * never stay in a visible field, so it is unusable rather than plain text. */
const CREDENTIAL_PARAM = /(?:^|[?&#\s])(?:token|socket)=/iu;
function carriesCredential(raw: string): ParsedLink {
  return CREDENTIAL_PARAM.test(raw) ? { kind: 'unusable', reason: 'no-address' } : NONE;
}

/** Does the address name a host at all? `ws://?token=T`, `wss:///?token=T` and
 * `wss://%ZZ` are shaped like links and name no server. */
function hasHost(address: string): boolean {
  try { return new URL(address).hostname !== ''; } catch { return false; }
}

/** Does this endpoint's own query already hold a credential key? */
function endpointCollides(address: string): boolean {
  const q = address.indexOf('?');
  return q >= 0 && splitQuery(address.slice(q + 1)).credentials.size > 0;
}

/** The link that carries `conn` out of the app, or `null` when the endpoint
 * cannot carry one (its query already holds `token` or `socket`, or it has a
 * fragment). Both parameters are always written, empty when there is no value. */
export function buildConnectionLink(conn: { address: string; token?: string; socket?: string }): string | null {
  const address = conn.address.trim();
  if (!address || address.includes('#') || endpointCollides(address)) return null;
  const params = new URLSearchParams();
  params.set('token', conn.token ?? '');
  params.set('socket', conn.socket ?? '');
  return `${address}${address.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** The parameters of the old form: those of the query, else of the `#hash?`
 * part (where a hash-routed front end puts them). */
function frontEndQuery(url: URL): string {
  if (url.search) return url.search.slice(1);
  const at = url.hash.indexOf('?');
  return at >= 0 ? url.hash.slice(at + 1) : '';
}

/**
 * What a pasted or opened text is. A bare address (`ws://host:9899`,
 * `host:9899`) is `none`: it carries no credential parameter, and the field
 * keeps it as typed.
 *
 *   - `ws://` / `wss://` whose query has a `token` or `socket` key (by
 *     PRESENCE: an empty value counts and clears): the new form. Other query
 *     parameters stay part of the address, verbatim.
 *   - any other absolute URL with `addr`, `address` or `server`: the old
 *     front-end form. An address without a scheme is read with the link's own
 *     (`https:` → `wss://`, else `ws://`). Without an address, a `token` or
 *     `socket` key makes it `unusable` (`no-address`): the old token-only link.
 */
export function parseConnectionLink(text: string): ParsedLink {
  const raw = text.trim();
  if (!raw) return NONE;
  if (/\s/u.test(raw)) return carriesCredential(raw);
  if (/^wss?:\/\//iu.test(raw)) {
    const hash = raw.indexOf('#');
    const body = hash >= 0 ? raw.slice(0, hash) : raw;
    const q = body.indexOf('?');
    if (q < 0) return NONE;
    const { credentials, rest, repeated } = splitQuery(body.slice(q + 1));
    if (!credentials.size) return NONE;
    if (repeated) return { kind: 'unusable', reason: 'ambiguous' };
    const address = canonicalAddress(body.slice(0, q)) + (rest ? `?${rest}` : '');
    if (!hasHost(address)) return { kind: 'unusable', reason: 'no-address' };
    return { kind: 'link', link: { address, token: credentials.get('token'), socket: credentials.get('socket') } };
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return carriesCredential(raw);   // `host:9899?token=x` is no link
  let url: URL;
  try { url = new URL(raw); } catch { return carriesCredential(raw); }
  const params = new URLSearchParams(frontEndQuery(url));
  const addr = (params.get('addr') || params.get('address') || params.get('server') || '').trim();
  const { credentials, repeated } = splitQuery(frontEndQuery(url));
  if (!addr) return credentials.size ? { kind: 'unusable', reason: 'no-address' } : carriesCredential(raw);
  if (repeated) return { kind: 'unusable', reason: 'ambiguous' };
  let address = addr;
  if (!/^wss?:\/\//iu.test(address)) address = (url.protocol === 'https:' ? 'wss://' : 'ws://') + address;
  if (endpointCollides(address)) return { kind: 'unusable', reason: 'ambiguous' };
  address = canonicalAddress(address);
  if (!hasHost(address)) return { kind: 'unusable', reason: 'no-address' };
  return { kind: 'link', link: { address, token: credentials.get('token'), socket: credentials.get('socket') } };
}

/** Did this `input` event insert a whole text at once — a paste, a drop, or an
 * on-screen keyboard committing a clipboard suggestion — rather than one
 * typed character? A link is split only on such a boundary (and when the field
 * is committed); ordinary typing stays plain editable text. */
export function isBulkInsert(event: { inputType?: string; data?: string | null }): boolean {
  const type = event.inputType ?? '';
  if (type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertFromYank' || type === 'insertReplacementText') return true;
  return type === 'insertText' && (event.data?.length ?? 0) > 1;
}
