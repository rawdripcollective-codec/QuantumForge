/**
 * QuantumForge – Node.js Gateway
 * Listens on 127.0.0.1:18789
 * Exposes REST + WebSocket interfaces for the multi-agent kernel.
 */

'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const config = require('./config/default.json');
const kernel = require('./src/agents/kernel');
const mcpFabric = require('./src/mcp/fabric');
const selfImprove = require('./src/self-improve');
const memory = require('./src/memory');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
});

// ── Agent endpoint ────────────────────────────────────────────────────────────
// POST /api/agent  { task: string, context?: object }
app.post('/api/agent', async (req, res) => {
  const { task, context = {} } = req.body || {};
  if (!task) {
    return res.status(400).json({ error: 'task is required' });
  }
  try {
    const result = await kernel.run(task, context);
    await memory.saveEpisode({ task, context, result });
    res.json(result);
  } catch (err) {
    await memory.saveMistake({ task, context, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── MCP tool endpoints ────────────────────────────────────────────────────────
// GET  /api/tools          – list registered tools
app.get('/api/tools', (_req, res) => {
  res.json(mcpFabric.listTools());
});

// POST /api/tools/:name    – invoke a tool  { args: object }
app.post('/api/tools/:name', async (req, res) => {
  const { args = {} } = req.body || {};
  try {
    const result = await mcpFabric.invoke(req.params.name, args);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MCP server auto-generation ────────────────────────────────────────────────
// POST /api/mcp/gen  { name: string, tools: ToolSchema[] }
app.post('/api/mcp/gen', async (req, res) => {
  const { name, tools } = req.body || {};
  if (!name || !Array.isArray(tools)) {
    return res.status(400).json({ error: 'name and tools[] are required' });
  }
  try {
    const serverDef = await require('./src/mcp/server-gen').generate(name, tools);
    res.json(serverDef);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Memory / episodes ─────────────────────────────────────────────────────────
app.get('/api/memory', async (_req, res) => {
  res.json(await memory.getAll());
});

// ── Self-improve status ───────────────────────────────────────────────────────
app.get('/api/self-improve/status', (_req, res) => {
  res.json(selfImprove.status());
});

app.post('/api/self-improve/run', async (_req, res) => {
  try {
    const report = await selfImprove.run();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const { host, port } = config.gateway;

// Allowed browser origins for WebSocket upgrades.
// A remote page cannot spoof the Origin header, so this prevents cross-origin
// drive-by access to the local agent/file-system tools.
const ALLOWED_WS_ORIGINS = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);

// verifyClient is called before the WebSocket handshake is completed.
// Requests with no Origin (CLI tools, wscat, etc.) are allowed.
// Requests from any other origin are rejected with 403.
function verifyWsClient(info) {
  const { origin } = info;
  if (!origin) return true;
  if (ALLOWED_WS_ORIGINS.has(origin)) return true;
  return { result: false, code: 403, message: 'Forbidden' };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: verifyWsClient });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', ts: new Date().toISOString() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
      return;
    }

    if (msg.type === 'agent') {
      try {
        const result = await kernel.run(msg.task, msg.context || {}, (chunk) => {
          ws.send(JSON.stringify({ type: 'chunk', ...chunk }));
        });
        await memory.saveEpisode({ task: msg.task, context: msg.context, result });
        ws.send(JSON.stringify({ type: 'done', result }));
      } catch (err) {
        await memory.saveMistake({ task: msg.task, context: msg.context, error: err.message });
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    }
  });
});

server.listen(port, host, () => {
  console.log(`QuantumForge gateway listening on http://${host}:${port}`);
  selfImprove.start();
});

module.exports = { app, server };
