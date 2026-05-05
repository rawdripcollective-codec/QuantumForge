# QuantumForge

**QuantumForge** is a locally-hosted super-agent combining full-stack dev, AI orchestration, and self-improving workflows into a Termux/Android powerhouse.

---

## Architecture

```
Interface (PWA/Slack)
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

- **Multi-agent kernel** – Planner, Solver, Critic agents with retry loops
- **MCP Fabric** – built-in `fs.read`, `fs.write`, `fs.list`, `memory.set/get`; custom server auto-generation via `/api/mcp/gen`
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

## Project Structure

```
├── server.js              # Node.js gateway (port 18789)
├── config/default.json    # Runtime configuration
├── src/
│   ├── agents/
│   │   ├── kernel.js      # Planner→Solver→Critic orchestration
│   │   ├── planner.js     # Step decomposition
│   │   ├── solver.js      # Step execution + tool calls
│   │   └── critic.js      # Result evaluation
│   ├── mcp/
│   │   ├── fabric.js      # Tool registry + dispatcher
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
└── data/                  # Runtime data (gitignored)
```

## License

MIT © 2026 rawdripcollective-codec
