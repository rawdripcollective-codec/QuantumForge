'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, normalize, repairJson, MAX_STEPS, MIN_STEPS, SYSTEM } = require('../src/agents/planner');
const { mockLlm } = require('./helpers');

test('planner: returns a single-step plan from a clean JSON array', async () => {
  const llmCall = mockLlm([JSON.stringify([{ step: 1, action: 'Read the README' }])]);
  const steps = await plan('Understand the project', {}, llmCall);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'Read the README');
  assert.equal(steps[0].step, 1);
});

test('planner: returns multiple steps for a complex task', async () => {
  const llmCall = mockLlm([JSON.stringify([
    { step: 1, action: 'List the project files' },
    { step: 2, action: 'Read package.json' },
    { step: 3, action: 'Summarize the architecture' },
  ])]);
  const steps = await plan('Understand the project', {}, llmCall);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map(s => s.step), [1, 2, 3]);
});

test('planner: falls back to a single-step plan when the LLM returns non-JSON', async () => {
  const llmCall = mockLlm(['Sure! Here is a plan:\n1. Do the thing.']);
  const steps = await plan('Do the thing', {}, llmCall);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'Do the thing');
});

test('planner: truncates plans that exceed MAX_STEPS', async () => {
  const tooMany = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({
    step: i + 1, action: `Step ${i + 1}`,
  }));
  const llmCall = mockLlm([JSON.stringify(tooMany)]);
  const steps = await plan('Big task', {}, llmCall);
  assert.equal(steps.length, MAX_STEPS);
  assert.deepEqual(steps.map(s => s.step), Array.from({ length: MAX_STEPS }, (_, i) => i + 1));
});

test('planner: returns a fallback step when the LLM returns an empty array', async () => {
  const llmCall = mockLlm([JSON.stringify([])]);
  const steps = await plan('Mystery task', {}, llmCall);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'Mystery task');
});

test('planner: throws nothing on LLM call failure — falls back gracefully', async () => {
  const llmCall = async () => { throw new Error('rate limited'); };
  const steps = await plan('Do something', {}, llmCall);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, 'Do something');
});

test('planner: includes recentEpisodes in the user message when provided', async () => {
  let captured = null;
  const llmCall = async (messages) => {
    captured = messages.find(m => m.role === 'user')?.content || '';
    return JSON.stringify([{ step: 1, action: 'ok' }]);
  };
  await plan('Do X', {
    recentEpisodes: [
      { task: 'previous task A', result: { summary: 'did A' } },
    ],
    userFact: 'I prefer TypeScript',
  }, llmCall);
  assert.match(captured, /recentEpisodes/);
  assert.match(captured, /userFact/);
  assert.match(captured, /TypeScript/);
});

test('normalize: renumbers steps sequentially when given out-of-order step numbers', () => {
  const out = normalize([{ step: 7, action: 'a' }, { step: 3, action: 'b' }], 'fallback');
  assert.deepEqual(out.map(s => s.step), [1, 2]);
});

test('normalize: drops malformed entries silently', () => {
  const out = normalize([
    { step: 1, action: 'good' },
    null,
    { step: 2 },                  // no action
    { step: 3, action: '  ' },    // blank action
    { step: 4, action: 'also good' },
  ], 'fallback');
  assert.equal(out.length, 2);
  assert.equal(out[0].action, 'good');
  assert.equal(out[1].action, 'also good');
});

test('repairJson: strips ```json fences', () => {
  assert.equal(repairJson('```json\n[1,2]\n```'), '[1,2]');
});

test('repairJson: strips "Here is the plan:" prefix', () => {
  assert.equal(repairJson('Here is the plan: [1,2]'), '[1,2]');
});

test('SYSTEM prompt: declares the strict output schema', () => {
  assert.match(SYSTEM, /JSON array/);
  assert.match(SYSTEM, /"step"/);
  assert.match(SYSTEM, /"action"/);
});
