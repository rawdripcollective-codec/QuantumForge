'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../src/lib/retry');

test('retry: returns the first successful result', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return 'ok'; }, () => false);
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('retry: retries on retriable errors up to maxAttempts', async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
      return 'ok';
    },
    () => true,
    { maxAttempts: 5, baseMs: 1, maxMs: 5, jitter: 0 }
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('retry: does not retry on non-retriable errors', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(
    async () => { calls++; throw new Error('400 bad request'); },
    (err) => !/400/.test(err.message),
    { maxAttempts: 5, baseMs: 1, maxMs: 5, jitter: 0 }
  ));
  assert.equal(calls, 1);
});

test('retry: throws the last error after maxAttempts', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(
    async () => { calls++; throw new Error('always fail'); },
    () => true,
    { maxAttempts: 3, baseMs: 1, maxMs: 5, jitter: 0 }
  ));
  assert.equal(calls, 3);
});

test('retry: calls onRetry hook with attempt + delay', async () => {
  const events = [];
  await assert.rejects(() => withRetry(
    async () => { throw new Error('x'); },
    () => true,
    { maxAttempts: 2, baseMs: 1, maxMs: 5, jitter: 0, onRetry: (e, n, d) => events.push({ n, d }) }
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].n, 1);
  assert.ok(typeof events[0].d === 'number');
});
