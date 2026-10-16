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
  ['a credential in the hash of a ws link', 'ws://other.example/ws#?token=SECRET-ONE'],
  ['a credential in the hash after a query', 'wss://other.example/ws?x=1#token=SECRET-ONE'],
  ['a credential in a front end hash', 'https://front.example/#token=SECRET-ONE'],
  ['text with an encoded credential key', 'connect to it ?%74oken=SECRET-ONE'],
  ['an upper-case credential key', 'https://front.example/?TOKEN=SECRET-ONE'],
];
