import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConnectionAddress, STANDALONE_WS_DEFAULT } from './connection-address.ts';

test('browser development uses the page host and one /ws entry point', () => {
  assert.equal(
    defaultConnectionAddress({ protocol: 'http:', host: 'devbox:5173' }, true),
    'ws://devbox:5173/ws',
  );
  assert.equal(
    defaultConnectionAddress({ protocol: 'https:', host: 'devbox.example' }, true),
    'wss://devbox.example/ws',
  );
});

test('standalone and non-browser defaults remain compatible', () => {
  assert.equal(defaultConnectionAddress({ protocol: 'file:', host: '' }, true), STANDALONE_WS_DEFAULT);
  assert.equal(defaultConnectionAddress({ protocol: 'http:', host: 'devbox:5173' }, false), STANDALONE_WS_DEFAULT);
});


// Board #323: a page the gateway served defaults to that gateway, same origin.
test('a gateway-hosted page connects to its own origin, ws or wss by its protocol', () => {
  assert.equal(defaultConnectionAddress({ protocol: 'http:', host: '192.168.1.5:19899', pathname: '/' }, false, true), 'ws://192.168.1.5:19899/ws');
  assert.equal(defaultConnectionAddress({ protocol: 'https:', host: '[::1]:9899', pathname: '/' }, false, true), 'wss://[::1]:9899/ws');
  assert.equal(defaultConnectionAddress({ protocol: 'http:', host: '192.168.1.5:19899' }, false, true), 'ws://192.168.1.5:19899/ws', 'no path is the root');
  assert.equal(defaultConnectionAddress({ protocol: 'http:', host: 'devbox:5173', pathname: '/' }, true, true), 'ws://devbox:5173/ws', 'the marker wins over the Vite proxy rule');
  assert.equal(defaultConnectionAddress({ protocol: 'tauri:', host: 'localhost', pathname: '/' }, false, true), STANDALONE_WS_DEFAULT, 'only an http(s) page');
});

// Board #517: a reverse proxy may serve the gateway's UI under a path prefix
// (the CloudFront secret path) that only the page's URL knows. The default
// keeps the page's own directory, so the socket goes where the page came from.
test('a gateway-hosted page under a path prefix connects inside that prefix', () => {
  const at = (pathname: string) => defaultConnectionAddress({ protocol: 'https:', host: 'cf.example', pathname }, false, true);
  assert.equal(at('/api-0123/'), 'wss://cf.example/api-0123/ws');
  assert.equal(at('/api-0123/index.html'), 'wss://cf.example/api-0123/ws', 'a file names its directory');
  assert.equal(at('/a/b/'), 'wss://cf.example/a/b/ws', 'a deeper prefix');
  assert.equal(at('/'), 'wss://cf.example/ws');
  // The dev page lives at the root behind Vite's /ws proxy, unchanged.
  assert.equal(defaultConnectionAddress({ protocol: 'http:', host: 'devbox:5173', pathname: '/' }, true), 'ws://devbox:5173/ws');
});

test('the marker is a meta tag, read from the document', async () => {
  const { hostedByGateway } = await import('./connection-address.ts');
  assert.equal(hostedByGateway({ querySelector: (s) => (s === 'meta[name="tmm-gateway"]' ? {} : null) }), true);
  assert.equal(hostedByGateway({ querySelector: () => null }), false);
  assert.equal(hostedByGateway(undefined), false);
});

test('local credentials go only to the local gateway, never next to a remote address', async () => {
  const { localAutofill } = await import('./connection-address.ts');
  const cfg = { url: 'wss://[::1]:9900', token: 'tok', tmux_socket: '/s' };
  const blank = { address: 'ws://127.0.0.1:9899', token: '', socket: '' };
  const none = { address: null, token: null, socket: null };
  assert.deepEqual(localAutofill(none, blank, blank, cfg), { address: 'wss://[::1]:9900', token: 'tok', socket: '/s' }, 'a fresh app: the local gateway, whole');
  assert.deepEqual(localAutofill({ address: 'ws://remote:9899', token: null, socket: null }, blank, blank, cfg), {}, 'a saved REMOTE address with no token gets no local token or socket');
  assert.deepEqual(localAutofill(none, blank, { ...blank, address: 'ws://remote:9899' }, cfg), {}, 'a remote address typed while the config loaded: nothing local');
  assert.deepEqual(localAutofill({ address: 'wss://[::1]:9900', token: null, socket: null }, blank, blank, cfg), { token: 'tok', socket: '/s' }, 'a saved LOCAL address with empty fields is filled');
  assert.deepEqual(localAutofill(none, blank, { ...blank, address: '[::1]:9900' }, { ...cfg, url: 'ws://[::1]:9900' }), { token: 'tok', socket: '/s' }, 'typed bare local host:port counts as local');
  assert.deepEqual(localAutofill(none, blank, { ...blank, token: 'mine' }, cfg), { address: 'wss://[::1]:9900', socket: '/s' }, 'a token typed meanwhile is kept');
  assert.deepEqual(localAutofill({ address: 'a', token: 't', socket: 's' }, blank, blank, cfg), {}, 'everything saved: nothing');
  assert.deepEqual(localAutofill(none, blank, blank, {}), {}, 'no config: nothing');
});

test('moving away from the local gateway drops only the untouched auto-filled values', async () => {
  const { dropAutofilled } = await import('./connection-address.ts');
  const auto = { address: 'ws://127.0.0.1:9899', token: 'tok', socket: '/s' };
  assert.deepEqual(dropAutofilled(auto, { address: 'ws://remote:9899', token: 'tok', socket: '/s' }), { clear: { token: '', socket: '' }, keep: null }, 'auto values do not follow to a remote');
  assert.deepEqual(dropAutofilled(auto, { address: 'ws://remote:9899', token: 'typed', socket: '/s' }), { clear: { socket: '' }, keep: null }, 'a typed token stays');
  assert.deepEqual(dropAutofilled(auto, { address: '127.0.0.1:9899', token: 'tok', socket: '/s' }), { clear: {}, keep: auto }, 'still local: nothing changes');
  assert.deepEqual(dropAutofilled(null, { address: 'ws://remote', token: 'tok', socket: '' }), { clear: {}, keep: null }, 'nothing auto-filled (or a history pick forgot it): nothing cleared');
});
