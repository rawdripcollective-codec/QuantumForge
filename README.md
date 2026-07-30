# QuantumForge

**QuantumForge** is a locally-hosted super-agent combining full-stack dev, AI orchestration, and self-improving workflows into a Termux/Android powerhouse. Pluggable LLM backends (OpenAI · Anthropic · OpenRouter · Ollama), file-backed memory, MCP tool fabric, and a PWA playground — all running on `127.0.0.1:18789`.

---

## Architecture

```
            Interface (PWA/Web)  ──  app.js + WebSocket streaming
                    ↓
              Agent Kernel  ──────  Planner → Solver → Critic pipeline
                    ↓                              │
                                              retry × 5 / step
                    ↓
              MCP Fabric   ──────  tool registry, built-ins, auto-gen servers
                    ↓
          LLM Abstraction ──────  openai · anthropic · openrouter · ollama
                    ↓
         Exec / Safety   ──────  file R/W (sandboxed), memory, error capture
                    ↓
       Self-Improvement  ──────  cron-based mistake analysis + usage loops
```

**Three-agent loop:**
1. **Planner** decomposes a task into 1–7 atomic steps.
2. **Solver** executes each step, optionally invoking MCP tools (bounded to 5 tool calls per step).
3. **Critic** evaluates the result; if it fails, the solver retries (up to 5 rounds).

**Memory:** file-backed `data/{memory,episodes,mistakes}.json` with FIFO caps (1000 entries each).

