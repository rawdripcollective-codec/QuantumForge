/**
 * Solver agent – executes a single step using a ReAct (Reason + Act) loop.
 * The solver may call multiple tools in sequence before returning a final result.
 */

'use strict';

const config = require('../../config/default.json');
const mcpFabric = require('../mcp/fabric');

const MAX_TOOL_ROUNDS = config.agents.maxToolRounds || 10;

const SYSTEM = `You are the Solver agent in the QuantumForge multi-agent system.
Execute the given step, using tools as needed, and return the result.

To call a tool respond with ONLY valid JSON:
  {"toolCall": {"name": "tool-name", "args": {...}}}

When you have your final answer respond with ONLY valid JSON:
  {"result": "...", "toolsUsed": [...]}

Available tools:
{{TOOLS}}

Think step-by-step. You may call multiple tools before providing your final answer.
Never mix prose with JSON – output only one JSON object per response.`;

/**
 * Solve a single step, optionally calling MCP tools in a ReAct loop.
 * @param {object}   step      – step object from the planner
 * @param {object}   context   – enriched execution context
 * @param {Function} llmCall   – LLM shim provided by the kernel
 * @param {Function} onEvent   – optional callback for streaming tool_call/tool_result events
 * @returns {{ result: string, toolsUsed: string[], scratchpadUpdate?: object }}
 */
async function solve(step, context = {}, llmCall, onEvent = null) {
  const tools = mcpFabric.listTools();
  const toolsDesc = tools.map((t) => `${t.name}: ${t.description}`).join('\n');
  const system = SYSTEM.replace('{{TOOLS}}', toolsDesc || 'none');

  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Step: ${JSON.stringify(step)}\nContext: ${JSON.stringify(context)}`
    }
  ];

  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const raw = await llmCall(messages, { model: config.openai.model });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Non-JSON response treated as a final answer
      return { result: raw, toolsUsed };
    }

    // Final answer – no tool call requested
    if (!parsed.toolCall) {
      parsed.toolsUsed = parsed.toolsUsed || toolsUsed;
      return parsed;
    }

    // Tool call requested
    const { name: toolName, args: toolArgs = {} } = parsed.toolCall;
    onEvent?.({ type: 'tool_call', tool: toolName, args: toolArgs });

    let toolResult;
    try {
      toolResult = await mcpFabric.invoke(toolName, toolArgs);
    } catch (err) {
      toolResult = { error: err.message };
    }
    toolsUsed.push(toolName);
    onEvent?.({ type: 'tool_result', tool: toolName, result: toolResult });

    // Feed the tool result back into message history for the next iteration
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Tool "${toolName}" returned: ${JSON.stringify(toolResult).slice(0, 4096)}`
    });
  }

  // Exceeded max tool rounds – request a final answer explicitly
  messages.push({
    role: 'user',
    content: 'Provide your final answer now as: {"result": "...", "toolsUsed": [...]}'
  });
  const finalRaw = await llmCall(messages, { model: config.openai.model });
  let finalParsed;
  try {
    finalParsed = JSON.parse(finalRaw);
  } catch {
    finalParsed = { result: finalRaw, toolsUsed };
  }
  finalParsed.toolsUsed = finalParsed.toolsUsed || toolsUsed;
  return finalParsed;
}

module.exports = { solve };
