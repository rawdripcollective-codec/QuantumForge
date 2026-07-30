'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Use the test data dir so we don't pollute the real data/
process.chdir(path.resolve(__dirname, '..'));

const selfImprove = require('../src/self-improve');

test('self-improve: analyse detects recurring errors', () => {
  // Inject fake mistakes directly via the memory module
  const memory = require('../src/memory');
  for (let i = 0; i < 3; i++) {
    memory.saveMistake({ type: 'error', action: 'fs.read', detail: 'ENOENT' });
  }
  const insights = selfImprove.analyse();
  const recurring = insights.find(i => i.type === 'recurring_error' && i.trigger === 'fs.read');
  assert.ok(recurring, 'should detect recurring fs.read error');
  assert.ok(recurring.recommendation.length > 0);
});

test('self-improve: analyse detects frequent task patterns', () => {
  const memory = require('../src/memory');
  for (let i = 0; i < 4; i++) {
    memory.saveEpisode({ task: `list files in dir ${i}` });
  }
  const insights = selfImprove.analyse();
  const frequent = insights.find(i => i.type === 'frequent_task');
  assert.ok(frequent, 'should detect frequent task pattern');
});

test('self-improve: analyse detects tool failures', () => {
  const memory = require('../src/memory');
  for (let i = 0; i < 3; i++) {
    memory.saveMistake({ type: 'tool_failure', tool: 'fs.write', detail: 'permission denied' });
  }
  const insights = selfImprove.analyse();
  const toolFail = insights.find(i => i.type === 'tool_failure' && i.trigger === 'fs.write');
  assert.ok(toolFail, 'should detect recurring tool_failure for fs.write');
});

test('self-improve: status() returns expected shape', () => {
  const status = selfImprove.status();
  assert.equal(typeof status.enabled, 'boolean');
  assert.equal(typeof status.useLlm, 'boolean');
  assert.equal(typeof status.schedule, 'string');
  assert.ok(Array.isArray(status.lastInsights));
});

test('self-improve: recordMistake does not throw', () => {
  selfImprove.recordMistake({ type: 'step_rejected', action: 'test step', detail: 'n/a' });
  // No error means success
});

test('self-improve: getLastInsights returns array (empty or populated)', () => {
  const insights = selfImprove.getLastInsights();
  assert.ok(Array.isArray(insights));
});
