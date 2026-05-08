# QuantumForge

**QuantumForge** is a locally-hosted super-agent combining full-stack dev, AI orchestration, and self-improving workflows into a Termux/Android powerhouse.

---

## Architecture

```
Interface (PWA/Web)
        ↓
  Agent Kernel  ──── Planner → Solver → Critic pipeline
        ↓
   MCP Fabric   ──── tool registry, built-ins, auto-gen servers
        ↓
 Exec / Safety  ──── file R/W, memory, error capture
        ↓
Self-Improvement ─── cron-based mistake analysis + usage loops
```

## Features

- **Multi-agent kernel** – Planner, Solver, Critic agents with retry loops; independent steps run in **parallel** (dependency-aware wave execution via `dependsOn`)
- **ReAct solver** – Solver iterates through a Reason-Act loop (up to `agents.maxToolRounds` rounds) so complex steps can chain multiple tool calls before returning a final result
- **Run-scoped scratchpad** – results from earlier steps are passed to later steps via `context.scratchpad`
- **MCP Fabric** – built-in `fs.read`, `fs.write`, `fs.list`, `fs.append`, `memory.set/get/search`, `http.fetch` (opt-in), `shell.exec` (opt-in); custom server auto-generation via `/api/mcp/gen`
- **Persistent memory** – file-backed episode + mistake store
- **Self-improvement** – hourly cron analyses errors and usage patterns; stores insights in memory
- **PWA UI** – agent playground, integrations panel, memory viewer, self-improve dashboard
- **WebSocket streaming** – real-time step-by-step agent progress
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

## Testing

```bash
npm test                # run the full test suite (node --test)
npm run test:coverage   # run with experimental coverage report
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check |
| `POST` | `/api/agent` | Run multi-agent task `{ task, context? }` |
| `GET`  | `/api/tools` | List registered MCP tools |
| `POST` | `/api/tools/:name` | Invoke a tool `{ args }` |
| `POST` | `/api/mcp/gen` | Auto-generate MCP server `{ name, tools[] }` |
| `GET`  | `/api/memory` | Fetch all episodes + mistakes |
| `GET`  | `/api/self-improve/status` | Self-improve scheduler status |
| `POST` | `/api/self-improve/run` | Trigger an immediate improvement cycle |

WebSocket endpoint: `ws://127.0.0.1:18789` — send `{ type: "agent", task: "..." }`.

## Built-in MCP Tools

| Tool | Description | Enabled by default |
|------|-------------|-------------------|
| `fs.read` | Read a file (project dir only) | ✔ |
| `fs.write` | Write a file (project dir only) | ✔ |
| `fs.list` | List a directory (project dir only) | ✔ |
| `fs.append` | Append to a file (project dir only) | ✔ |
| `memory.set` | Store a key/value in persistent memory | ✔ |
| `memory.get` | Retrieve a value from persistent memory | ✔ |
| `memory.search` | Search memory by key or value substring | ✔ |
| `http.fetch` | HTTP/HTTPS GET/POST (first 8 KB of body) | ✗ (set `config.tools.http.enabled = true`) |
| `shell.exec` | Run a pre-approved command via `execFile` | ✗ (set `config.tools.shell.enabled = true` and populate `allowedCommands`) |

### Enabling `http.fetch` and `shell.exec`

Edit `config/default.json`:

```json
"tools": {
  "http": { "enabled": true },
  "shell": {
    "enabled": true,
    "allowedCommands": ["git", "npm", "node"]
  }
}
```

## Parallel Steps (`dependsOn`)

The Planner can emit a `dependsOn` array on each step to express dependencies.  
Steps with all dependencies satisfied are executed in parallel via `Promise.all`.

```json
[
  { "step": 1, "action": "Fetch README",       "dependsOn": [] },
  { "step": 2, "action": "Fetch package.json", "dependsOn": [] },
  { "step": 3, "action": "Summarize both",     "dependsOn": [1, 2] }
]
```

Steps 1 and 2 run concurrently; step 3 runs only after both complete.  
Each step receives a `context.scratchpad` map of all prior step results.

## Project Structure

```
├── server.js              # Node.js gateway (port 18789)
├── config/default.json    # Runtime configuration
├── src/
│   ├── agents/
│   │   ├── kernel.js      # Parallel wave execution + Planner→Solver→Critic orchestration
│   │   ├── planner.js     # Step decomposition (emits dependsOn arrays)
│   │   ├── solver.js      # ReAct loop – step execution + multi-round tool calls
│   │   └── critic.js      # Result evaluation
│   ├── mcp/
│   │   ├── fabric.js      # Tool registry + dispatcher + built-in tools
│   │   └── server-gen.js  # Custom MCP server auto-generation
│   ├── memory/index.js    # File-backed episode/mistake store
│   └── self-improve/
│       └── index.js       # Cron-based self-improvement loop
├── public/                # PWA (served statically)
│   ├── index.html
│   ├── app.js
│   ├── manifest.json
│   └── sw.js              # Service Worker
├── schemas/               # OpenAPI schemas per agent
│   ├── planner.json
│   ├── solver.json
│   └── critic.json
├── test/                  # Node built-in test runner suites
│   ├── memory.test.js
│   ├── fabric.test.js
│   └── agents.test.js
└── data/                  # Runtime data (gitignored)
```

## License

MIT © 2026 rawdripcollective-codec
