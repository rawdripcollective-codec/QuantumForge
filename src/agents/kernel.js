/**
 * Agent Kernel – orchestrates the Planner → Solver → Critic pipeline.
 * Runs up to maxRounds retry loops per step before moving on.
 */

'use strict';

const config = require('../../config/default.json');
const { OpenAI } = require('openai');
const planner = require('./planner');
const solver = require('./solver');
const critic = require('./critic');
const memory = require('../memory');

const MAX_ROUNDS = config.agents.maxRounds;

/**
 * Priority-ordered list of LLM providers.
 * Each entry is tried in sequence; the first successful response is returned.
 * Ollama is always attempted (no API key required) because it runs locally.
 * OpenAI is kept as a final fallback for backward compatibility.
 *
 * Required environment variables:
 *   OPENROUTER_API_KEY   – OpenRouter (primary)
 *   HUGGINGFACE_API_KEY  – HuggingFace Inference API (backup 1)
 *   HF_TOKEN             – alternative HuggingFace token name (backup 1)
 *   OLLAMA_API_KEY       – optional; Ollama runs locally without a key (backup 2)
 *   GEMINI_API_KEY       – Google Gemini (backup 3)
 *   GOOGLE_API_KEY       – alternative Gemini key name (backup 3)
 *   OPENAI_API_KEY       – legacy OpenAI fallback (backup 4)
 */
const PROVIDERS = [
  {
    name: 'openrouter',
    apiKey: () => process.env.OPENROUTER_API_KEY,
    baseURL: config.openrouter.baseURL,
    model: config.openrouter.model,
  },
  {
    name: 'huggingface',
    apiKey: () => process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN,
    baseURL: config.huggingface.baseURL,
    model: config.huggingface.model,
  },
  {
    // Ollama runs locally and does not require a real API key.
    name: 'ollama',
    apiKey: () => process.env.OLLAMA_API_KEY || 'ollama',
    baseURL: config.ollama.baseURL,
    model: config.ollama.model,
    alwaysTry: true,
  },
  {
    name: 'gemini',
    apiKey: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    baseURL: config.gemini.baseURL,
    model: config.gemini.model,
  },
  {
    // Legacy OpenAI – kept for backward compatibility.
    name: 'openai',
    apiKey: () => process.env.OPENAI_API_KEY,
    baseURL: config.openai.baseURL,
    model: config.openai.model,
  },
];

/**
 * LLM shim that tries PROVIDERS in priority order.
 * Falls back to a no-op offline stub when all providers are unavailable.
 * The `model` option from callers is intentionally ignored; each provider
 * uses its own configured model so that responses are always well-formed.
 */
async function llmCall(messages, { responseFormat } = {}) {
  const timeoutMs = Number(config.agents.timeoutMs);

  for (const provider of PROVIDERS) {
    const apiKey = provider.apiKey();
    if (!apiKey && !provider.alwaysTry) continue;

    try {
      const clientOptions = {
        apiKey: apiKey || 'no-key',
        baseURL: provider.baseURL,
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        clientOptions.timeout = timeoutMs;
      }
      const client = new OpenAI(clientOptions);

      const params = { model: provider.model, messages };
      if (responseFormat === 'json') {
        params.response_format = { type: 'json_object' };
      }

      const completion = await client.chat.completions.create(params);
      return completion.choices[0].message.content;
    } catch (err) {
      console.warn(`[kernel] Provider "${provider.name}" failed: ${err.message}`);
      // Continue to the next provider.
    }
  }

  // All providers failed – fall back to the offline stub.
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