**Self-improve:** hourly cron, rule-based (recurring errors + frequent task patterns). No LLM in the loop by default — see [Self-Improvement](#self-improvement) for how to opt in.

---

## Features

- **Multi-agent kernel** – Planner, Solver, Critic agents with retry loops
- **4 LLM providers** – OpenAI, Anthropic, OpenRouter, Ollama (any combination)
- **MCP Fabric** – built-in `fs.read`, `fs.write`, `fs.list`, `memory.set/get`; custom server auto-generation via `/api/mcp/gen`
- **Persistent memory** – file-backed episode + mistake + key-value store
- **Self-improvement** – hourly cron analyses errors and usage patterns; stores insights in memory
- **PWA UI** – agent playground, integrations panel, memory viewer, self-improve dashboard
- **WebSocket streaming** – real-time step-by-step agent progress
- **Offline-capable** – runs without API keys; falls back to a deterministic stub
- **Cost controls** – per-process token cost tracking with optional budget cap
- **Node.js gateway on `127.0.0.1:18789`** – low-latency local endpoint
- **Graceful shutdown** – SIGTERM stops the cron and drains WebSocket connections

---

## Quick Start (Termux / proot Ubuntu)

```bash
# 1. Install Node.js (if not already present)
pkg install nodejs   # Termux
# or: apt install nodejs npm   # proot Ubuntu

# 2. Clone and install
git clone https://github.com/rawdripcollective-codec/QuantumForge
cd QuantumForge
npm install

# 3. Choose an LLM provider

# Option A: OpenAI
export OPENAI_API_KEY=sk-...
export QFORGE_PROVIDER=openai

# Option B: Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export QFORGE_PROVIDER=anthropic

# Option C: OpenRouter
export OPENROUTER_API_KEY=sk-or-...
export QFORGE_PROVIDER=openrouter

# Option D: Ollama (local, free, no key needed)
#   1. Install Ollama: https://ollama.com/download
#   2. Pull a model:  ollama pull llama3.2
#   3. Make sure the Ollama server is running on http://localhost:11434
export QFORGE_PROVIDER=ollama

# Optional: cap the per-process LLM cost (in USD)
export COST_BUDGET_USD=5.00

# 4. Start the gateway
npm start
# → QuantumForge gateway listening on http://127.0.0.1:18789 (provider=openai)
```

Open **http://127.0.0.1:18789** in your browser (or the Termux browser) to access the PWA.

> If no provider is configured, the gateway still starts but uses a deterministic offline stub that echoes your input. Useful for development and demos.

---

## Choosing a Provider

| Provider | Use when | Cost | Privacy | Notes |
|---|---|---|---|---|
| `openai` | Production, want GPT-4o class | $$ | data sent to OpenAI | default; needs `OPENAI_API_KEY` |
| `anthropic` | Long-context tasks, want Claude 3.5 | $$ | data sent to Anthropic | needs `ANTHROPIC_API_KEY` |
| `openrouter` | Want any model, single API key | varies | depends on model | needs `OPENROUTER_API_KEY` |
| `ollama` | Fully local, no network | free | fully local | needs running `ollama serve` |

You can switch providers at runtime by restarting with a different `QFORGE_PROVIDER`. The current provider is reported on `/health` and `/api/providers`.

> ⚠️ **Privacy:** unless you use `ollama`, your task text and any context you provide are sent to the chosen LLM provider. Do not paste secrets, PII, or proprietary code into the playground without reading the provider's data-handling policy.

> 💸 **Cost:** each agent run can make up to `steps × rounds × (1 planner + N solver + 1 critic)` LLM calls. A 5-step task with the default 5 retries can easily produce 25+ LLM calls. Set `COST_BUDGET_USD` to enforce a per-process cap. The kernel returns the estimated USD cost on every response (`result.costUsd`).

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check, includes active provider |
| `GET`  | `/api/providers` | List configured providers |
| `POST` | `/api/agent` | Run multi-agent task `{ task, context? }` |
| `GET`  | `/api/tools` | List registered MCP tools |
| `POST` | `/api/tools/:name` | Invoke a tool `{ args }` |
| `POST` | `/api/mcp/gen` | Auto-generate MCP server `{ name, tools[] }` |
| `GET`  | `/api/memory` | Fetch all episodes + mistakes |
| `GET`  | `/api/self-improve/status` | Self-improve scheduler status |
| `POST` | `/api/self-improve/run` | Trigger an immediate improvement cycle |

WebSocket endpoint: `ws://127.0.0.1:18789` — send `{ type: "agent", task: "..." }`. Streaming chunks arrive as `{ type: "chunk", ... }`.

---

## Self-Improvement

The default self-improvement loop is **rule-based** and runs hourly:
- Counts recurring errors → emits a `recurring_error` insight when the same error appears ≥ 2 times.
- Counts frequent task prefixes → emits a `frequent_task` insight when the same task pattern appears ≥ 3 times.

It does **not** call the LLM by default. The insight is a starting point for you to investigate, not an automatic code change.

To extend the loop with an LLM (e.g., to summarize insights in natural language), see `src/self-improve/index.js`. A v1.1 may add an optional LLM step behind a config flag.

---

## Project Structure

```
.
├── server.js                   # Node.js gateway (port 18789)
├── package.json
├── config/default.json         # Runtime configuration
├── src/
│   ├── agents/
│   │   ├── kernel.js           # Planner→Solver→Critic orchestration
│   │   ├── planner.js          # Step decomposition
│   │   ├── solver.js           # Step execution + tool loop
│   │   ├── critic.js           # Result evaluation
│   │   └── llm.js              # 4-provider LLM abstraction
│   ├── lib/
│   │   ├── logger.js           # Structured JSON logger
│   │   ├── retry.js            # Exponential-backoff retry
│   │   └── cost.js             # Token cost tracking + budget
│   ├── mcp/
│   │   ├── fabric.js           # Tool registry + dispatcher (sandboxed fs)
│   │   └── server-gen.js       # Custom MCP server auto-generation
│   ├── memory/index.js         # File-backed episode/mistake store
│   └── self-improve/index.js   # Cron-based self-improvement loop
├── public/                     # PWA (served statically)
│   ├── index.html
│   ├── app.js
│   ├── manifest.json
│   └── sw.js                   # Service Worker
├── schemas/                    # OpenAPI schemas per agent (docs only)
│   ├── planner.json
│   ├── solver.json
│   └── critic.json
├── tests/                      # 50 node:test cases
│   ├── test_planner.js
│   ├── test_solver.js
│   ├── test_llm.js
│   ├── test_kernel.js
│   ├── test_cost.js
│   ├── test_retry.js
│   ├── helpers.js
│   └── fixtures/
└── data/                       # Runtime data (gitignored)
```

---

## Tests

```bash
npm test
# → 50 tests, 100% pass
```

Tests use Node's built-in `node:test` runner (no extra deps). The LLM is stubbed for planner/solver/kernel tests so the suite runs offline in <1 second.

---

## Security

- **Sandbox:** the built-in `fs.*` tools are restricted to the project directory (`safePath` in `src/mcp/fabric.js`). Symlinks are resolved to defeat link-escape.
- **WebSocket origin allowlist:** only `http://127.0.0.1:18789` and `http://localhost:18789` are allowed; remote pages cannot drive-by access the local agent.
- **Payload cap:** WebSocket frames capped at 64 KB.
- **Input validation:** every REST endpoint validates `task` (non-empty string) and `context` (object).

> The server binds to `127.0.0.1`, so it is **not exposed to the internet**. However, other apps on the same device can reach `127.0.0.1` via ADB or rooted shells. If you need multi-app isolation, add an auth layer (out of scope for v1.0).

---

## License

MIT © 2026 rawdripcollective-codec
