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
// The endpoint's own query (`wss://h/ws?x=1&&y`) survives byte for byte. What it
// cannot hold is a `token` or `socket` key: that would be indistinguishable
// from the credentials, so the builder refuses it and the parser calls such a
// link unusable. Neither ever echoes the text it was given.
//
// ONE reading of a credential key (`credentialKeyOf`: percent-decoded, case
// folded) serves every boundary, so a `none` answer is PROVABLY free of
// credentials: whatever the parser does not take as a link is checked once
// more, whole (query, hash and free text), and refused if it carries one.

export interface ConnectionLink {
  /** The gateway address, canonical (a lone trailing `/` dropped). Never empty. */
  address: string;
  /** `null` when the link has no `token` parameter; an empty one is `''`. */
  token: string | null;
  /** `null` when the link has no `socket` parameter; an empty one is `''`. */
  socket: string | null;
}

/** What `parseConnectionLink` found in a text.
 *  - `none`: not a link and carrying no credential: leave it as typed.
 *  - `link`: a usable connection.
 *  - `unusable`: carries a credential, but must not be used or kept in view:
 *    `address-credential` (the endpoint itself holds a token or socket or URL
 *    user info, e.g. a credential in the fragment of a decoded `addr`),
 *    `no-address` (credentials without a usable server: the old token-only
 *    link, a link naming no host, free text with a `?token=` in it, a
 *    credential in a hash) or `ambiguous` (a repeated `token`/`socket` key, or
 *    an endpoint query that already holds one). */
export type ParsedLink =
  | { kind: 'none' }
  | { kind: 'link'; link: ConnectionLink }
  | { kind: 'unusable'; reason: 'no-address' | 'ambiguous' | 'address-credential' };

const NONE: ParsedLink = { kind: 'none' };
const NO_ADDRESS: ParsedLink = { kind: 'unusable', reason: 'no-address' };
const AMBIGUOUS: ParsedLink = { kind: 'unusable', reason: 'ambiguous' };
const ADDRESS_CREDENTIAL: ParsedLink = { kind: 'unusable', reason: 'address-credential' };

/** THE reading of a credential key: the key of one `a=b` query segment,
 * percent-decoded and case-folded, is `token` or `socket`. (`?%74oken=` is a
 * token key; so is `TOKEN=`.) */
function credentialKeyOf(segment: string): 'token' | 'socket' | null {
  const key = (new URLSearchParams(segment).keys().next().value ?? '').toLowerCase();
  return key === 'token' || key === 'socket' ? key : null;
}

/** A raw query split into the segments that carry credentials and the rest,
 * which stays VERBATIM — empty segments and a lone `?` included — so an
 * endpoint query survives byte for byte. */
function splitQuery(rawQuery: string): { credentials: URLSearchParams; kept: string[]; repeated: boolean } {
  const kept: string[] = [];
  const credentials = new URLSearchParams();
  for (const segment of rawQuery.split('&')) {
    const key = credentialKeyOf(segment);
    if (key) credentials.append(key, new URLSearchParams(segment).values().next().value ?? '');
    else kept.push(segment);
  }
  return { credentials, kept, repeated: credentials.getAll('token').length > 1 || credentials.getAll('socket').length > 1 };
}

/** Does this text carry a credential parameter anywhere — in a query, in a
 * hash, in free text? The same key reading as the parser. */
