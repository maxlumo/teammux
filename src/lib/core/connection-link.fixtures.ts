// Texts that carry a credential but cannot be used as a connection (#401). The
// shared fixture of every form that takes an address: each must be refused
// with the field restored and no part of the text left in view. The "tokens"
// are fake and recognisable so a test can look for them.
export const REJECTED_LINKS: [string, string][] = [
  ['an old token-only link', 'https://front.example/?token=SECRET-ONE'],
  ['an old token-only link in the hash', 'https://front.example/#/files?token=SECRET-ONE'],
  ['an old token-and-socket link', 'https://front.example/?token=SECRET-ONE&socket=%2Fsecret-socket'],
  ['a link naming no host', 'ws://?token=SECRET-ONE'],
  ['a link naming an empty host', 'wss:///?token=SECRET-ONE'],
  ['an old link with a malformed address', 'https://front.example/?addr=wss%3A%2F%2F%25ZZ&token=SECRET-ONE'],
  ['text with a token in it', 'connect to it ?token=SECRET-ONE'],
  ['a bare token parameter', 'token=SECRET-ONE'],
  ['an empty token value and no address', 'https://front.example/?token='],
  ['a repeated token', 'wss://other.example/ws?token=SECRET-ONE&token=SECRET-TWO'],
  ['an old link with a repeated token', 'https://front.example/?addr=ws%3A%2F%2Fh%3A1&token=SECRET-ONE&token=SECRET-TWO'],
  ['an old link with a repeated socket', 'https://front.example/?addr=ws%3A%2F%2Fh%3A1&socket=%2Fsecret-socket&socket=%2Fsecret-two'],
  ['a credential in the hash of a ws link', 'ws://other.example/ws#?token=SECRET-ONE'],
  ['a credential in the hash after a query', 'wss://other.example/ws?x=1#token=SECRET-ONE'],
  ['a credential in a front end hash', 'https://front.example/#token=SECRET-ONE'],
  ['text with an encoded credential key', 'connect to it ?%74oken=SECRET-ONE'],
  ['an upper-case credential key', 'https://front.example/?TOKEN=SECRET-ONE'],
  ['an old addr that hides a token in its fragment', 'https://front.example/?addr=wss%3A%2F%2Fh%2Fws%23token%3DSECRET-ONE&token=OUTER-TOKEN'],
  ['an old address that hides a socket in its fragment', 'https://front.example/?address=wss%3A%2F%2Fh%2Fws%23socket%3D%252Fsecret-socket&token=OUTER-TOKEN'],
  ['an old link whose addr is an http address', 'https://front.example/?addr=http%3A%2F%2Fh%3A1&token=SECRET-ONE'],
  ['an endpoint with user info and a password', 'wss://user:SECRET-ONE@h.example/ws'],
  ['a bare user@host:port', 'user:SECRET-ONE@h.example:9899'],
  ['an old addr that is mailto:a@b', 'https://front.example/?addr=mailto%3Aa%40b&token=OUTER-TOKEN'],
  ['an old addr with user info and a password', 'https://front.example/?addr=wss%3A%2F%2Fu%3ASECRET-ONE%40h%2Fws&token=OUTER-TOKEN'],
  ['an old server with an ordinary fragment', 'https://front.example/?server=wss%3A%2F%2Fh%2Fws%23frag&token=OUTER-TOKEN'],
  ['an old addr that hides an encoded token key in its query', 'https://front.example/?addr=wss%3A%2F%2Fh%2Fws%3F%2574oken%3DSECRET-ONE&token=OUTER-TOKEN'],
];
