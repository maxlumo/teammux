import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildConnectionLink, parseConnectionLink } from './connection-link.ts';

// Fixture credentials are fake. The link is a secret in real use; nothing in
// the module logs or throws on it.

const TUPLES = [
  { address: 'ws://192.168.1.5:9899', token: 'tok', socket: '/tmp/tmux-1000/default' },
  { address: 'wss://mac.tail.ts.net/ws', token: 'tok', socket: '' },
  { address: 'ws://[::1]:19900', token: '', socket: '/local/sock' },
  { address: 'wss://host.example', token: 'fake-token&=+ %/?#', socket: '/tmp/fake socket' },
  { address: 'wss://host.example/a/b/', token: 'T', socket: '' },
];

test('build then parse returns the same address, token and socket', () => {
  for (const t of TUPLES) {
    const link = buildConnectionLink(t);
    assert.deepEqual(parseConnectionLink(link), { address: t.address, token: t.token || null, socket: t.socket || null }, link.replace(t.token, '<token>'));
  }
});

test('the built link is the gateway address with the credentials as parameters, and no front end in it', () => {
  assert.equal(buildConnectionLink({ address: 'ws://h:9899', token: 'T', socket: '/s' }), 'ws://h:9899?token=T&socket=%2Fs');
  assert.equal(buildConnectionLink({ address: 'ws://h:9899', token: 'T' }), 'ws://h:9899?token=T');
  assert.equal(buildConnectionLink({ address: 'ws://h:9899' }), 'ws://h:9899', 'no credentials, no parameters');
  assert.equal(buildConnectionLink({ address: ' wss://h/ws?x=1 ', token: 'T' }), 'wss://h/ws?x=1&token=T', 'an address that has a query keeps it');
  assert.doesNotMatch(buildConnectionLink({ address: 'ws://h:9899', token: 'T' }), /https?:|addr=/u);
});

test('new form: a trailing slash after the host is dropped, other query parameters stay with the address, the hash is ignored', () => {
  assert.deepEqual(parseConnectionLink('ws://h:9899/?token=T'), { address: 'ws://h:9899', token: 'T', socket: null });
  assert.deepEqual(parseConnectionLink('wss://h/ws/?token=T'), { address: 'wss://h/ws/', token: 'T', socket: null });
  assert.deepEqual(parseConnectionLink('wss://h/ws?x=1&token=T&y=2'), { address: 'wss://h/ws?x=1&y=2', token: 'T', socket: null });
  assert.deepEqual(parseConnectionLink('ws://h:9899?socket=%2Ftmp%2Fs#frag'), { address: 'ws://h:9899', token: null, socket: '/tmp/s' });
  assert.deepEqual(parseConnectionLink('  WSS://h/ws?token=T\n'), { address: 'wss://h/ws', token: 'T', socket: null }, 'whitespace around a pasted link is not part of it, and the scheme is lower case');
});

test('old form: the front end is ignored; addr, address and server all name the gateway; the hash form is read', () => {
  const want = { address: 'ws://h:9899', token: 'T', socket: '/s' };
  assert.deepEqual(parseConnectionLink('https://app.example/x/?addr=ws%3A%2F%2Fh%3A9899&token=T&socket=%2Fs'), want);
  assert.deepEqual(parseConnectionLink('http://localhost:5173/?address=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(parseConnectionLink('http://192.168.1.2:9899/?server=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(parseConnectionLink('https://app.example/#/page?addr=ws://h:9899&token=T&socket=/s'), want);
  assert.deepEqual(parseConnectionLink('tauri://localhost/?addr=ws://h:9899&token=T&socket=/s'), want, 'any front-end scheme');
});

test('old form: an address with no scheme is read with the link\u2019s own, a lone slash is dropped, a token-only link names no address', () => {
  assert.equal(parseConnectionLink('https://app.example/?addr=h:9899&token=T')!.address, 'wss://h:9899');
  assert.equal(parseConnectionLink('http://app.example/?addr=h:9899&token=T')!.address, 'ws://h:9899');
  assert.equal(parseConnectionLink('https://app.example/?addr=wss://h/&token=T')!.address, 'wss://h');
  assert.deepEqual(parseConnectionLink('https://app.example/?token=T&socket=/s'), { address: '', token: 'T', socket: '/s' });
  assert.deepEqual(parseConnectionLink('https://app.example/?addr=ws://h:1&token='), { address: 'ws://h:1', token: '', socket: null }, 'a present but empty token is empty, not absent');
  assert.deepEqual(parseConnectionLink('https://app.example/?addr=ws://h:1'), { address: 'ws://h:1', token: null, socket: null });
});

test('what is not a link is left alone: bare addresses, text, a web page without parameters', () => {
  for (const text of [
    '', '   ', 'ws://h:9899', 'wss://h/ws', 'ws://h:9899/', 'h:9899', '192.168.1.5:9899', 'host:9899?token=x',
    'ws://h:9899?token=', 'ws://h:9899?socket=', 'ws://h:9899?x=1',
    'https://app.example/', 'https://app.example/?page=files',
    'connect to ws://h:9899?token=T please', 'not a url ?token=T', 'ws://h:9899?token=a b',
  ]) assert.equal(parseConnectionLink(text), null, JSON.stringify(text));
});

test('the module neither logs nor leaves a trace of what it parses', async () => {
  const source = await readFile(new URL('./connection-link.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage|document\.|window\./u);
});