export function carriesCredentialKey(text: string): boolean {
  return text.split(/[?&#\s]/u).some((piece) => piece.includes('=') && credentialKeyOf(piece) !== null);
}

/** The part of a location hash that is safe to keep as a route after a link
 * was taken from the address bar: what precedes any `?`, and nothing at all
 * when that still carries a credential (`#token=T`). */
export function routeOfHash(hash: string): string {
  const route = hash.split('?')[0] ?? '';
  return carriesCredentialKey(route) ? '' : route;
}

/** `ws://host:9899/` and `ws://host:9899` name the same gateway; the saved
 * registry holds the second spelling, so the link yields it. A path
 * (`wss://host/ws`) is kept as it is, and the scheme is lower case (the
 * connect form's own check is case-sensitive). */
function canonicalAddress(base: string): string {
  return base.replace(/^(wss?:\/\/[^/?#]+)\/$/iu, '$1').replace(/^(wss?):\/\//iu, (_, scheme: string) => `${scheme.toLowerCase()}://`);
}

/** Does this single-token text carry URL user info (`user@host`,
 * `user:pass@host`, `@host`)? The gateway authenticates by token, never by URL
 * user info, so user info is never a valid part of an endpoint — and a password
 * in one would be stored and shown in plain text in the address field. Reads the
 * authority only (what follows an optional `scheme://`, up to `/`, `?` or `#`),
 * so an `@` later in a path or query is not user info. Free text with spaces is
 * not an address and is not judged here. */
function hasUserInfo(text: string): boolean {
  if (/\s/u.test(text)) return false;
  return (text.replace(/^[a-z][a-z\d+.-]*:\/\//iu, '').split(/[/?#]/u, 1)[0] ?? '').includes('@');
}

/** Does the address name a host at all? `ws://?token=T`, `wss:///?token=T` and
 * `wss://%ZZ` are shaped like links and name no server. */
function hasHost(address: string): boolean {
  try { return new URL(address).hostname !== ''; } catch { return false; }
}

/** The link that carries `conn` out of the app, or `null` when the endpoint
 * cannot carry one (its query already holds `token` or `socket`, or it has a
 * fragment). Both parameters are always written, empty when there is no value. */
export function buildConnectionLink(conn: { address: string; token?: string; socket?: string }): string | null {
  const endpoint = endpointOf(conn.address);
  if (endpoint.kind !== 'endpoint') return null;
  const address = endpoint.address;
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

function classify(raw: string): ParsedLink {
  if (/\s/u.test(raw)) return NONE;
  if (/^wss?:\/\//iu.test(raw)) {
    const hash = raw.indexOf('#');
    const body = hash >= 0 ? raw.slice(0, hash) : raw;
    const q = body.indexOf('?');
    if (q < 0) return NONE;
    const { credentials, kept, repeated } = splitQuery(body.slice(q + 1));
    if (!credentials.size) return NONE;
    if (repeated) return AMBIGUOUS;
    // The endpoint is validated ONCE, by the same function that guards an
    // address-only field, wherever it was extracted from: a parsed link
    // guarantees a usable, credential-free address.
    const endpoint = endpointOf(canonicalAddress(body.slice(0, q)) + (kept.length ? `?${kept.join('&')}` : ''));
    if (endpoint.kind !== 'endpoint') return endpoint.kind === 'credential' ? ADDRESS_CREDENTIAL : NO_ADDRESS;
    return { kind: 'link', link: { address: endpoint.address, token: credentials.get('token'), socket: credentials.get('socket') } };
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return NONE;                  // `host:9899?token=x` is no URL
  let url: URL;
  try { url = new URL(raw); } catch { return NONE; }
  const query = frontEndQuery(url);
  const params = new URLSearchParams(query);
  const addr = (params.get('addr') || params.get('address') || params.get('server') || '').trim();
  const { credentials, repeated } = splitQuery(query);
  if (!addr) return credentials.size ? NO_ADDRESS : NONE;
  if (repeated) return AMBIGUOUS;
  let address = addr;
  if (!/^wss?:\/\//iu.test(address)) {
    // A scheme-less `host:port` is read with the link's own scheme; an address
    // that HAS another scheme (`http://h`) is not a WebSocket gateway, and is not
    // turned into `wss://http://h`.
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(address)) return NO_ADDRESS;
    address = (url.protocol === 'https:' ? 'wss://' : 'ws://') + address;
  }
  // The decoded `addr` is an endpoint like any other: a fragment, an encoded
  // credential key or a missing host in it makes the whole link unusable, and
  // the outer token is never taken as approval to connect to a repaired target.
  const endpoint = endpointOf(address);
  if (endpoint.kind !== 'endpoint') return endpoint.kind === 'credential' ? ADDRESS_CREDENTIAL : NO_ADDRESS;
  return { kind: 'link', link: { address: endpoint.address, token: credentials.get('token'), socket: credentials.get('socket') } };
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
 *   - anything else that still carries a credential key — in a hash, in free
 *     text — is `unusable` too: a `none` answer is provably credential-free.
 */
export function parseConnectionLink(text: string): ParsedLink {
  const raw = text.trim();
  if (!raw) return NONE;
  const parsed = classify(raw);
  if (parsed.kind !== 'none') return parsed;
  if (carriesCredentialKey(raw)) return NO_ADDRESS;
  return hasUserInfo(raw) ? ADDRESS_CREDENTIAL : parsed;
}

/** What `endpointOf` found in a text. */
export type Endpoint =
  | { kind: 'endpoint'; address: string }
  | { kind: 'credential' }
  | { kind: 'invalid' };

/**
 * Is this text a clean gateway endpoint — the kind of address a form may keep
 * as an address (board #402's "Add address")? Exported and stable: it is the
 * one validator of an address-only field.
 *
 *   - `endpoint`: a whole `ws://` or `wss://` URL with a usable host and, if
 *     it has one, a valid port; no whitespace, no fragment, and no credential
 *     key anywhere. `address` is canonical (lower-case scheme, a lone `/`
 *     after the host dropped, everything else byte for byte), so it compares
 *     with a saved address.
 *   - `credential`: the text carries a `token` or `socket` key — a new link, an
 *     old front-end link, free text — read with the one key reading, or URL user
 *     info (`user@host`, `user:pass@host`; the gateway authenticates by token,
 *     never by user info). It is never an address, and nothing here echoes it.
 *   - `invalid`: everything else (`http://`, a bare host, a bad port, an empty
 *     host, a fragment, an empty string). No scheme guessing: a caller that
 *     wants `host:port` read as `ws://host:port` adds the scheme first.
 */
export function endpointOf(text: string): Endpoint {
  const raw = text.trim();
  if (carriesCredentialKey(raw) || hasUserInfo(raw)) return { kind: 'credential' };
  if (!/^wss?:\/\//iu.test(raw) || /\s/u.test(raw) || raw.includes('#')) return { kind: 'invalid' };
  const address = canonicalAddress(raw);
  return hasHost(address) ? { kind: 'endpoint', address } : { kind: 'invalid' };
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
