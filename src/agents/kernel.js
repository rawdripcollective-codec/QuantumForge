/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 * Runs up to maxRounds retry loops per step before moving on.
 */

'use strict';

const config = require('../../config/default.json');
const planner = require('./planner');
const solver = require('./solver');
const critic = require('./critic');
const memory = require('../memory');

const MAX_ROUNDS = config.agents.maxRounds;

/**
 * Minimal LLM shim – uses OpenAI when OPENAI_API_KEY is set.
 * Falls back to a no-op stub in offline/local-only mode:
 * planning returns a single-step plan echoing the task,
 * solving returns the input wrapped in an offline marker.
 * No intelligent reasoning is performed in stub mode.
 */
async function llmCall(messages, { model, responseFormat } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Offline stub: return a shape that matches the calling agent contract.
    const last = messages[messages.length - 1]?.content || '';
    const promptText = messages.map((m) => String(m?.content || '')).join('\n').toLowerCase();

    if (responseFormat === 'json') {
      if (/\bcritic\b|\bcritique\b|\breview\b|\bverdict\b|\bpass\b|\bfeedback\b/.test(promptText)) {
        return JSON.stringify({ pass: true, feedback: '' });
      }
      if (/\bplanner\b|\bplan\b|\bsteps?\b|\baction\b/.test(promptText)) {
        return JSON.stringify([{ step: 1, action: last }]);
      }
      return JSON.stringify({ result: `[offline] ${last}`, toolsUsed: [] });
    }

    return JSON.stringify({ result: `[offline] ${last}`, toolsUsed: [] });
  }

  const { OpenAI } = require('openai');
  const timeoutMs = Number(config.agents.timeoutMs);
  const clientOptions = { apiKey, baseURL: config.openai.baseURL };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    clientOptions.timeout = timeoutMs;
  }
  const client = new OpenAI(clientOptions);

  const params = { model: model || config.openai.model, messages };
  if (responseFormat === 'json') {
    params.response_format = { type: 'json_object' };
  }

  const completion = await client.chat.completions.create(params);
  return completion.choices[0].message.content;
}

/**
 * Run the full Planner → Solver → Critic loop for a task.
 * @param {string}   task     – natural-language task description
 * @param {object}   context  – optional context/facts
 * @param {Function} onChunk  – optional streaming callback (chunk)
 * @returns {{ steps, results, summary }}
 */
async function run(task, context = {}, onChunk = null) {
  // Enrich context with recent memory
  const recentEps = memory.recentEpisodes(5);
  const enriched = { ...context, recentEpisodes: recentEps };

  const emit = (type, payload) => {
    if (onChunk) onChunk({ type, ...payload });
  };

  emit('planning', { task });
  const steps = await planner.plan(task, enriched, llmCall);
  emit('steps', { steps });

  const results = [];

  for (const step of steps) {
    let solverResult = null;
    let verdict = { pass: false, feedback: '' };
    let round = 0;

    while (!verdict.pass && round < MAX_ROUNDS) {
      round++;
      emit('solving', { step, round });
      solverResult = await solver.solve(step, enriched, llmCall);

      emit('critiquing', { step, solverResult });
      verdict = await critic.critique(step, solverResult, llmCall);
      emit('verdict', { step, verdict });

      if (!verdict.pass) {
        // Feed critic feedback back into context for next round
        enriched.criticFeedback = verdict.feedback;
      }
    }

    // Clear per-step feedback so it doesn't bleed into subsequent steps
    delete enriched.criticFeedback;

    results.push({ step, result: solverResult, rounds: round, accepted: verdict.pass });
  }

  const summary = results.map((r) => `Step ${r.step?.step ?? '?'}: ${r.result?.result ?? ''}`).join('\n');
  return { steps, results, summary };
}

module.exports = { run };
