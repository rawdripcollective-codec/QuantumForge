/**
 * Self-Improvement module.
 * When OPENAI_API_KEY is set, uses an LLM to derive rich insights from the
 * recent mistake and episode log.  Falls back to rule-based analysis offline.
 */

'use strict';

const cron = require('node-cron');
const { OpenAI } = require('openai');
const config = require('../../config/default.json');
const memory = require('../memory');

let _task = null;
let _lastRun = null;
let _lastReport = null;

// ── Rule-based analysis (offline, no LLM) ────────────────────────────────────

function ruleBasedAnalysis(mistakes, episodes) {
  const insights = [];

  const errorThreshold = config.selfImprove.recurringErrorThreshold || 2;
  const taskThreshold  = config.selfImprove.frequentTaskThreshold   || 3;

  // Recurring errors
  const errorCounts = {};
  for (const m of mistakes) {
    const key = m.error || 'unknown';
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count >= errorThreshold) {
      insights.push({
        type: 'recurring_error',
        error: err,
        count,
        lesson: `Recurring error "${err}" – review handler logic`
      });
    }
  }

  // Frequent task patterns
  const taskPatterns = {};
  for (const ep of episodes) {
    const key = (ep.task || '').slice(0, 50);
    taskPatterns[key] = (taskPatterns[key] || 0) + 1;
  }
  for (const [pattern, count] of Object.entries(taskPatterns)) {
    if (count >= taskThreshold) {
      insights.push({
        type: 'frequent_task',
        pattern,
        count,
        lesson: `Frequent task pattern: "${pattern}" – consider caching`
      });
    }
  }

  return insights;
}

// ── LLM-based analysis (requires OPENAI_API_KEY) ──────────────────────────────

async function llmAnalysis(mistakes, episodes) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: config.openai.baseURL });

  const mistakesSummary = mistakes.slice(-10).map((m) => ({
    task: m.task, error: m.error, ts: m.ts
  }));
  const episodesSummary = episodes.slice(-10).map((e) => ({
    task: e.task, summary: e.result?.summary, ts: e.ts
  }));

  const prompt = `You are an AI self-improvement analyst reviewing an AI agent system's recent activity.

Recent mistakes (last ${mistakesSummary.length}):
${JSON.stringify(mistakesSummary, null, 2)}

Recent episodes (last ${episodesSummary.length}):
${JSON.stringify(episodesSummary, null, 2)}

Identify patterns, root causes, and actionable improvement opportunities.
Return a JSON object with key "insights" containing an array of objects:
[{"type": "string", "lesson": "actionable advice (1-2 sentences)", "detail": "optional detail"}]
Types can be: recurring_error, frequent_task, performance_tip, capability_gap, or other.`;

  const completion = await client.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    timeout: 30000
  });

  const raw = completion.choices[0].message.content;
  try {
    const parsed = JSON.parse(raw);
    const insights = Array.isArray(parsed) ? parsed : (parsed.insights || []);
    return insights.filter((i) => i && typeof i.lesson === 'string');
  } catch {
    // Gracefully degrade to rule-based if the LLM response is unparseable
    return ruleBasedAnalysis(mistakes, episodes);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse recent mistakes and usage episodes to produce improvement insights.
 * Uses LLM analysis when OPENAI_API_KEY is available; falls back to rule-based.
 */
async function run() {
  const mistakes = memory.recentMistakes(20);
  const episodes = memory.recentEpisodes(20);

  let insights;
  try {
    if (process.env.OPENAI_API_KEY) {
      insights = await llmAnalysis(mistakes, episodes);
    } else {
      insights = ruleBasedAnalysis(mistakes, episodes);
    }
  } catch (err) {
    console.warn('[self-improve] LLM analysis failed, falling back to rule-based:', err.message);
    insights = ruleBasedAnalysis(mistakes, episodes);
  }

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
    enabled:    config.selfImprove.enabled,
    schedule:   config.selfImprove.cronSchedule,
    lastRun:    _lastRun,
    lastReport: _lastReport,
    running:    !!_task
  };
}

module.exports = { run, start, stop, status };
