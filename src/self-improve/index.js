/**
 * Self-improvement module.
 *
 * Two loops:
 *  1. Recording loop  – kernel.js calls recordMistake() after each failed step
 *  2. Analysis loop    – hourly cron emits insights from mistake + episode data
 *
 * The analysis loop is rule-based by default (no LLM call). Set
 *   SELFIMPROVE_USE_LLM=true
 * to append an optional LLM summarisation step (requires a configured provider).
 *
 * Insights are written back to memory so the kernel can inject them into the
 * planner's context on the next run.
 */

'use strict';

const path = require('path');
const config = require(path.resolve(__dirname, '../../config/default.json'));
const memory = require('../memory');
const log = require('../lib/logger');

const SELFIMPROVE_ENABLED = process.env.SELFIMPROVE_ENABLED !== 'false';
const SELFIMPROVE_USE_LLM = process.env.SELFIMPROVE_USE_LLM === 'true';
const SCHEDULE = process.env.SELFIMPROVE_SCHEDULE || '0 * * * *'; // hourly

// How many recent episodes/mistakes to analyse per cycle
const EPISODE_WINDOW = 20;
const MISTAKE_WINDOW = 20;

/** Minimum occurrences before an insight is emitted */
const THRESHOLD_RECURRING = 2;
const THRESHOLD_FREQUENT = 3;

/** Maximum insights to store per cycle */
const MAX_INSIGHTS = 10;

let _cronHandle = null;
let _running = false;

/**
 * Record a mistake so it can be analysed later.
 * @param {object} detail
 */
function recordMistake(detail) {
  if (!SELFIMPROVE_ENABLED) return;
  const entry = {
    ts: new Date().toISOString(),
    ...detail,
  };
  memory.saveMistake(entry);
  log.info('self-improve: mistake recorded', { type: detail.type, action: detail.action });
}

/**
 * Analyse recent episodes + mistakes and emit insights.
 * Returns an array of insight objects.
 */
function analyse() {
  const episodes = memory.recentEpisodes(EPISODE_WINDOW);
  const mistakes = memory.recentMistakes(MISTAKE_WINDOW);

  const insights = [];

  // ── Recurring-error insight ────────────────────────────────────────────────
  const errorCounts = {};
  for (const m of mistakes) {
    if (m.type === 'error') {
      const key = m.action || m.tool || 'unknown';
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
  }
  for (const [key, count] of Object.entries(errorCounts)) {
    if (count >= THRESHOLD_RECURRING) {
      insights.push({
        type: 'recurring_error',
        trigger: key,
        count,
        recommendation: `Error "${key}" has occurred ${count} times. Investigate the root cause and add a guard or fix.`,
        ts: new Date().toISOString(),
      });
    }
  }

  // ── Frequent-task insight ─────────────────────────────────────────────────
  const taskCounts = {};
  for (const ep of episodes) {
    if (ep.task) {
      // Normalise to a prefix so "list files in dir A" and "list files in dir B"
      // are grouped together.
      const prefix = ep.task.split(' ').slice(0, 3).join(' ');
      taskCounts[prefix] = (taskCounts[prefix] || 0) + 1;
    }
  }
  for (const [prefix, count] of Object.entries(taskCounts)) {
    if (count >= THRESHOLD_FREQUENT) {
      insights.push({
        type: 'frequent_task',
        trigger: prefix,
        count,
        recommendation: `Task pattern "${prefix}…" ran ${count} times. Consider creating a dedicated tool or shortcut.`,
        ts: new Date().toISOString(),
      });
    }
  }

  // ── Tool-failure insight ───────────────────────────────────────────────────
  const toolFailureCounts = {};
  for (const m of mistakes) {
    if (m.type === 'tool_failure' && m.tool) {
      toolFailureCounts[m.tool] = (toolFailureCounts[m.tool] || 0) + 1;
    }
  }
  for (const [tool, count] of Object.entries(toolFailureCounts)) {
    if (count >= THRESHOLD_RECURRING) {
      insights.push({
        type: 'tool_failure',
        trigger: tool,
        count,
        recommendation: `Tool "${tool}" failed ${count} times. Check the schema or add error-handling logic.`,
        ts: new Date().toISOString(),
      });
    }
  }

  return insights.slice(0, MAX_INSIGHTS);
}

/**
 * Store insights in memory so the kernel can read them.
 */
function storeInsights(insights) {
  memory.set('selfImprove.lastInsights', JSON.stringify(insights));
  memory.set('selfImprove.lastRun', new Date().toISOString());
  return insights;
}

/**
 * Get the last stored insights (for the planner context).
 * Returns an empty array if nothing has been stored yet.
 */
function getLastInsights() {
  try {
    const raw = memory.get('selfImprove.lastInsights');
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Run one self-improvement cycle immediately (called by cron or /api/self-improve/run).
 * Returns the insights that were generated.
 */
async function runCycle() {
  if (_running) {
    log.warn('self-improve: cycle already running, skipping');
    return [];
  }
  _running = true;
  try {
    log.info('self-improve: starting cycle');
    const insights = analyse();
    storeInsights(insights);
    log.info('self-improve: cycle complete', { insightCount: insights.length });
    return insights;
  } finally {
    _running = false;
  }
}

/**
 * Start the hourly cron scheduler.
 * Uses a simple setInterval approximation of a cron expression.
 */
function startScheduler() {
  if (_cronHandle) return; // already running
  const MS = 60 * 60 * 1000; // 1 hour

  // Parse SCHEDULE for a more precise initial delay (simple HH:MM parser)
  const match = SCHEDULE.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (match) {
    const minute = parseInt(match[1], 10);
    const hour = parseInt(match[2], 10);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      runCycle();
      _cronHandle = setInterval(runCycle, MS);
    }, delay);
  } else {
    _cronHandle = setInterval(runCycle, MS);
  }

  log.info('self-improve: scheduler started', { schedule: SCHEDULE });
}

/** Stop the scheduler. */
function stopScheduler() {
  if (_cronHandle) {
    clearInterval(_cronHandle);
    _cronHandle = null;
    log.info('self-improve: scheduler stopped');
  }
}

/** Aliases for server.js compatibility. */
const start = startScheduler;
const stop = stopScheduler;

/** Status for the /api/self-improve/status endpoint. */
function status() {
  return {
    enabled: SELFIMPROVE_ENABLED,
    useLlm: SELFIMPROVE_USE_LLM,
    schedule: SCHEDULE,
    lastRun: memory.get('selfImprove.lastRun') || null,
    lastInsights: getLastInsights(),
    running: _running,
  };
}

module.exports = {
  recordMistake,
  runCycle,
  startScheduler,
  stopScheduler,
  start,
  stop,
  status,
  getLastInsights,
  analyse,
};
