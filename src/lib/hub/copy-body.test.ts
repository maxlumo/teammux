import assert from 'node:assert/strict';
import test from 'node:test';
import { copyBody } from './copy-body.ts';

test('copyBody drops only the leading run of @addresses (#68)', () => {
  const cases: [string, string][] = [
    ['@alice Review this.', 'Review this.'],
    ['@alice @bob, please look', 'please look'],
    ['@builder：请看一下', '请看一下'],
    ['  @kiro /goal ship it', '/goal ship it'],
    ['@alice\nline two', 'line two'],
    ['Ask @alice later', 'Ask @alice later'],
    ['me@alice.dev wrote this', 'me@alice.dev wrote this'],
    ['@alice', ''],
    ['@human', ''],
    ['@alice @bob', ''],
    ['no addresses', 'no addresses'],
  ];
  for (const [body, copied] of cases) assert.equal(copyBody(body), copied, body);
});
