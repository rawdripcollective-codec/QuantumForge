/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 * Runs up to maxRounds retry loops per step before moving on.
 *
 * The llmCall function is injected at construction (see createKernel).
 * This keeps the kernel decoupled from provider choice — switching from
 * OpenAI to Anthropic or Ollama requires no kernel change.
 */

'use strict';

const path = require('path');
const config = require(path.resolve(__dirname, '../../config/default.json'));
const planner = require('./planner');
const solver  = require('./solver');
const critic  = require('./critic');
const memory  = require('../memory');
const log     = require('../lib/logger');
const cost    = require('../lib/cost');
const { createLlmCall } = require('./llm');

const MAX_ROUNDS = config.agents.maxRounds;
const MAX_TOTAL_STEPS = config.agents?.maxTotalSteps || 20;  // hard wall to prevent cost explosion

/**
 * Create a kernel bound to a specific LLM provider/model.
 * @param {object} [providerOpts] - forwarded to createLlmCall
 * @returns kernel with a `run(task, context, onChunk)` method
 */
function createKernel(providerOpts = {}) {
  const { call: llmCall, provider: resolvedProvider } = createLlmCall(providerOpts);

  return {
    provider: () => resolvedProvider,

    /**
     * Run the full Planner → Solver → Critic loop for a task.
     * @param {string}   task
     * @param {object}   context  – optional context/facts
     * @param {Function} onChunk  – optional streaming callback (chunk)
     * @returns {{ steps, results, summary, costUsd }}
     */
    async run(task, context = {}, onChunk = null) {
      const startUsd = cost.total();

      // Enrich context with recent memory (so the planner can use prior runs)
      const recentEps = memory.recentEpisodes(5);
      const enriched = { ...context, recentEpisodes: recentEps };

      const emit = (type, payload) => {
        if (onChunk) onChunk({ type, ...payload });
      };

      emit('planning', { task, provider: resolvedProvider });
      const steps = await planner.plan(task, enriched, llmCall);
      emit('steps', { steps });

      // Hard wall: cap total steps × rounds to prevent runaway cost
      if (steps.length > MAX_TOTAL_STEPS) {
        log.warn('kernel: plan exceeded MAX_TOTAL_STEPS, truncating', {
          requested: steps.length, cap: MAX_TOTAL_STEPS
        });
        steps.length = MAX_TOTAL_STEPS;
      }

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
          try {
            verdict = await critic.critique(step, solverResult, llmCall);
          } catch (err) {
            // If the critic errors, treat the result as passed (don't loop forever
            // on a broken critic). The mistake is recorded in memory by the kernel caller.
            log.warn('kernel: critic error, accepting result', { err: err.message });
            verdict = { pass: true, feedback: `[critic error: ${err.message}]` };
          }
          emit('verdict', { step, verdict });

          if (!verdict.pass) {
            // Feed critic feedback back into context for the next round
            enriched.criticFeedback = verdict.feedback;
          }
        }

        // Clear per-step feedback so it doesn't bleed into subsequent steps
        delete enriched.criticFeedback;

        results.push({ step, result: solverResult, rounds: round, accepted: verdict.pass });
      }

      const summary = results.map((r) =>
        `Step ${r.step?.step ?? '?'}: ${r.result?.result ?? ''}`
      ).join('\n');

      const costUsd = cost.total() - startUsd;

      return { steps, results, summary, costUsd };
    },
  };
}

module.exports = { createKernel, MAX_ROUNDS, MAX_TOTAL_STEPS };
