/**
 * Planner agent – decomposes a high-level task into an ordered list of steps.
 */

'use strict';

const config = require('../../config/default.json');

const SYSTEM = `You are the Planner agent in the QuantumForge multi-agent system.
Your job is to decompose a user task into a concise, ordered list of atomic steps.
Output ONLY a JSON array of step objects:
[{"step": 1, "action": "...description...", "dependsOn": []}, ...]

Rules:
- "dependsOn" is an optional array of step numbers that MUST complete before this step starts.
- Steps whose "dependsOn" is empty (or absent) can run in parallel with other ready steps.
- Only add a dependency when a step genuinely needs the output of a prior step.
- Keep the plan minimal – prefer fewer, broader steps over many tiny ones.
No prose, no markdown fences – pure JSON array only.`;

async function plan(task, context = {}, llmCall) {
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Task: ${task}\nContext: ${JSON.stringify(context)}`
    }
  ];

  const raw = await llmCall(messages, { model: config.openai.model });

  let steps;
  try {
    steps = JSON.parse(raw);
    if (!Array.isArray(steps)) {
      console.warn('[planner] Response is not a valid array of steps; using single-step fallback');
      steps = [{ step: 1, action: task }];
    }
  } catch {
    steps = [{ step: 1, action: task }];
  }

  return steps;
}

module.exports = { plan };
