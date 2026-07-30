/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 * Runs up to maxRounds retry loops per step before moving on.
 *
 * The llmCall function is injected at construction (see createKernel).
 * This keeps the kernel decoupled from provider choice — switching from
 * OpenAI to Anthropic or Ollama requires no kernel change.
 *
 * Feedback loops:
 *   - Recent episodes are injected into the planner's context (soft memory).
 *   - Recent mistakes are injected so the planner can avoid repeated errors.
 *   - Last self-improve insights are injected so the planner benefits from
 *     hourly analysis without needing an LLM call.
 *   - Critic feedback is fed back into the solver on retry rounds.
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
const selfImprove = require('../self-improve');
const { createLlmCall, createLlmStream } = require('./llm');

const MAX_ROUNDS = config.agents.maxRounds;
const MAX_TOTAL_STEPS = config.agents?.maxTotalSteps || 20;  // hard wall to prevent cost explosion

/**
 * Create a kernel bound to a specific LLM provider/model.
 * @param {object} [providerOpts] - forwarded to createLlmCall
 * @returns kernel with a `run(task, context, onChunk)` method
 */
function createKernel(providerOpts = {}) {
  const { call: llmCall, provider: resolvedProvider } = createLlmCall(providerOpts);

  // Streaming LLM — created lazily so we only initialise the stream if needed.
  // The stream is a function that returns an async generator each time you call it.
  let _streamingLlm = null;
  function getStreamingLlm() {
    if (!_streamingLlm) {
      try {
        const { stream } = createLlmStream(providerOpts);
        _streamingLlm = stream;
      } catch {
        _streamingLlm = null;
      }
    }
    return _streamingLlm;
  }

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

      // ── Feedback loop 1: recent episodes ──────────────────────────────────
      const recentEps = memory.recentEpisodes(5);

      // ── Feedback loop 2: recent mistakes ──────────────────────────────────
      const recentMistakes = memory.recentMistakes(5);

      // ── Feedback loop 3: last self-improve insights ───────────────────────
      const lastInsights = selfImprove.getLastInsights();

      const enriched = {
        ...context,
        recentEpisodes: recentEps,
        recentMistakes,
        lastInsights,
      };

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
          solverResult = await solver.solve(step, enriched, llmCall, getStreamingLlm(), emit);

          emit('critiquing', { step, solverResult });
          try {
            verdict = await critic.critique(step, solverResult, llmCall);
          } catch (err) {
            // If the critic errors, treat the result as passed (don't loop forever
            // on a broken critic). Record the mistake so self-improve can analyse it.
            log.warn('kernel: critic error, accepting result', { err: err.message });
            selfImprove.recordMistake({
              type: 'error',
              action: 'critic.critique',
              detail: err.message,
            });
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

        // Record accepted/failed result for self-improvement
        if (!verdict.pass) {
          selfImprove.recordMistake({
            type: 'step_rejected',
            action: typeof step === 'object' ? step.action : String(step),
            detail: verdict.feedback,
          });
        }

        results.push({ step, result: solverResult, rounds: round, accepted: verdict.pass });
      }

      // Record the completed episode
      memory.saveEpisode({ task, context, results });

      const summary = results.map((r) =>
        `Step ${r.step?.step ?? '?'}: ${r.result?.result ?? ''}`
      ).join('\n');

      const costUsd = cost.total() - startUsd;

      return { steps, results, summary, costUsd };
    },
  };
}

module.exports = { createKernel, MAX_ROUNDS, MAX_TOTAL_STEPS };
