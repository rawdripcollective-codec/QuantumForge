'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { freshRequire, stubModule } = require('./helpers');

const memoryModulePath = path.join(__dirname, '..', 'src', 'memory', 'index.js');
const selfImproveModulePath = path.join(__dirname, '..', 'src', 'self-improve', 'index.js');

test('self-improve generates insights, persists them, and updates status', async () => {
  const selfImprove = freshRequire(selfImproveModulePath);
  const memory = require(memoryModulePath);
  const original = {
    recentMistakes: memory.recentMistakes,
    recentEpisodes: memory.recentEpisodes,
    set: memory.set
  };
  const setCalls = [];

  memory.recentMistakes = () => [
    { error: 'timeout' },
    { error: 'timeout' },
    { error: 'rate limit' }
  ];
  memory.recentEpisodes = () => [
    { task: 'summarize repository docs for agents' },
    { task: 'summarize repository docs for agents' },
    { task: 'summarize repository docs for agents' },
    { task: 'other task' }
  ];
  memory.set = (key, value) => setCalls.push([key, value]);

  try {
    const report = await selfImprove.run();

    assert.equal(report.mistakesAnalysed, 3);
    assert.equal(report.episodesAnalysed, 4);
    assert.equal(report.insights.length, 2);
    assert.deepEqual(
      report.insights.map((insight) => insight.type).sort(),
      ['frequent_task', 'recurring_error']
    );
    assert.equal(setCalls[0][0], 'selfImprove.lastInsights');
    assert.equal(setCalls[1][0], 'selfImprove.lastRunTs');
    assert.match(setCalls[1][1], /\d{4}-\d{2}-\d{2}T/);

    const status = selfImprove.status();
    assert.equal(status.running, false);
    assert.equal(status.lastReport.mistakesAnalysed, 3);
    assert.equal(status.lastReport.insights.length, 2);
  } finally {
    memory.recentMistakes = original.recentMistakes;
    memory.recentEpisodes = original.recentEpisodes;
    memory.set = original.set;
  }
});

test('self-improve start and stop manage the cron scheduler lifecycle', () => {
  let stopCalled = false;
  const scheduled = [];
  const restoreCron = stubModule('node-cron', {
    schedule(expression, fn) {
      scheduled.push({ expression, fn });
      return {
        stop() {
          stopCalled = true;
        }
      };
    }
  });

  try {
    const selfImprove = freshRequire(selfImproveModulePath);

    selfImprove.start();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].expression, '0 * * * *');
    assert.equal(typeof scheduled[0].fn, 'function');
    assert.equal(selfImprove.status().running, true);

    selfImprove.stop();
    assert.equal(stopCalled, true);
    assert.equal(selfImprove.status().running, false);
  } finally {
    restoreCron();
  }
});
