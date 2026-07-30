'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlmCall, createLlmStream, listProviders, offlineStub } = require('../src/agents/llm');

test('llm: offline stub returns planner JSON when system message identifies the planner', () => {
  const out = offlineStub(
    [
      { role: 'system', content: 'You are the Planner agent in a multi-step task system.' },
      { role: 'user',   content: 'Task: list the files' },
    ],
    { responseFormat: 'json' }
  );
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].step, 1);
  assert.equal(parsed[0].action, 'list the files');
});

test('llm: offline stub returns critic JSON when system message identifies the critic', () => {
  const out = offlineStub(
    [
      { role: 'system', content: 'You are the Critic agent. Return a verdict.' },
      { role: 'user',   content: 'Some result' },
    ],
    { responseFormat: 'json' }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.pass, true);
});

test('llm: offline stub returns final JSON when system message identifies the solver', () => {
  const out = offlineStub(
    [
      { role: 'system', content: 'You are the Solver agent. Execute exactly one step of a multi-step plan.' },
      { role: 'user',   content: 'Step 1: read the file' },
    ],
    { responseFormat: 'json' }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.type, 'final');
  assert.ok(parsed.result.startsWith('[offline]'));
  assert.match(parsed.result, /read the file/);
});

test('llm: offline stub returns plain string for non-JSON', () => {
  const out = offlineStub(
    [{ role: 'user', content: 'Say hello' }],
    {}
  );
  assert.match(out, /\[offline\]/);
  assert.match(out, /hello/i);
});

test('llm: createLlmCall returns the offline stub when provider="offline"', async () => {
  const { call: llmCall, provider } = createLlmCall({ provider: 'offline' });
  assert.equal(provider, 'offline');
  const out = await llmCall(
    [
      { role: 'system', content: 'You are the Planner agent in a multi-step task system.' },
      { role: 'user',   content: 'Task: do stuff' },
    ],
    { responseFormat: 'json' }
  );
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].step, 1);
  assert.equal(parsed[0].action, 'do stuff');
});

test('llm: createLlmCall throws on unknown provider', () => {
  assert.throws(() => createLlmCall({ provider: 'mystery' }), /Unknown LLM provider/);
});

test('llm: listProviders reports which providers are configured', () => {
  const list = listProviders();
  assert.ok(Array.isArray(list));
  for (const p of list) {
    assert.ok(typeof p.name === 'string');
    assert.ok(typeof p.configured === 'boolean');
  }
  // ollama is "configured" if you can reach localhost:11434 — we don't check
  // that here, just that it appears in the list.
  assert.ok(list.some(p => p.name === 'ollama'));
});

test('llm: offline stub echoes the last user message when no keywords match', () => {
  const out = offlineStub(
    [{ role: 'user', content: 'the unique phrase xyzzy' }],
    { responseFormat: 'json' }
  );
  const parsed = JSON.parse(out);
  assert.ok(parsed.result.includes('xyzzy'));
});

test('llm: createLlmStream returns an async generator for offline provider', async () => {
  const { stream, provider } = createLlmStream({ provider: 'offline' });
  assert.equal(provider, 'offline');
  assert.equal(typeof stream, 'function');
  const chunks = [];
  for await (const chunk of stream(
    [
      { role: 'system', content: 'You are the Planner agent.' },
      { role: 'user',   content: 'Task: do stuff' },
    ],
    { responseFormat: 'json' }
  )) {
    chunks.push(chunk);
  }
  assert.ok(chunks.length > 0, 'should yield at least one chunk');
  // Offline stream yields the full stub output as a single chunk
  const full = chunks.join('');
  assert.ok(full.includes('do stuff'));
});

test('llm: createLlmStream throws for unknown provider', () => {
  assert.throws(
    () => createLlmStream({ provider: 'unknown-provider' }),
    /Unknown LLM provider/
  );
});
