/**
 * Critic agent – reviews the solver's output and decides whether to accept or retry.
 */

'use strict';

const config = require('../../config/default.json');

const SYSTEM = `You are the Critic agent in the QuantumForge multi-agent system.
Evaluate whether the solver's result correctly addresses the step.
Return ONLY a JSON object: {"pass": true/false, "feedback": "...brief reason..."}.
Be concise. Accept results that are good-enough.`;

async function critique(step, solverResult, llmCall) {
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Step: ${JSON.stringify(step)}\nSolverResult: ${JSON.stringify(solverResult)}`
    }
  ];

  const raw = await llmCall(messages, { model: config.openai.model, responseFormat: 'json' });

  let verdict;
  try {
    verdict = JSON.parse(raw);
    if (typeof verdict.pass !== 'boolean') {
      throw new Error('Critic response is missing the required boolean field: pass');
    }
  } catch (err) {
    throw new Error(`Critic returned an unparsable response: ${err.message}. Raw: ${String(raw).substring(0, 120)}`);
  }

  return verdict;
}

module.exports = { critique };
