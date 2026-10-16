import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildConnectionLink, carriesCredentialKey, endpointOf, isBulkInsert, parseConnectionLink, routeOfHash, type ConnectionLink } from './connection-link.ts';

// Fixture credentials are fake. The link is a secret in real use; nothing in
// the module logs or throws on it.

const linkOf = (text: string): ConnectionLink => {
  const parsed = parseConnectionLink(text);
  assert.equal(parsed.kind, 'link', `a link: ${text.replace(/token=[^&]*/u, 'token=<token>')}`);
  return (parsed as { kind: 'link'; link: ConnectionLink }).link;
};
const kindOf = (text: string) => {
  const parsed = parseConnectionLink(text);
  return parsed.kind === 'unusable' ? `unusable:${parsed.reason}` : parsed.kind;
};

const TUPLES = [
  { address: 'ws://192.168.1.5:9899', token: 'tok', socket: '/tmp/tmux-1000/default' },
  { address: 'wss://mac.tail.ts.net/ws', token: 'tok', socket: '' },
  { address: 'ws://[::1]:19900', token: '', socket: '/local/sock' },
  { address: 'wss://host.example', token: 'fake-token&=+ %/?#', socket: '/tmp/fake socket' },
  { address: 'wss://host.example/a/b/', token: 'T', socket: '' },
  { address: 'ws://h:9899', token: '', socket: '' },
];

test('build then parse returns the same address, token and socket, an empty one included', () => {
  for (const t of TUPLES) {
    const built = buildConnectionLink(t)!;
    assert.ok(built, 'a link was built');
    assert.deepEqual(linkOf(built), { address: t.address, token: t.token, socket: t.socket }, built.replace(t.token, '<token>'));
  }
});

test('a built link is always recognisably a link: both parameters are written, empty when there is nothing', () => {
  assert.equal(buildConnectionLink({ address: 'ws://h:9899', token: 'T', socket: '/s' }), 'ws://h:9899?token=T&socket=%2Fs');
  assert.equal(buildConnectionLink({ address: 'ws://h:9899', token: 'T' }), 'ws://h:9899?token=T&socket=');
  assert.equal(buildConnectionLink({ address: 'ws://h:9899', socket: '/s' }), 'ws://h:9899?token=&socket=%2Fs');
  assert.equal(buildConnectionLink({ address: 'ws://h:9899' }), 'ws://h:9899?token=&socket=', 'both empty is still a link');
  assert.doesNotMatch(buildConnectionLink({ address: 'ws://h:9899', token: 'T' })!, /https?:|addr=/u, 'and carries no front end');
});

test('parsing is by PRESENCE of the parameter, not truthiness: an empty value is a value that clears', () => {
  assert.deepEqual(linkOf('ws://h:9899?token=&socket='), { address: 'ws://h:9899', token: '', socket: '' });
  assert.deepEqual(linkOf('ws://h:9899?token='), { address: 'ws://h:9899', token: '', socket: null });
  assert.deepEqual(linkOf('ws://h:9899?socket='), { address: 'ws://h:9899', token: null, socket: '' });
  assert.deepEqual(linkOf('https://app.example/?addr=ws://h:1&token='), { address: 'ws://h:1', token: '', socket: null });
});

test('a hand-typed bare address is just an address', () => {
  for (const text of ['ws://h:9899', 'wss://h/ws', 'ws://h:9899/', 'h:9899', '192.168.1.5:9899', 'ws://h:9899?x=1', 'wss://h/ws?a=b']) {
    assert.equal(kindOf(text), 'none', text);
  }
});

test('the endpoint\u2019s own query survives byte for byte; the credentials come out of it', () => {
  const endpoint = 'wss://h/ws?a=b%20c&x=1/2&y';
  const built = buildConnectionLink({ address: endpoint, token: 'T', socket: '/s' })!;
  assert.equal(built, `${endpoint}&token=T&socket=%2Fs`);
  assert.deepEqual(linkOf(built), { address: endpoint, token: 'T', socket: '/s' });
  assert.deepEqual(linkOf('wss://h/ws?x=1&token=T&y=2'), { address: 'wss://h/ws?x=1&y=2', token: 'T', socket: null });
});

