/**
 * Test helpers — mock LLM calls and avoid touching real config / data dirs.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Create a mock llmCall that returns scripted responses in order.
 * Each call to the mock consumes the next response. If exhausted, the
 * remaining calls echo the last user message.
 */
function mockLlm(responses) {
  let i = 0;
  return async (messages, opts) => {
    const next = responses[i] || (() => {
      const last = messages[messages.length - 1]?.content || '';
      return JSON.stringify({ type: 'final', result: last, toolsUsed: [] });
    });
    i++;
    return typeof next === 'function' ? next(messages, opts) : next;
  };
}

/** Set the QFORGE_DATA_DIR env var to a fresh temp dir for the test process.
 *  Used so tests don't pollute the user's data/ directory. */
function withTempDataDir(fn) {
  const orig = {
    memory: process.env.QFORGE_MEMORY_PATH,
    eps:    process.env.QFORGE_EPISODES_PATH,
    mis:    process.env.QFORGE_MISTAKES_PATH,
    reg:    process.env.QFORGE_REGISTRY_PATH,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-test-'));
  process.env.QFORGE_MEMORY_PATH    = path.join(dir, 'memory.json');
  process.env.QFORGE_EPISODES_PATH  = path.join(dir, 'episodes.json');
  process.env.QFORGE_MISTAKES_PATH  = path.join(dir, 'mistakes.json');
  process.env.QFORGE_REGISTRY_PATH  = path.join(dir, 'registry.json');
  return Promise.resolve(fn(dir)).finally(() => {
    for (const k of Object.keys(orig)) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

module.exports = { mockLlm, withTempDataDir };
