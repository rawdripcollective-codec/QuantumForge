/**
 * Self-Improvement module.
 * Runs on a cron schedule: analyses mistake logs, extracts lessons,
 * and stores them in memory for future agent runs.
 */

'use strict';

const cron = require('node-cron');
const config = require('../../config/default.json');
const memory = require('../memory');

let _task = null;
let _lastRun = null;
let _lastReport = null;

/**
 * Analyse recent mistakes and usage episodes to produce improvement insights.
 */
async function run() {
  const mistakes = memory.recentMistakes(20);
  const episodes = memory.recentEpisodes(20);

  const insights = [];

  const errorThreshold = config.selfImprove.recurringErrorThreshold || 2;
  const taskThreshold = config.selfImprove.frequentTaskThreshold || 3;

  // Simple rule-based analysis (works offline, no LLM required)
  const errorCounts = {};
  for (const m of mistakes) {
    const key = m.error || 'unknown';
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }

  for (const [err, count] of Object.entries(errorCounts)) {
    if (count >= errorThreshold) {
      insights.push({ type: 'recurring_error', error: err, count, lesson: `Recurring error "${err}" – review handler logic` });
    }
  }

  // Track most-used task patterns
  const taskPatterns = {};
  for (const ep of episodes) {
    const key = (ep.task || '').slice(0, 50);
    taskPatterns[key] = (taskPatterns[key] || 0) + 1;
  }

  for (const [pattern, count] of Object.entries(taskPatterns)) {
    if (count >= taskThreshold) {
      insights.push({ type: 'frequent_task', pattern, count, lesson: `Frequent task pattern: "${pattern}" – consider caching` });
    }
  }

  // Persist insights in memory
  memory.set('selfImprove.lastInsights', insights);
  memory.set('selfImprove.lastRunTs', new Date().toISOString());

  _lastRun = new Date().toISOString();
  _lastReport = { insights, mistakesAnalysed: mistakes.length, episodesAnalysed: episodes.length };

  return _lastReport;
}

/** Start the scheduled self-improvement cron job. */
function start() {
  if (!config.selfImprove.enabled) return;

  _task = cron.schedule(config.selfImprove.cronSchedule, async () => {
    try {
      await run();
      console.log('[self-improve] cycle complete –', _lastReport?.insights?.length ?? 0, 'insights');
    } catch (err) {
      console.error('[self-improve] error:', err.message);
    }
  });

  console.log('[self-improve] scheduler started, schedule:', config.selfImprove.cronSchedule);
}

function stop() {
  if (_task) {
    _task.stop();
    _task = null;
  }
}

function status() {
  return {
    enabled: config.selfImprove.enabled,
    schedule: config.selfImprove.cronSchedule,
    lastRun: _lastRun,
    lastReport: _lastReport,
    running: !!_task
  };
}

module.exports = { run, start, stop, status };
