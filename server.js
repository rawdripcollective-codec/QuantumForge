/**
 * QuantumForge – Node.js Gateway
 * Listens on 127.0.0.1:18789
 * Exposes REST + WebSocket interfaces for the multi-agent kernel.
 *
 * Provider selection at startup:
 *   - QFORGE_PROVIDER env var wins (openai | anthropic | openrouter | ollama)
 *   - else falls back to config.llm.provider
 *   - else uses the offline stub
 *
 * The corresponding API key must be set:
 *   - OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY
 *   - Ollama needs no key, just a running server
 */

'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const config = require('./config/default.json');
const { createKernel } = require('./src/agents/kernel');
const { listProviders } = require('./src/agents/llm');
const mcpFabric = require('./src/mcp/fabric');
const selfImprove = require('./src/self-improve');
const memory = require('./src/memory');
const log = require('./src/lib/logger');

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

// Allow the PWA (served statically) to call REST endpoints from the browser.
// Restrict to localhost origins in production (unneeded on 127.0.0.1, but
// harmless — change the origin list if you host the PWA on a different port).
app.use(cors({
  origin: [
    'http://127.0.0.1:18789',
    'http://localhost:18789',
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.json({ limit: '64kb' }));      // matches WS maxPayload below
app.use(express.static(path.join(__dirname, 'public')));

// Build the kernel once at startup with the configured provider
const kernel = createKernel({});
log.info('gateway: kernel ready', { provider: kernel.provider() });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', provider: kernel.provider(), ts: new Date().toISOString() });
});

// ── Provider introspection ────────────────────────────────────────────────────
app.get('/api/providers', (_req, res) => {
  res.json({ active: kernel.provider(), providers: listProviders() });
});

// ── Agent endpoint ────────────────────────────────────────────────────────────
// POST /api/agent  { task: string, context?: object }
app.post('/api/agent', async (req, res) => {
  const { task, context = {} } = req.body || {};
  if (typeof task !== 'string' || task.trim() === '') {
    return res.status(400).json({ error: 'task must be a non-empty string' });
  }
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return res.status(400).json({ error: 'context must be an object' });
  }
  try {
    const result = await kernel.run(task, context);
    await memory.saveEpisode({ task, context, result });
    res.json(result);
  } catch (err) {
    log.error('agent: request failed', { err: err.message, task: task.slice(0, 80) });
    await memory.saveMistake({ task, context, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/stream  { task: string, context?: object }
// Streams agent progress as Server-Sent Events (SSE).
// Clients receive: event: chunk\ndata: {...}\n\n
app.post('/api/agent/stream', async (req, res) => {
  const { task, context = {} } = req.body || {};
  if (typeof task !== 'string' || task.trim() === '') {
    return res.status(400).json({ error: 'task must be a non-empty string' });
  }

  // SSE setup
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering
  });

  function send(eventType, data) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const result = await kernel.run(task, context, (chunk) => {
      // Resolve the SSE event name from the chunk.
      // Kernel may emit raw {type:'token',...} or WS-wrapped {type:'chunk', type:{type:'token',...}}.
      let evType = 'chunk';
      let data = chunk;
      if (chunk && typeof chunk === 'object') {
        if (typeof chunk.type === 'string') {
          evType = chunk.type;
        } else if (chunk.type && typeof chunk.type === 'object' && typeof chunk.type.type === 'string') {
          // WS-envelope: extract inner type and flatten inner into data.
          evType = chunk.type.type;
          data = { ...chunk, ...chunk.type };
          delete data.type;
        }
      }
      send(evType, data);
    });
    await memory.saveEpisode({ task, context, result });
    send('done', { result });
  } catch (err) {
    log.error('agent-stream: request failed', { err: err.message, task: task.slice(0, 80) });
    await memory.saveMistake({ task, context, error: err.message });
    send('error', { error: err.message });
  } finally {
    res.end();
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
  try {
    res.json(await memory.getAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

function verifyWsClient(info) {
  const { origin } = info;
  if (!origin) return true;
  if (ALLOWED_WS_ORIGINS.has(origin)) return true;
  return { result: false, code: 403, message: 'Forbidden' };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: verifyWsClient });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', ts: new Date().toISOString(), provider: kernel.provider() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
      return;
    }

    if (msg.type === 'agent') {
      if (typeof msg.task !== 'string' || msg.task.trim() === '') {
        ws.send(JSON.stringify({ type: 'error', error: 'task is required' }));
        return;
      }

      let context = {};
      if (msg.context !== undefined) {
        if (typeof msg.context !== 'object' || msg.context === null || Array.isArray(msg.context)) {
          ws.send(JSON.stringify({ type: 'error', error: 'context must be an object' }));
          return;
        }
        context = msg.context;
      }

      try {
        const result = await kernel.run(msg.task, context, (chunk) => {
          ws.send(JSON.stringify({ type: 'chunk', ...chunk }));
        });
        await memory.saveEpisode({ task: msg.task, context, result });
        ws.send(JSON.stringify({ type: 'done', result }));
      } catch (err) {
        log.error('ws: agent request failed', { err: err.message, task: msg.task.slice(0, 80) });
        await memory.saveMistake({ task: msg.task, context, error: err.message });
        ws.send(JSON.stringify({ type: 'error', error: err.message }));
      }
    }
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info('gateway: shutdown', { signal });
  try { selfImprove.stop(); } catch { /* ignore */ }
  wss.clients.forEach((ws) => { try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ } });
  server.close(() => process.exit(0));
  // Hard exit after 5s if connections won't drain
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(port, host, () => {
  log.info('gateway: listening', { url: `http://${host}:${port}`, provider: kernel.provider() });
  selfImprove.start();
});

module.exports = { app, server };
