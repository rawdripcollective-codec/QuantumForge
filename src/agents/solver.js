/**
 * Solver agent.
 * Executes a single step from the planner, optionally invoking MCP tools.
 *
 * Output contract (matches schemas/solver.json):
 *   { "result": <string>, "toolsUsed": [<tool name>, ...] }
 *
 * The solver runs a *bounded* text-based tool loop:
 *   1. Send the step + available tools to the LLM.
 *   2. The LLM responds with one of:
 *        { "type": "final", "result": "...", "toolsUsed": [...] }   — done
 *        { "type": "tool",  "name": "fs.read", "args": {...} }      — please invoke
 *        { "type": "tool",  "name": "...",     "args": {...}, "thought": "..." }  — same
 *   3. If "tool", invoke via MCP fabric, append result to the conversation, repeat.
 *   4. If "final" or loop hits MAX_TOOL_CALLS, return the final result.
 *
 * Streaming: when an `emit` callback is provided, the solver emits incremental
 * chunks so the caller can stream progress to the client in real time.
 *
 * Why text-based tools instead of OpenAI's native function-calling?
 *   - Consistency across all 4 providers (Anthropic, OpenRouter, Ollama
 *     all support the JSON text protocol; native function-calling API
 *     differs per provider).
 *   - Easier to debug (the JSON is right there in the conversation).
 *   - The existing OpenAPI schema for SolverOutput documents this contract.
 *
 * Trade-off: slightly higher token usage vs. native tools. Acceptable.
 *
 * Hard caps:
 *   - MAX_TOOL_CALLS = 5 per step (prevents runaway loops).
 *   - MAX_ARG_SIZE = 50,000 chars (prevents 10MB file reads from blowing context).
 */

'use strict';

const path = require('path');
const config = require(path.resolve(__dirname, '../../config/default.json'));
const mcpFabric = require('../mcp/fabric');
const log = require('../lib/logger');

const MAX_TOOL_CALLS = config.agents?.maxToolCallsPerStep || 5;
const MAX_ARG_SIZE   = 50_000;

const SYSTEM = `You are the Solver agent. You execute exactly one step of a multi-step plan.

You have access to MCP tools. Each tool has a name, a description, and a JSON schema.

Output ONE of these JSON shapes — no prose, no markdown fences:

A) Final answer (no more tool calls needed):
   { "type": "final", "result": "<your result>", "toolsUsed": ["tool_name", ...] }

B) Request a tool call:
   { "type": "tool",  "name": "<tool name>", "args": { ... }, "thought": "<why>" }

Rules:
- Call a tool only if you genuinely need its output to make progress.
- "toolsUsed" must list EVERY tool you have called (including the one that produced the final result, if any).
- For file paths, use project-relative paths like "./README.md".
- If a tool errors, retry at most once with corrected args, or fall back to "final" with an explanation in "result".
- Keep "result" concise but informative (1-3 sentences).`;

/** Get a list of available tools, formatted for the LLM prompt. */
function describeTools() {
  const tools = mcpFabric.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.schema || {},
  }));
}

/** Repair common LLM JSON mistakes. */
function repairJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  s = s.replace(/^(here\s+(is|are)\s+the\s+\w+\s*[:\-]?\s*)/i, '');
  return s;
}

