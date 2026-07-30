'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKernel } = require('../src/agents/kernel');

test('kernel: produces steps + results + summary + costUsd (offline)', async () => {
  const kernel = createKernel({ provider: 'offline' });
  const result = await kernel.run('Do a thing', {});
  assert.ok(Array.isArray(result.steps));
  assert.ok(Array.isArray(result.results));
  assert.equal(typeof result.summary, 'string');
  assert.equal(typeof result.costUsd, 'number');
  // Offline stub returns 1 step with the task as action
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, 'Do a thing');
});

test('kernel: enriches context with recent episodes (offline)', async () => {
  const kernel = createKernel({ provider: 'offline' });
  const result = await kernel.run('Read the README', { userFact: 'I am a developer' });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, 'Read the README');
});

test('kernel: emits chunks via onChunk callback (offline)', async () => {
  const events = [];
  const kernel = createKernel({ provider: 'offline' });
  await kernel.run('Hi', {}, (chunk) => events.push(chunk));
  const types = events.map(e => e.type);
  assert.ok(types.includes('planning'),  `expected planning in ${types.join(',')}`);
  assert.ok(types.includes('steps'),     `expected steps in ${types.join(',')}`);
  assert.ok(types.includes('solving'),   `expected solving in ${types.join(',')}`);
  assert.ok(types.includes('critiquing'),`expected critiquing in ${types.join(',')}`);
  assert.ok(types.includes('verdict'),   `expected verdict in ${types.join(',')}`);
});

test('kernel: provider() reports the active provider', () => {
  const k1 = createKernel({ provider: 'offline' });
  const k2 = createKernel({ provider: 'ollama' });
  assert.equal(k1.provider(), 'offline');
  assert.equal(k2.provider(), 'ollama');
});

test('kernel: returns the costUsd in the result (zero for offline stub)', async () => {
  const kernel = createKernel({ provider: 'offline' });
  const result = await kernel.run('test');
  // Offline stub doesn't actually call the LLM, so cost should be 0
  assert.equal(result.costUsd, 0);
});
