/**
 * Solver agent – executes a single step using a ReAct loop.
 * Repeatedly calls the LLM; if it requests a tool the result is fed back
 * until either a final result is produced or maxToolRounds is exhausted.
 */

'use strict';

const config = require('../../config/default.json');
const mcpFabric = require('../mcp/fabric');

const SYSTEM = `You are the Solver agent in the QuantumForge multi-agent system.
Execute the given step and return the result as a JSON object: {"result": "...", "toolsUsed": [...]}.
If you need to call a tool first, emit: {"toolCall": {"name": "...", "args": {...}}}.
You may call multiple tools in sequence – keep emitting toolCall objects until you have enough information, then emit the final result object.
Available tools: {{TOOLS}}`;

async function solve(step, context = {}, llmCall) {
  const maxToolRounds = config.agents.maxToolRounds || 10;
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

  const toolsUsedAcc = [];
  let parsed = { result: '', toolsUsed: [] };
  let toolRound = 0;

  // ReAct loop: reason → act (tool call) → observe → repeat until done or limit hit
  while (toolRound < maxToolRounds) {
    const raw = await llmCall(messages, { model: config.openai.model });

    try {
      parsed = JSON.parse(raw);
    } catch {
      // Non-JSON response is treated as plain-text final result
      parsed = { result: raw, toolsUsed: toolsUsedAcc };
      break;
    }

    // No tool call means we have a final result
    if (!parsed.toolCall) {
      parsed.toolsUsed = [...new Set([...(parsed.toolsUsed || []), ...toolsUsedAcc])];
      break;
    }

    // Execute the requested tool
    const toolName = parsed.toolCall.name;
    toolsUsedAcc.push(toolName);
    toolRound++;

    let toolResult;
    try {
      toolResult = await mcpFabric.invoke(toolName, parsed.toolCall.args || {});
    } catch (err) {
      toolResult = { error: err.message };
    }

    // Append the tool exchange to the conversation for the next LLM call.
    // Use role:'user' to return the tool result – the custom JSON tool-call
    // protocol used here is not the native OpenAI function-calling format, so
    // role:'tool' (which requires a tool_call_id tied to a prior tool_calls
    // entry) would be rejected by the API.
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Tool "${toolName}" returned: ${JSON.stringify(toolResult).slice(0, 4096)}`
    });
  }

  return parsed;
}

module.exports = { solve };
