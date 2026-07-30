/**
 * Planner agent.
 * Decomposes a high-level task into a JSON array of executable steps.
 *
 * Output contract (matches schemas/planner.json):
 *   [{ "step": <integer>, "action": <string description of what to do> }, ...]
 *
 * The planner is the only LLM call that decides *what to do*.
 * The solver decides *how* (including which tools to use).
 * The critic decides *whether it's good enough*.
 *
 * Hard caps (see config/agents.json):
 *   - 1-7 steps total. Anything more is a sign the planner is over-decomposing.
 *   - Each step is a single, clear, atomic action — verbs, not nouns.
 *
 * Failure modes handled here:
 *   - LLM returns non-JSON → fall back to a single-step plan (echo the task).
 *   - LLM returns more than MAX_STEPS → truncate.
 *   - LLM returns < 1 step → return a single-step plan.
 *   - LLM returns malformed objects → repair common cases.
 */

'use strict';

const path = require('path');
const config = require(path.resolve(__dirname, '../../config/default.json'));
const log = require('../lib/logger');

const MIN_STEPS = 1;
const MAX_STEPS = config.agents?.maxPlanSteps || 7;

const SYSTEM = `You are the Planner agent in a multi-step task-execution system.

Your job: decompose the user's task into a JSON array of executable steps.
Each step is one atomic action a Solver agent will execute.

Output ONLY a JSON array — no prose, no markdown fences, no commentary.

Schema (strict):
[
  { "step": <integer starting at 1>, "action": <clear verb-led instruction> }
]

Rules:
- Between ${MIN_STEPS} and ${MAX_STEPS} steps. More than ${MAX_STEPS} is a sign of over-decomposition.
- Steps must be in execution order.
- Each step is a SINGLE action, not a goal. Bad: "Set up the project". Good: "Create a directory at ./src".
- Use imperative verbs: "Create", "Read", "List", "Write", "Call", "Compute".
- If the task is simple (one action), return exactly one step.
- Do NOT include tool names or implementation details — that's the Solver's job.`;

/** Build the user-side message for the planner. */
function buildUserMessage(task, context) {
  const lines = [`Task: ${task}`];
  if (context && Object.keys(context).length > 0) {
    lines.push('', 'Context:');
    // Trim context to keep prompt small
    for (const [k, v] of Object.entries(context)) {
      if (k === 'recentEpisodes' && Array.isArray(v)) {
        lines.push(`- recentEpisodes: ${v.length} prior runs (most recent first)`);
        for (const ep of v.slice(0, 3)) {
          const t = (ep.task || '').slice(0, 80);
          const r = (ep.result?.summary || '').slice(0, 80);
          if (t) lines.push(`  · ${t}${r ? ' → ' + r : ''}`);
        }
      } else {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(`- ${k}: ${s.slice(0, 200)}`);
      }
    }
  }
  return lines.join('\n');
}

/** Repair common LLM JSON mistakes (markdown fences, trailing commas, etc). */
function repairJson(raw) {
  let s = String(raw || '').trim();
  // Strip ```json ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Strip a leading "Here is the plan:" or similar prefix
  s = s.replace(/^(here\s+(is|are)\s+the\s+\w+\s*[:\-]?\s*)/i, '');
  return s;
}

/** Normalize / validate a parsed plan array. Always returns a valid array. */
function normalize(parsed, fallbackTask) {
  let arr = parsed;
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === 'object' && Array.isArray(arr.steps)) arr = arr.steps;
    else arr = [];
  }
  // Repair each entry
  const repaired = [];
  for (let i = 0; i < arr.length && repaired.length < MAX_STEPS; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') continue;
    const step = Number.isInteger(e.step) ? e.step : repaired.length + 1;
    const action = typeof e.action === 'string' && e.action.trim()
      ? e.action.trim()
      : null;
    if (!action) continue;
    repaired.push({ step: repaired.length + 1, action });
  }
  if (repaired.length === 0) {
    // Fallback: a single step that echoes the task
    repaired.push({ step: 1, action: String(fallbackTask || 'Execute the task') });
  }
  return repaired;
}

/**
 * Run the planner.
 * @param {string} task
 * @param {object} context - optional context/facts (may include recentEpisodes)
 * @param {Function} llmCall - (messages, opts) => Promise<string>
 * @returns {Promise<Array<{step:number, action:string}>>}
 */
async function plan(task, context = {}, llmCall) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: buildUserMessage(task, context) },
  ];

  let raw;
  try {
    raw = await llmCall(messages, { responseFormat: 'json', temperature: 0.3 });
  } catch (err) {
    log.warn('planner: llm call failed, falling back to single-step plan', { err: err.message });
    return [{ step: 1, action: String(task || 'Execute the task') }];
  }

  let parsed;
  try {
    parsed = JSON.parse(repairJson(raw));
  } catch (err) {
    log.warn('planner: returned non-JSON, falling back', { raw: String(raw).slice(0, 120) });
    return [{ step: 1, action: String(task || 'Execute the task') }];
  }

  return normalize(parsed, task);
}

module.exports = { plan, normalize, repairJson, buildUserMessage, SYSTEM, MAX_STEPS, MIN_STEPS };
