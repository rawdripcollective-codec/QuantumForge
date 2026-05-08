/**
 * Solver agent – executes a single step, optionally invoking MCP tools.
 */

'use strict';

const config = require('../../config/default.json');
const mcpFabric = require('../mcp/fabric');

const SYSTEM = `You are the Solver agent in the QuantumForge multi-agent system.
Execute the given step and return the result as a JSON object: {"result": "...", "toolsUsed": [...]}.
If you need to call a tool, emit: {"toolCall": {"name": "...", "args": {...}}}.
Available tools: {{TOOLS}}`;

async function solve(step, context = {}, llmCall) {
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

  let raw = await llmCall(messages, { model: config.openai.model });
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { result: raw, toolsUsed: [] };
  }

  // If the LLM requested a tool call, execute it and feed result back
  if (parsed.toolCall) {
    const toolName = parsed.toolCall.name;
    let toolResult;
    try {
      toolResult = await mcpFabric.invoke(toolName, parsed.toolCall.args || {});
    } catch (err) {
      toolResult = { error: err.message };
    }

    // Use role:'user' to return the tool result.  The custom JSON tool-call
    // protocol used here is not the native OpenAI function-calling format, so
    // role:'tool' (which requires a tool_call_id tied to a prior tool_calls
    // entry) would be rejected by the API.
    const followUp = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: `Tool "${toolName}" returned: ${JSON.stringify(toolResult).slice(0, 4096)}` }
    ];

    raw = await llmCall(followUp, { model: config.openai.model });
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { result: raw, toolsUsed: [toolName] };
    }
    const existingToolsUsed = Array.isArray(parsed.toolsUsed) ? parsed.toolsUsed : [];
    parsed.toolsUsed = [...new Set([...existingToolsUsed, toolName].filter(Boolean))];
  }

  return parsed;
}

module.exports = { solve };
