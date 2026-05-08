# Architecture

## High-Level Overview

```
┌────────────────────────────────────────────────────┐
│                  Browser / PWA                     │
│   Playground │ Integrations │ Memory │ Self-Improve│
└────────────────────────┬───────────────────────────┘
                         │  HTTP REST  /  WebSocket
                         ▼
┌────────────────────────────────────────────────────┐
│             server.js  (Node.js Gateway)           │
│             http://127.0.0.1:18789                 │
└──┬─────────────┬──────────────┬────────────────────┘
   │             │              │
   ▼             ▼              ▼
Agent Kernel  MCP Fabric   Self-Improve
(pipeline)   (tool reg.)   (cron loop)
   │             │              │
   ├─ Planner    ├─ fs.read     └─ Memory
   ├─ Solver     ├─ fs.write
   └─ Critic     ├─ fs.list
                 ├─ memory.set
                 ├─ memory.get
                 └─ (custom servers)
```

---

## Components

### Agent Kernel (`src/agents/kernel.js`)

Orchestrates the full **Planner → Solver → Critic** pipeline for each task:

1. Enriches the task context with the last 5 memory episodes.
2. Calls the **Planner** to decompose the task into an ordered list of steps.
3. For each step, runs a **retry loop** (up to `config.agents.maxRounds`, default 5):
   - The **Solver** executes the step (possibly invoking MCP tools).
   - The **Critic** evaluates the result and returns `{ pass, feedback }`.
   - If `pass` is `false`, the critic's feedback is injected into context and the loop retries.
4. Returns `{ steps, results, summary }`.

Streaming callbacks (`onChunk`) are called at each stage, enabling real-time WebSocket delivery.

### Planner (`src/agents/planner.js`)

Receives the raw task string and context, then calls the LLM with a system prompt that instructs it to output a **JSON array of step objects**:

```json
[
  { "step": 1, "action": "Create the directory structure" },
  { "step": 2, "action": "Write the main module" }
]
```

Falls back to a single-step plan if the LLM output cannot be parsed.

### Solver (`src/agents/solver.js`)

Executes one step. Its system prompt lists all registered MCP tools. The LLM can either:

- Return a final result: `{ "result": "...", "toolsUsed": [...] }`
- Request a tool call: `{ "toolCall": { "name": "fs.read", "args": { "path": "..." } } }`

When a tool call is detected the Solver:
1. Invokes the tool via the MCP Fabric.
2. Appends the tool result to the conversation.
3. Calls the LLM again for a final answer.

### Critic (`src/agents/critic.js`)

Reviews the Solver's output for the current step and returns:

```json
{ "pass": true, "feedback": "" }
```

or

```json
{ "pass": false, "feedback": "The file path was not created correctly." }
```

A `pass: false` verdict triggers another Solver round with the feedback in context.

### MCP Fabric (`src/mcp/fabric.js`)

A named tool registry and dispatcher. See [MCP Tools](MCP-Tools) for details.

### Memory (`src/memory/index.js`)

File-backed JSON store for episodes, mistakes, and arbitrary key-value data. See [Memory System](Memory-System).

### Self-Improve (`src/self-improve/index.js`)

Cron-based loop that analyses recent mistakes and usage patterns. See [Self-Improvement](Self-Improvement).

---

## LLM Integration

QuantumForge uses the **OpenAI Chat Completions API** (`gpt-4o` by default).

- If `OPENAI_API_KEY` is set, real LLM calls are made.
- If the key is absent, a built-in **offline stub** returns deterministic JSON shapes so the pipeline still runs end-to-end without network access.

The model and base URL are configurable — see [Configuration](Configuration).

---

## Data Flow (REST request)

```
POST /api/agent { task, context? }
  │
  ├─ kernel.run(task, context)
  │    ├─ planner.plan(task, context)   → steps[]
  │    └─ for each step:
  │         ├─ solver.solve(step)       → solverResult
  │         ├─ critic.critique(result)  → verdict
  │         └─ (retry loop if !pass)
  │
  ├─ memory.saveEpisode(...)
  └─ res.json({ steps, results, summary })
```

---

## Data Flow (WebSocket)

```
ws.send({ type: "agent", task: "..." })
  │
  └─ kernel.run(task, context, onChunk)
       └─ onChunk called with:
            { type: "planning",   task }
            { type: "steps",      steps }
            { type: "solving",    step, round }
            { type: "critiquing", step, solverResult }
            { type: "verdict",    step, verdict }
       └─ ws.send({ type: "done", result })
```
