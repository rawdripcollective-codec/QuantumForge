/**
 * Test fixture: a fake llm.js that returns scripted responses.
 * Replaces the real src/agents/llm.js via require.cache manipulation in test_kernel.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function createLlmCall() {
  let i = 0;
  const responses = [
    // 1st call: planner — return a 2-step plan
    JSON.stringify([
      { step: 1, action: 'Read the README' },
      { step: 2, action: 'Summarize' },
    ]),
    // 2nd call: solver round 1 — final
    JSON.stringify({ type: 'final', result: 'read it', toolsUsed: [] }),
    // 3rd call: critic round 1 — pass
    JSON.stringify({ pass: true, feedback: 'looks good' }),
    // 4th call: solver round 1 for step 2 — final
    JSON.stringify({ type: 'final', result: 'summary text', toolsUsed: [] }),
    // 5th call: critic round 1 for step 2 — pass
    JSON.stringify({ pass: true, feedback: 'great' }),
  ];
  return async (messages, opts) => {
    const r = responses[i] || JSON.stringify({ type: 'final', result: 'fallback', toolsUsed: [] });
    i++;
    return r;
  };
}

module.exports = { createLlmCall, listProviders: () => [], offlineStub: () => '' };
