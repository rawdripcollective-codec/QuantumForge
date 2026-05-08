/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 *
 * Steps with no unmet dependencies are executed in parallel (Promise.all).
 * Each step may declare `dependsOn: [stepNumber, ...]`; the kernel runs waves
 * of ready steps until all are complete.
 * A run-scoped scratchpad accumulates solver results so later steps can
 * reference earlier ones via `context.scratchpad`.
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
        return JSON.stringify([{ step: 1, action: last, dependsOn: [] }]);
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
 * Execute a single step through the Solver → Critic retry loop.
 * @param {object}   step        – step descriptor from the planner
 * @param {object}   baseContext – shared enriched context + scratchpad snapshot
 * @param {Function} emit        – streaming callback
 * @returns {{ step, result, rounds, accepted }}
 */
async function runStep(step, baseContext, emit) {
  // Each step gets its own mutable context copy so parallel steps don't
  // overwrite each other's criticFeedback.  The scratchpad value is a plain
  // object snapshot (Object.fromEntries) created in run(); steps only read
  // it, never mutate it, so a shallow spread is sufficient here.
  const stepContext = { ...baseContext };

  let solverResult = null;
  let verdict = { pass: false, feedback: '' };
  let round = 0;

  while (!verdict.pass && round < MAX_ROUNDS) {
    round++;
    emit('solving', { step, round });
    solverResult = await solver.solve(step, stepContext, llmCall);

    emit('critiquing', { step, solverResult });
    verdict = await critic.critique(step, solverResult, llmCall);
    emit('verdict', { step, verdict });

    if (!verdict.pass) {
      stepContext.criticFeedback = verdict.feedback;
    }
  }

  return { step, result: solverResult, rounds: round, accepted: verdict.pass };
}

/**
 * Run the full Planner → Solver → Critic loop for a task.
 *
 * Steps are executed in dependency order; steps within the same dependency
 * wave run in parallel via Promise.all.
 *
 * @param {string}   task     – natural-language task description
 * @param {object}   context  – optional context/facts
 * @param {Function} onChunk  – optional streaming callback (chunk)
 * @returns {{ steps, results, summary }}
 */
async function run(task, context = {}, onChunk = null) {
  // Enrich context with recent memory
  const recentEps = memory.recentEpisodes(5);
  const enriched = { ...context, recentEpisodes: recentEps };

  // Run-scoped scratchpad: stepNumber → solverResult
  const scratchpad = new Map();

  const emit = (type, payload) => {
    if (onChunk) onChunk({ type, ...payload });
  };

  emit('planning', { task });
  const steps = await planner.plan(task, enriched, llmCall);
  emit('steps', { steps });

  const results = [];
  const completed = new Set();
  const remaining = [...steps];

  // Wave-based parallel execution
  while (remaining.length > 0) {
    // Collect steps whose declared dependencies are all satisfied
    const ready = remaining.filter((s) => {
      const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
      return deps.every((d) => completed.has(d));
    });

    if (ready.length === 0) {
      // Guard against dependency cycles or malformed plans
      console.warn('[kernel] No ready steps found; remaining steps may have unresolvable dependencies. Forcing sequential execution.');
      ready.push(remaining[0]);
    }

    // Remove ready steps from the queue before awaiting (avoids double-scheduling)
    for (const s of ready) {
      const idx = remaining.indexOf(s);
      if (idx !== -1) remaining.splice(idx, 1);
    }

    // Build context snapshot that includes all scratchpad results so far
    const waveContext = { ...enriched, scratchpad: Object.fromEntries(scratchpad) };

    // Execute ready steps in parallel
    const waveResults = await Promise.all(
      ready.map((step) => runStep(step, waveContext, emit))
    );

    // Register completed steps and accumulate scratchpad
    for (const r of waveResults) {
      const stepNum = r.step.step;
      completed.add(stepNum);
      scratchpad.set(stepNum, r.result);
      results.push(r);
    }
  }

  // Return results in step-number order regardless of execution order
  results.sort((a, b) => (a.step?.step ?? 0) - (b.step?.step ?? 0));

  const summary = results.map((r) => `Step ${r.step?.step ?? '?'}: ${r.result?.result ?? ''}`).join('\n');
  return { steps, results, summary };
}

module.exports = { run };
