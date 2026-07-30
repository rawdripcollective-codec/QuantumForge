'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cost = require('../src/lib/cost');

test('cost: record() computes USD from token counts', () => {
  cost.reset();
  cost.setBudget(1.00);
  // gpt-4o-mini: in 0.00015/1K, out 0.0006/1K
  const usd = cost.record({ provider: 'openai', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 1000 });
  // 0.00015 + 0.0006 = 0.00075
  assert.ok(Math.abs(usd - 0.00075) < 1e-6, `expected ~0.00075, got ${usd}`);
});

test('cost: total() accumulates across calls', () => {
  cost.reset();
  cost.setBudget(1.00);
  cost.record({ provider: 'openai', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 0 });
  cost.record({ provider: 'openai', model: 'gpt-4o-mini', promptTokens: 0,    completionTokens: 1000 });
  assert.ok(Math.abs(cost.total() - 0.00075) < 1e-6);
});

test('cost: throws BudgetExceeded when budget is hit', () => {
  cost.reset();
  cost.setBudget(0.0001);  // tiny budget
  // A single gpt-4o call with 1000+1000 tokens = $0.0125 — exceeds budget
  assert.throws(() => {
    cost.record({ provider: 'openai', model: 'gpt-4o', promptTokens: 1000, completionTokens: 1000 });
  }, /budget exceeded/i);
});

test('cost: unknown model returns 0 (free)', () => {
  cost.reset();
  cost.setBudget(1.00);
  const usd = cost.record({ provider: 'custom', model: 'never-seen-model', promptTokens: 1000000, completionTokens: 1000000 });
  assert.equal(usd, 0);
});

test('cost: OpenRouter-style model id (with vendor prefix) resolves correctly', () => {
  cost.reset();
  cost.setBudget(1.00);
  // "anthropic/claude-3-5-sonnet" should map to claude-3-5-sonnet-latest ($0.003/$0.015)
  const usd = cost.record({ provider: 'openrouter', model: 'anthropic/claude-3-5-sonnet', promptTokens: 1000, completionTokens: 1000 });
  // 0.003 + 0.015 = 0.018
  assert.ok(Math.abs(usd - 0.018) < 1e-6, `expected ~0.018, got ${usd}`);
});

test('cost: reset() clears the running total', () => {
  cost.reset();
  cost.setBudget(1.00);
  cost.record({ provider: 'openai', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 0 });
  assert.ok(cost.total() > 0);
  cost.reset();
  assert.equal(cost.total(), 0);
});
