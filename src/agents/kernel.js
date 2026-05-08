/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 *
 * Enhancements:
 *  - Parallel step execution: steps whose `dependsOn` deps are satisfied run concurrently.
 *  - Run-scoped scratchpad: each completed step's result is written into `context.scratchpad`
 *    so subsequent steps can build on prior work.
 *  - Solver `onEvent` wiring: tool_call / tool_result events stream through onChunk.
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
 * Execute a single step through the Solver → Critic retry loop.
 * Each step gets an independent copy of the shared context so parallel
 * steps do not clobber each other's `criticFeedback`.
 *
 * @param {object}   step      – planner step object
 * @param {object}   enriched  – shared execution context (read; not mutated here)
 * @param {Function} emit      – streaming callback
 * @returns {{ step, result, rounds, accepted }}
 */
async function executeStep(step, enriched, emit) {
  // Shallow-copy so parallel steps have their own criticFeedback slot
  const stepCtx = { ...enriched };

  let solverResult = null;
  let verdict = { pass: false, feedback: '' };
  let round = 0;

  while (!verdict.pass && round < MAX_ROUNDS) {
    round++;
    emit('solving', { step, round });

    solverResult = await solver.solve(
      step,
      stepCtx,
      llmCall,
      (event) => emit(event.type, event)
    );

    emit('critiquing', { step, solverResult });
    verdict = await critic.critique(step, solverResult, llmCall);
    emit('verdict', { step, verdict });

    if (!verdict.pass) {
      // Feed critic feedback back into step context for next retry round
      stepCtx.criticFeedback = verdict.feedback;
    }
  }

  return { step, result: solverResult, rounds: round, accepted: verdict.pass };
}

/**
 * Run the full Planner → Solver → Critic loop for a task.
 *
 * Steps are executed in dependency order; steps whose `dependsOn` list is
 * already satisfied run concurrently via Promise.all.  Results are accumulated
 * in a run-scoped `scratchpad` visible to subsequent steps.
 *
 * @param {string}   task     – natural-language task description
 * @param {object}   context  – optional context/facts
 * @param {Function} onChunk  – optional streaming callback (chunk)
 * @returns {{ steps, results, summary }}
 */
async function run(task, context = {}, onChunk = null) {
  // Enrich context with recent memory and an empty scratchpad
  const recentEps = memory.recentEpisodes(5);
  const enriched = { ...context, recentEpisodes: recentEps, scratchpad: {} };

  const emit = (type, payload) => {
    if (onChunk) onChunk({ type, ...payload });
  };

  emit('planning', { task });
  const steps = await planner.plan(task, enriched, llmCall);
  emit('steps', { steps });

  const results = [];
  const completedSteps = new Map(); // step.step → result object
  const remaining = [...steps];

  while (remaining.length > 0) {
    // Collect all steps whose declared dependencies are already satisfied
    const ready = remaining.filter((s) =>
      (s.dependsOn || []).every((dep) => completedSteps.has(dep))
    );

    if (!ready.length) {
      // Dependency deadlock (e.g. malformed plan) – force the first pending step
      const stuck = remaining[0];
      console.warn(
        `[kernel] Step dependency deadlock: step ${stuck.step} depends on [${(stuck.dependsOn || []).join(', ')}] but not all are satisfied; forcing sequential execution`
      );
      ready.push(stuck);
    }

    // Remove ready steps from the pending list
    for (const s of ready) remaining.splice(remaining.indexOf(s), 1);

    if (ready.length > 1) {
      emit('parallel', { count: ready.length, steps: ready });
    }

    // Execute ready steps concurrently
    const roundResults = await Promise.all(
      ready.map((step) => executeStep(step, enriched, emit))
    );

    // Commit round results to the shared scratchpad for subsequent steps
    for (const r of roundResults) {
      completedSteps.set(r.step.step, r);
      results.push(r);
      enriched.scratchpad[`step_${r.step.step}`] = r.result?.result ?? null;
    }
  }

  const summary = results
    .map((r) => `Step ${r.step?.step ?? '?'}: ${r.result?.result ?? ''}`)
    .join('\n');
  return { steps, results, summary };
}

module.exports = { run };