/** Try to parse a tool/final decision. Returns null on failure. */
function parseDecision(raw) {
  try {
    const obj = JSON.parse(repairJson(raw));
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'final') {
      return {
        type: 'final',
        result: typeof obj.result === 'string' ? obj.result : '',
        toolsUsed: Array.isArray(obj.toolsUsed) ? obj.toolsUsed.filter((t) => typeof t === 'string') : [],
      };
    }
    if (obj.type === 'tool' && typeof obj.name === 'string') {
      return {
        type: 'tool',
        name: obj.name,
        args: (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) ? obj.args : {},
        thought: typeof obj.thought === 'string' ? obj.thought : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Truncate a tool result to keep the conversation manageable. */
function truncate(s, max = MAX_ARG_SIZE) {
  const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…[truncated, original ${str.length} chars]`;
}

/**
 * Run the solver for one step.
 * @param {object}   step            - { step: number, action: string }
 * @param {object}   context         - enriched execution context
 * @param {Function} llmCall         - non-streaming LLM call function
 * @param {Function} [streamingLlm]   - optional streaming LLM: (messages, opts) => asyncGenerator
 * @param {Function} [emit]           - optional streaming callback: emit({ type, ... })
 * @returns {Promise<{result: string, toolsUsed: string[]}>}
 */
async function solve(step, context = {}, llmCall, streamingLlm = null, emit = null) {
  const tools = describeTools();
  const toolsBlock = tools.length
    ? 'Available tools:\n' + tools.map((t) =>
        `  - ${t.name}: ${t.description}\n    schema: ${JSON.stringify(t.schema)}`
      ).join('\n')
    : 'No tools are currently registered.';

  const stepText = typeof step === 'object'
    ? `Step ${step.step}: ${step.action}`
    : `Step: ${step}`;

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: `${toolsBlock}\n\n${stepText}\n\nContext: ${JSON.stringify(context).slice(0, 2000)}` },
  ];

  const toolsUsed = [];
  let lastDecision = null;
  let lastToolError = null;

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    if (emit) emit({ type: 'llm_call', step, round: i + 1, toolCallIndex: i });

    let raw;
    try {
      if (streamingLlm) {
        // Stream tokens to the client in real time.
        raw = '';
        const opts = { responseFormat: 'json', temperature: 0.2 };
        try {
          const gen = streamingLlm(messages, opts);
          for await (const token of gen) {
            raw += token;
            if (emit) emit({ type: 'token', step, token, accumulated: raw.slice(0, 500) });
          }
        } catch (streamErr) {
          // Fall back to non-streaming if streaming fails (e.g., provider doesn't support it)
          log.warn('solver: streaming failed, falling back to non-streaming', { err: streamErr.message });
          raw = await llmCall(messages, opts);
        }
      } else {
        raw = await llmCall(messages, { responseFormat: 'json', temperature: 0.2 });
      }
    } catch (err) {
      log.warn('solver: llm call failed', { step: step?.step, err: err.message });
      if (emit) emit({ type: 'solver_error', step, err: err.message });
      return {
        result: `[solver error] ${err.message}`,
        toolsUsed,
      };
    }

    const decision = parseDecision(raw);
    if (!decision) {
      log.warn('solver: non-JSON response, treating as final', { raw: String(raw).slice(0, 120) });
      const result = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
      if (emit) emit({ type: 'solver_final', step, result, toolsUsed });
      return { result, toolsUsed };
    }

    lastDecision = decision;

    if (decision.type === 'final') {
      const merged = Array.from(new Set([...toolsUsed, ...decision.toolsUsed]));
      if (emit) emit({ type: 'solver_final', step, result: decision.result, toolsUsed: merged });
      return { result: decision.result, toolsUsed: merged };
    }

    // decision.type === 'tool'
    if (!mcpFabric.listTools().some((t) => t.name === decision.name)) {
      const errMsg = `Tool "${decision.name}" is not registered. Available: ${mcpFabric.listTools().map((t) => t.name).join(', ') || '(none)'}`;
      log.warn('solver: unknown tool requested', { name: decision.name });
      lastToolError = errMsg;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `Tool error: ${errMsg}. Try a different tool, or return a "final" decision.` });
      if (emit) emit({ type: 'tool_unknown', step, tool: decision.name, err: errMsg });
      continue;
    }

    toolsUsed.push(decision.name);

    if (emit) emit({ type: 'tool_call', step, tool: decision.name, args: decision.args });

    let toolResult;
    try {
      toolResult = await mcpFabric.invoke(decision.name, decision.args || {});
      lastToolError = null;
    } catch (err) {
      lastToolError = err.message;
      toolResult = { error: err.message };
      if (emit) emit({ type: 'tool_error', step, tool: decision.name, err: err.message });
    }

    if (emit) emit({ type: 'tool_result', step, tool: decision.name, truncated: typeof toolResult === 'string' ? toolResult.length : JSON.stringify(toolResult).length });

    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Tool ${decision.name} returned:\n${truncate(toolResult)}\n\nNow either call another tool or return a "final" decision.`
    });
  }

  // Hit the cap.
  if (lastDecision?.type === 'final') {
    if (emit) emit({ type: 'solver_final', step, result: lastDecision.result, toolsUsed });
    return { result: lastDecision.result, toolsUsed };
  }
  const result = lastToolError
    ? `[solver] Reached tool-call limit (${MAX_TOOL_CALLS}). Last error: ${lastToolError}`
    : `[solver] Reached tool-call limit (${MAX_TOOL_CALLS}) without a final answer.`;
  if (emit) emit({ type: 'solver_final', step, result, toolsUsed });
  return { result, toolsUsed };
}

module.exports = { solve, parseDecision, describeTools, MAX_TOOL_CALLS };