test('an endpoint whose query already holds token or socket cannot carry a link: the builder refuses, the parser calls a repeated key unusable', () => {
  for (const address of ['wss://h/ws?token=route', 'wss://h/ws?x=1&socket=a', 'wss://h/ws?TOKEN=1&token=2', 'wss://h/ws#frag', '', '   ']) {
    assert.equal(buildConnectionLink({ address, token: 'AUTH', socket: '/s' }), null, JSON.stringify(address));
  }
  assert.equal(kindOf('wss://h/ws?token=route&token=AUTH'), 'unusable:ambiguous');
  assert.equal(kindOf('wss://h/ws?socket=a&token=T&socket=b'), 'unusable:ambiguous');
  assert.equal(kindOf('https://front.example/?addr=ws://h:1&token=A&token=B'), 'unusable:ambiguous', 'the old form too: the first token is never taken silently');
  assert.equal(kindOf('https://front.example/#/x?addr=ws://h:1&socket=a&socket=b'), 'unusable:ambiguous');
  assert.equal(kindOf('https://app.example/?addr=wss://h/ws?token=route&token=AUTH'), 'unusable:address-credential');
  assert.equal(kindOf('https://app.example/?addr=wss%3A%2F%2Fh%2Fws%3Ftoken%3Droute&token=AUTH'), 'unusable:address-credential', 'a credential key inside the endpoint itself');
});

test('new form: a trailing slash after the host is dropped, the hash is ignored, the scheme is lower case', () => {
  assert.deepEqual(linkOf('ws://h:9899/?token=T'), { address: 'ws://h:9899', token: 'T', socket: null });
  assert.deepEqual(linkOf('wss://h/ws/?token=T'), { address: 'wss://h/ws/', token: 'T', socket: null });
  assert.deepEqual(linkOf('ws://h:9899?socket=%2Ftmp%2Fs#frag'), { address: 'ws://h:9899', token: null, socket: '/tmp/s' });
  assert.deepEqual(linkOf('  WSS://h/ws?token=T\n'), { address: 'wss://h/ws', token: 'T', socket: null });
});

