'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { freshRequire, stubModule, withTempCwd } = require('../support/helpers');

const memoryModulePath = path.join(__dirname, '..', 'src', 'memory', 'index.js');
const selfImproveModulePath = path.join(__dirname, '..', 'src', 'self-improve', 'index.js');

async function withSelfImproveHarness(fn) {
  return withTempCwd(async () => {
    const scheduled = [];
    let stopCalled = false;
    const restoreCron = stubModule('node-cron', {
      schedule(expression, task) {
        scheduled.push({ expression, fn: task });
        return {
          stop() {
            stopCalled = true;
          }
        };
      }
    });

    try {
      const selfImprove = freshRequire(selfImproveModulePath, [memoryModulePath]);
      const memory = require(memoryModulePath);
      await fn({ selfImprove, memory, scheduled, wasStopped: () => stopCalled });
    } finally {
      restoreCron();
    }
  });
}

test('self-improve generates insights, persists them, and updates status', async () => {
  await withSelfImproveHarness(async ({ selfImprove, memory }) => {
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
});

test('self-improve start and stop manage the cron scheduler lifecycle', () => {
  return withSelfImproveHarness(async ({ selfImprove, scheduled, wasStopped }) => {
    selfImprove.start();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].expression, '0 * * * *');
    assert.equal(typeof scheduled[0].fn, 'function');
    assert.equal(selfImprove.status().running, true);

    selfImprove.stop();
    assert.equal(wasStopped(), true);
    assert.equal(selfImprove.status().running, false);
  });
});

test('self-improve logs scheduler callback errors without throwing', async () => {
  await withSelfImproveHarness(async ({ selfImprove, memory, scheduled }) => {
    const error = console.error;
    const logs = [];
    const originalRecentMistakes = memory.recentMistakes;
    const priorSchedules = scheduled.length;

    console.error = (...args) => logs.push(args.join(' '));
    memory.recentMistakes = () => {
      throw new Error('cron failure');
    };

    try {
      selfImprove.start();
      const scheduledJob = scheduled[priorSchedules];
      await scheduledJob.fn();
      assert.equal(logs.some((entry) => entry.includes('[self-improve] error: cron failure')), true);
    } finally {
      memory.recentMistakes = originalRecentMistakes;
      console.error = error;
      selfImprove.stop();
    }
  });
});
