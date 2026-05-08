# QuantumForge

**QuantumForge** is a locally-hosted super-agent combining full-stack dev, AI orchestration, and self-improving workflows into a Termux/Android powerhouse.

---

## Architecture

```
Interface (PWA/Web)
        ↓
  Agent Kernel  ──── Planner → Solver (ReAct loop) → Critic pipeline
        ↓                 └── parallel step execution via dependency graph
   MCP Fabric   ──── tool registry, built-ins, auto-gen servers
        ↓
 Exec / Safety  ──── file R/W, memory, HTTP fetch, shell exec
        ↓
Self-Improvement ─── cron-based LLM (or rule-based) mistake analysis
```

## Features

- **Multi-agent kernel** – Planner, Solver, Critic agents with retry loops
- **Parallel step execution** – Planner emits `dependsOn` step dependencies; independent steps run concurrently via `Promise.all`
- **ReAct solver loop** – Solver iterates tool-call → observe cycles (up to `maxToolRounds`) before returning a final answer, mirroring the ReAct agent pattern
- **Run-scoped scratchpad** – each step's result is accumulated in `context.scratchpad` so subsequent steps can build on prior work
- **MCP Fabric** – built-in tools: `fs.read`, `fs.write`, `fs.list`, `fs.append`, `memory.set/get`, `memory.search`, `http.fetch`, `shell.exec`; custom server auto-generation via `/api/mcp/gen`
- **Persistent memory** – file-backed episode + mistake store
- **Self-improvement** – hourly cron analyses errors and usage patterns; uses LLM analysis when `OPENAI_API_KEY` is set, falls back to rule-based offline
- **PWA UI** – agent playground with tool-call streaming, integrations panel, memory viewer, self-improve dashboard
- **WebSocket streaming** – real-time step-by-step agent progress including `tool_call` / `tool_result` events
- **SSE streaming** – `POST /api/agent/stream` returns `text/event-stream` for HTTP clients
- **Offline-capable** – runs without `OPENAI_API_KEY`; falls back to stub responses
- **Node.js gateway on `127.0.0.1:18789`** – low-latency local endpoint

## Quick Start (Termux / proot Ubuntu)

```bash
# 1. Install Node.js (if not already present)
pkg install nodejs   # Termux
# or: apt install nodejs npm   # proot Ubuntu

# 2. Clone and install
git clone https://github.com/rawdripcollective-codec/QuantumForge
cd QuantumForge
npm install

# 3. (Optional) Set your OpenAI key for real LLM responses
export OPENAI_API_KEY=sk-...

# 4. Start the gateway
npm start
# → QuantumForge gateway listening on http://127.0.0.1:18789
```

Open **http://127.0.0.1:18789** in your browser (or the Termux browser) to access the PWA.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check |
| `POST` | `/api/agent` | Run multi-agent task `{ task, context? }` |
| `POST` | `/api/agent/stream` | Same as above, but returns `text/event-stream` (SSE) |
| `GET`  | `/api/tools` | List registered MCP tools |
| `POST` | `/api/tools/:name` | Invoke a tool `{ args }` |
| `POST` | `/api/mcp/gen` | Auto-generate MCP server `{ name, tools[] }` |
| `GET`  | `/api/memory` | Fetch all episodes + mistakes |
| `GET`  | `/api/self-improve/status` | Self-improve scheduler status |
| `POST` | `/api/self-improve/run` | Trigger an immediate improvement cycle |

WebSocket endpoint: `ws://127.0.0.1:18789` — send `{ type: "agent", task: "..." }`.

### SSE Streaming Example

```bash
curl -N -X POST http://127.0.0.1:18789/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"task": "List files in the project root"}'
```

Events are `data: <JSON>\n\n` lines. Event types: `planning`, `steps`, `parallel`, `solving`, `tool_call`, `tool_result`, `critiquing`, `verdict`, `done`, `error`.

## Built-in MCP Tools

| Tool | Description |
|------|-------------|
| `fs.read` | Read a file (project directory only) |
| `fs.write` | Write a file (project directory only) |
| `fs.list` | List a directory (project directory only) |
| `fs.append` | Append content to a file (project directory only) |
| `memory.set` | Store a key-value pair in persistent memory |
| `memory.get` | Retrieve a value from persistent memory |
| `memory.search` | Keyword search over recent episodes and mistakes |
| `http.fetch` | GET a URL and return status + body (enable via `config.tools.http.enabled`) |
| `shell.exec` | Run a whitelisted shell command (enable + configure `config.tools.shell`) |

### Enabling `http.fetch`

Already enabled by default in `config/default.json`:
```json
"tools": { "http": { "enabled": true, "timeoutMs": 10000, "maxResponseBytes": 32768 } }
```

### Enabling `shell.exec`

Disabled by default. To opt in:
```json
"tools": {
  "shell": {
    "enabled": true,
    "timeoutMs": 10000,
    "allowedCommands": ["ls", "cat", "node", "python3", "git"]
  }
}
```

## Project Structure

```
├── server.js              # Node.js gateway (port 18789)
├── config/default.json    # Runtime configuration
├── src/
│   ├── agents/
│   │   ├── kernel.js      # Planner→Solver→Critic orchestration + parallel steps
│   │   ├── planner.js     # Step decomposition with dependsOn support
│   │   ├── solver.js      # ReAct tool-call loop
│   │   └── critic.js      # Result evaluation
│   ├── mcp/
│   │   ├── fabric.js      # Tool registry + dispatcher (built-ins + custom)
│   │   └── server-gen.js  # Custom MCP server auto-generation
│   ├── memory/index.js    # File-backed episode/mistake store
│   └── self-improve/
│       └── index.js       # Cron-based self-improvement (LLM + rule-based)
├── public/                # PWA (served statically)
│   ├── index.html
│   ├── app.js
│   ├── manifest.json
│   └── sw.js              # Service Worker
├── schemas/               # OpenAPI schemas per agent
│   ├── planner.json
│   ├── solver.json
│   └── critic.json
└── data/                  # Runtime data (gitignored)
```

## License

MIT © 2026 rawdripcollective-codec