test('old form: the front end is ignored; addr, address and server all name the gateway; the hash form is read', () => {
  const want = { address: 'ws://h:9899', token: 'T', socket: '/s' };
  assert.deepEqual(linkOf('https://app.example/x/?addr=ws%3A%2F%2Fh%3A9899&token=T&socket=%2Fs'), want);
  assert.deepEqual(linkOf('http://localhost:5173/?address=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(linkOf('http://192.168.1.2:9899/?server=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(linkOf('https://app.example/#/page?addr=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(linkOf('tauri://localhost/?addr=ws://h:9899&token=T&socket=/s'), want, 'any front-end scheme');
});

test('old form: an address with no scheme is read with the link\u2019s own, a lone slash is dropped', () => {
  assert.equal(linkOf('https://app.example/?addr=h:9899&token=T').address, 'wss://h:9899');
  assert.equal(linkOf('http://app.example/?addr=h:9899&token=T').address, 'ws://h:9899');
  assert.equal(linkOf('https://app.example/?addr=wss://h/&token=T').address, 'wss://h');
  assert.deepEqual(linkOf('https://app.example/?addr=ws://h:1'), { address: 'ws://h:1', token: null, socket: null });
});

test('the old token-only link names no server: recognised, and unusable, in the query and in the hash', () => {
  for (const text of [
    'https://app.example/?token=T', 'https://app.example/?token=T&socket=/s', 'https://app.example/?socket=/s',
    'https://app.example/#/files?token=T', 'tauri://localhost/?token=',
  ]) assert.equal(kindOf(text), 'unusable:no-address', text);
});

test('a link that names no usable host is unusable, not a half-filled address', () => {
  for (const text of ['ws://?token=T', 'wss:///?token=T', 'ws://%ZZ?token=T', 'wss://?socket=%2Fs',
    'https://app.example/?addr=wss://%ZZ&token=T', 'https://app.example/?addr=ws://&token=T']) {
    assert.equal(kindOf(text), 'unusable:no-address', text);
  }
  assert.equal(kindOf('ws://[::1]:19900?token=T'), 'link', 'an IPv6 host is a host');
});

test('what is not a link is left alone: text, a web page without credentials, a malformed URL', () => {
  for (const text of [
    '', '   ', 'https://app.example/', 'https://app.example/?page=files', 'http://', 'plain words', 'my-token-is-here', 'mytoken=1',
  ]) assert.equal(kindOf(text), 'none', JSON.stringify(text));
});

test('any other text that carries a credential parameter is unusable too, so it is never left in view', () => {
  for (const text of [
    'host:9899?token=x', 'connect to ws://h:9899?token=T please', 'not a url ?token=T', 'ws://h:9899?token=a b',
    'token=T', '?token=T', '&socket=%2Fs', 'ws://h:9899 token=T', 'https://app.example/?token=', 'https://app.example/?addr=&token=T',
  ]) assert.equal(kindOf(text), 'unusable:no-address', text);
});

test('a text is split only where it arrives whole: a paste, a drop, a clipboard suggestion, never one typed character', () => {
  for (const inputType of ['insertFromPaste', 'insertFromDrop', 'insertFromYank', 'insertReplacementText']) assert.equal(isBulkInsert({ inputType }), true, inputType);
  assert.equal(isBulkInsert({ inputType: 'insertText', data: 'wss://h/ws?token=T' }), true, 'a keyboard committing a clipboard chip');
  assert.equal(isBulkInsert({ inputType: 'insertText', data: 'A' }), false, 'one typed character');
  assert.equal(isBulkInsert({ inputType: 'insertCompositionText', data: 'abc' }), false, 'an IME composition');
  assert.equal(isBulkInsert({ inputType: 'deleteContentBackward' }), false);
  assert.equal(isBulkInsert({}), false, 'an event that says nothing is not a paste');
});

test('ONE reading of a credential key: a hash, an encoded key or another case never turns credential text into plain text', () => {
  for (const text of [
    'ws://h/ws#?token=SECRET', 'ws://h/ws?x=1#token=SECRET', 'https://front.example/#token=SECRET', 'https://front.example/#/files?socket=%2Fs',
    'text ?%74oken=SECRET', 'text &%53OCKET=%2Fs', 'ws://h/ws#?TOKEN=SECRET', 'a=b token=SECRET',
  ]) assert.equal(kindOf(text), 'unusable:no-address', text);
  // The same key reading inside a real link.
  assert.deepEqual(linkOf('wss://h/ws?%74oken=T&SOCKET=%2Fs'), { address: 'wss://h/ws', token: 'T', socket: '/s' });
  assert.equal(buildConnectionLink({ address: 'wss://h/ws?%74oken=route', token: 'AUTH' }), null, 'an encoded credential key in the endpoint collides too');
  assert.equal(kindOf('wss://h/ws?%74oken=route&token=AUTH'), 'unusable:ambiguous');
  // A hash that carries nothing is ignored, and one beside a link does not stop it.
  assert.deepEqual(linkOf('ws://h:9899?token=T#frag'), { address: 'ws://h:9899', token: 'T', socket: null });
  assert.deepEqual(linkOf('ws://h:9899?token=T#token=Z'), { address: 'ws://h:9899', token: 'T', socket: null }, 'the hash is dropped, not read');
  // Anything the parser calls none is credential-free by the same reading.
  for (const text of ['ws://h:9899', 'wss://h/ws?x=1', 'plain words', 'https://front.example/#/files', 'a=b c=d', 'mytoken=1', 'token', '?tokens=1']) {
    assert.equal(kindOf(text), 'none', text);
    assert.equal(carriesCredentialKey(text), false, text);
  }
});

test('the endpoint query survives byte for byte: empty segments and a lone ? included', () => {
  for (const endpoint of ['wss://h/ws?a=1&&b=2&', 'wss://h/ws?', 'wss://h/ws?&', 'wss://h/ws?a=1&', 'wss://h/ws?&a=1', 'wss://h/ws?a&b=%20', 'wss://h/ws?x=1&&']) {
    const built = buildConnectionLink({ address: endpoint, token: 'T', socket: '/s' })!;
    assert.ok(built, endpoint);
    assert.deepEqual(linkOf(built), { address: endpoint, token: 'T', socket: '/s' }, endpoint);
  }
  assert.deepEqual(linkOf('wss://h/ws?a=1&&token=T&&b=2'), { address: 'wss://h/ws?a=1&&&b=2', token: 'T', socket: null }, 'only the credential segment leaves; the separators around it stay');
});

test('the route kept after a link is taken from the address bar never carries a credential', () => {
  assert.equal(routeOfHash(''), '');
  assert.equal(routeOfHash('#/files'), '#/files');
  assert.equal(routeOfHash('#/files?addr=ws://h:1&token=T'), '#/files');
  assert.equal(routeOfHash('#token=T'), '');
  assert.equal(routeOfHash('#%74oken=T'), '');
  assert.equal(routeOfHash('#/a&socket=%2Fs'), '');
});

test('a decoded old addr is an endpoint like any other: a fragment, a hidden credential or a foreign scheme makes the whole link unusable (a hidden credential has its own reason), and the outer token is never approval', () => {
  for (const key of ['addr', 'address', 'server']) {
    assert.equal(kindOf(`https://front.example/?${key}=wss%3A%2F%2Fh%2Fws%23token%3DSECRET-ONE&token=OUTER-TOKEN`), 'unusable:address-credential', `${key}: a credential in the fragment`);
    assert.equal(kindOf(`https://front.example/?${key}=wss%3A%2F%2Fh%2Fws%23socket%3D%252Fs&token=OUTER-TOKEN`), 'unusable:address-credential', `${key}: a socket in the fragment`);
    assert.equal(kindOf(`https://front.example/?${key}=wss%3A%2F%2Fh%2Fws%23frag&token=OUTER-TOKEN`), 'unusable:no-address', `${key}: an ordinary fragment is no WebSocket endpoint`);
    assert.equal(kindOf(`https://front.example/?${key}=wss%3A%2F%2Fh%2Fws%3F%2574oken%3DSECRET-ONE&token=OUTER-TOKEN`), 'unusable:address-credential', `${key}: an encoded key in the endpoint query`);
    assert.equal(kindOf(`https://front.example/?${key}=ws%3A%2F%2Fh%3A99999&token=OUTER-TOKEN`), 'unusable:no-address', `${key}: a bad port`);
    assert.equal(kindOf(`https://front.example/?${key}=http%3A%2F%2Fh%3A1&token=OUTER-TOKEN`), 'unusable:no-address', `${key}: an http address is no WebSocket gateway, and is not turned into wss://http://`);
    assert.equal(kindOf(`https://front.example/?${key}=ftp%3A%2F%2Fh&token=OUTER-TOKEN`), 'unusable:no-address', `${key}: nor is any other scheme`);
  }
});

test('the invariant: every link the parser accepts carries an address that endpointOf calls an endpoint, unchanged', () => {
  const accepted = [
    ...TUPLES.map((t) => buildConnectionLink(t)!),
    'wss://h/ws?token=T&socket=%2Fs', 'ws://h:9899/?token=T', '  WSS://h/ws?token=T\n', 'wss://h/ws?a=1&&b=2&token=T&&',
    'https://app.example/x/?addr=ws%3A%2F%2Fh%3A9899&token=T', 'http://localhost:5173/?address=ws://h:9899&token=T',
    'http://192.168.1.2:9899/?server=ws://h:9899&token=T', 'https://app.example/#/page?addr=ws://h:9899&token=T',
    'tauri://localhost/?addr=ws://h:9899&token=T', 'https://app.example/?addr=h:9899&token=T', 'https://app.example/?addr=wss://h/&token=',
    'https://app.example/?addr=wss%3A%2F%2Fh%2Fws%3Fa%3D1%26%26b&token=T',
  ];
  for (const text of accepted) {
    const link = linkOf(text);
    assert.deepEqual(endpointOf(link.address), { kind: 'endpoint', address: link.address }, link.address);
  }
});

test('URL user info is a credential: the gateway authenticates by token, so user:pass@ is never part of an endpoint (#405)', () => {
  for (const text of [
    'ws://user@h:9899', 'wss://user:SECRET-ONE@h/ws', 'ws://@h:9899', 'wss://u:p@[::1]:19900/ws', 'user:SECRET-ONE@h:9899', 'user@h', 'mailto:a@b',
    'wss://user:pw@h/ws?x=1',
  ]) {
    assert.deepEqual(endpointOf(text), { kind: 'credential' }, `endpointOf ${text.replace(/SECRET-ONE/u, '<secret>')}`);
    assert.equal(kindOf(text), 'unusable:address-credential', `parse ${text.replace(/SECRET-ONE/u, '<secret>')}`);
  }
  // Inside a link: the new form with a real query, and the old addr, after decoding.
  assert.equal(kindOf('wss://user:pw@h/ws?token=T&socket=%2Fs'), 'unusable:address-credential');
  assert.equal(kindOf('https://front.example/?addr=mailto%3Aa%40b&token=OUTER-TOKEN'), 'unusable:address-credential', 'mailto:a@b is not turned into wss://mailto:a@b');
  assert.equal(kindOf('https://front.example/?addr=wss%3A%2F%2Fu%3Apw%40h%2Fws&token=OUTER-TOKEN'), 'unusable:address-credential');
  assert.equal(kindOf('https://front.example/?address=u%40h%3A1&token=OUTER-TOKEN'), 'unusable:address-credential', 'a scheme-less user@host:port too');
  assert.equal(buildConnectionLink({ address: 'wss://user:pw@h/ws', token: 'T' }), null, 'and the builder refuses it');
  // Unchanged: a bare host or host:port, and an @ that is not user info.
  assert.deepEqual(endpointOf('wss://h/ws@x?y=a@b'), { kind: 'endpoint', address: 'wss://h/ws@x?y=a@b' }, 'an @ after the authority is not user info');
  assert.equal(kindOf('h:9899'), 'none');
  assert.equal(kindOf('192.168.1.5:9899'), 'none');
  assert.equal(kindOf('ws://h:9899'), 'none');
  assert.equal(kindOf('mail me at a@b.example'), 'none', 'free text with spaces is not judged as an address');
  assert.deepEqual(endpointOf('h:9899'), { kind: 'invalid' });
});

test('endpointOf: a clean ws or wss endpoint is accepted in its canonical spelling; anything carrying a credential is refused as a credential; the rest is invalid', () => {
  for (const [text, address] of [
    ['ws://h:9899', 'ws://h:9899'], ['  wss://mac.tail.ts.net/ws  ', 'wss://mac.tail.ts.net/ws'], ['WSS://h/ws', 'wss://h/ws'],
    ['ws://h:9899/', 'ws://h:9899'], ['wss://h/ws/', 'wss://h/ws/'], ['ws://[::1]:19900', 'ws://[::1]:19900'],
    ['wss://h/ws?region=eu&&x', 'wss://h/ws?region=eu&&x'], ['ws://192.168.1.5:9899', 'ws://192.168.1.5:9899'],
  ] as const) assert.deepEqual(endpointOf(text), { kind: 'endpoint', address }, text);
  for (const text of [
    'ws://h:9899?token=T', 'ws://h:9899?token=&socket=', 'https://app.example/?addr=ws://h:1&token=T', 'https://app.example/?token=T',
    'ws://h/ws#?token=T', 'wss://h/ws?%74oken=T', 'text ?token=T', 'token=T', 'wss://h/ws?x=1&TOKEN=T', 'ws://?token=T',
  ]) assert.deepEqual(endpointOf(text), { kind: 'credential' }, 'a credential, and nothing echoed');
  for (const text of [
    '', '   ', 'h:9899', '192.168.1.5:9899', 'http://h:9899', 'https://h/ws', 'ftp://h', 'ws://', 'ws:///', 'ws://%ZZ', 'ws://h:99999',
    'ws://h:9899 extra', 'ws://h/ws#frag', 'https://app.example/?addr=ws://h:1',
  ]) assert.deepEqual(endpointOf(text), { kind: 'invalid' }, JSON.stringify(text));
  assert.doesNotMatch(JSON.stringify(endpointOf('ws://h:9899?token=SECRET')), /SECRET/u, 'the result never carries the text');
});

test('the module neither logs nor leaves a trace of what it parses', async () => {
  const source = await readFile(new URL('./connection-link.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|document\.|window\./u);
});
