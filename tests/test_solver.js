'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, parseDecision, MAX_TOOL_CALLS } = require('../src/agents/solver');
const mcpFabric = require('../src/mcp/fabric');
const { mockLlm } = require('./helpers');

// Ensure the built-in tools are registered (they register on require of fabric.js)
function ensureFabric() {
  // Touch listTools to force module load
  return mcpFabric.listTools().map(t => t.name);
}

test('solver: returns a final result without invoking any tools', async () => {
  ensureFabric();
  const llmCall = mockLlm([JSON.stringify({
    type: 'final',
    result: '42',
    toolsUsed: [],
  })]);
  const out = await solve({ step: 1, action: 'Compute 6*7' }, {}, llmCall);
  assert.equal(out.result, '42');
  assert.deepEqual(out.toolsUsed, []);
});

test('solver: invokes a tool and reports it in toolsUsed', async () => {
  ensureFabric();
  const llmCall = mockLlm([
    // Round 1: ask to read the README
    JSON.stringify({ type: 'tool', name: 'fs.read', args: { path: './README.md' }, thought: 'read it' }),
    // Round 2: return final
    JSON.stringify({ type: 'final', result: 'done', toolsUsed: ['fs.read'] }),
  ]);
  const out = await solve({ step: 1, action: 'Read README' }, {}, llmCall);
  assert.equal(out.result, 'done');
  assert.ok(out.toolsUsed.includes('fs.read'));
});

test('solver: handles tool errors gracefully and recovers with a final', async () => {
  ensureFabric();
  const llmCall = mockLlm([
    // Round 1: ask to read a non-existent file
    JSON.stringify({ type: 'tool', name: 'fs.read', args: { path: './does-not-exist.txt' } }),
    // Round 2: should fall back to a final
    JSON.stringify({ type: 'final', result: 'failed but ok', toolsUsed: ['fs.read'] }),
  ]);
  const out = await solve({ step: 1, action: 'Try to read' }, {}, llmCall);
  assert.equal(out.result, 'failed but ok');
  assert.ok(out.toolsUsed.includes('fs.read'));
});

test('solver: handles unknown tool name by asking the LLM to recover', async () => {
  ensureFabric();
  const llmCall = mockLlm([
    JSON.stringify({ type: 'tool', name: 'mystery.tool', args: {} }),
    JSON.stringify({ type: 'final', result: 'no mystery tool', toolsUsed: [] }),
  ]);
  const out = await solve({ step: 1, action: 'Try mystery' }, {}, llmCall);
  assert.equal(out.result, 'no mystery tool');
  // The unknown tool should not be in toolsUsed
  assert.ok(!out.toolsUsed.includes('mystery.tool'));
});

test('solver: enforces the MAX_TOOL_CALLS cap', async () => {
  ensureFabric();
  // Always request another tool call; the solver should give up after MAX_TOOL_CALLS
  const llmCall = mockLlm(Array.from({ length: MAX_TOOL_CALLS + 3 }, () =>
    JSON.stringify({ type: 'tool', name: 'fs.list', args: { path: '.' } })
  ));
  const out = await solve({ step: 1, action: 'Loop forever' }, {}, llmCall);
  assert.match(out.result, /Reached tool-call limit/);
  // Each successful call adds one to toolsUsed; should be capped at MAX_TOOL_CALLS
  assert.ok(out.toolsUsed.length <= MAX_TOOL_CALLS);
});

test('solver: treats non-JSON response as a free-form final result', async () => {
  ensureFabric();
  const llmCall = mockLlm(['The answer is 42.']);
  const out = await solve({ step: 1, action: 'Compute' }, {}, llmCall);
  assert.match(out.result, /42/);
});

test('solver: handles LLM call failure without throwing', async () => {
  ensureFabric();
  const llmCall = async () => { throw new Error('LLM down'); };
  const out = await solve({ step: 1, action: 'Compute' }, {}, llmCall);
  assert.match(out.result, /solver error/);
});

test('parseDecision: returns null on invalid JSON', () => {
  assert.equal(parseDecision('not json'), null);
  assert.equal(parseDecision(''), null);
  assert.equal(parseDecision(null), null);
});

test('parseDecision: parses final decisions', () => {
  const d = parseDecision('{"type":"final","result":"ok","toolsUsed":["a"]}');
  assert.equal(d.type, 'final');
  assert.equal(d.result, 'ok');
  assert.deepEqual(d.toolsUsed, ['a']);
});

test('parseDecision: parses tool decisions', () => {
  const d = parseDecision('{"type":"tool","name":"fs.read","args":{"path":"./x"}}');
  assert.equal(d.type, 'tool');
  assert.equal(d.name, 'fs.read');
  assert.deepEqual(d.args, { path: './x' });
});

test('parseDecision: strips ```json fences', () => {
  const d = parseDecision('```json\n{"type":"final","result":"x","toolsUsed":[]}\n```');
  assert.equal(d?.type, 'final');
  assert.equal(d?.result, 'x');
});
