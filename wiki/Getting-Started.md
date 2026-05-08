# Getting Started

## Prerequisites

- **Node.js** 18 or later (20+ recommended for full compatibility)
- **npm** (bundled with Node.js)
- An **OpenAI API key** (optional — works offline without one)

---

## Installation

### Termux (Android)

```bash
pkg install nodejs
git clone https://github.com/rawdripcollective-codec/QuantumForge
cd QuantumForge
npm install
```

### proot Ubuntu / Debian / macOS / Linux

```bash
# Install Node.js if needed
apt install nodejs npm   # Debian/Ubuntu
# or: brew install node  # macOS

git clone https://github.com/rawdripcollective-codec/QuantumForge
cd QuantumForge
npm install
```

---

## Starting the Server

```bash
# Production (standard)
npm start

# Development (watch mode — restarts on file changes)
npm run dev
```

The gateway starts on **http://127.0.0.1:18789**.

Open that URL in any browser to access the PWA.

---

## Setting Your OpenAI API Key

```bash
export OPENAI_API_KEY=sk-...
npm start
```

Without the key the system runs in **offline / stub mode** — the pipeline still completes but the Planner, Solver, and Critic return deterministic placeholder responses instead of real LLM output.

---

## Your First Task (Browser UI)

1. Open [http://127.0.0.1:18789](http://127.0.0.1:18789).
2. Click the **Playground** tab (active by default).
3. Type a task in the text area, e.g.:
   ```
   Write a Python script that reads a CSV file and prints the first 5 rows
   ```
4. Click **Run Agent**.
5. Watch real-time step-by-step progress appear in the log pane.

---

## Your First Task (curl)

```bash
curl -s -X POST http://127.0.0.1:18789/api/agent \
  -H "Content-Type: application/json" \
  -d '{"task": "List all JavaScript files in the project root"}' \
  | jq .
```

Example response:

```json
{
  "steps": [
    { "step": 1, "action": "List all JavaScript files in the project root" }
  ],
  "results": [
    {
      "step": { "step": 1, "action": "..." },
      "result": { "result": "server.js", "toolsUsed": ["fs.list"] },
      "rounds": 1,
      "accepted": true
    }
  ],
  "summary": "Step 1: server.js"
}
```

---

## Health Check

```bash
curl http://127.0.0.1:18789/health
# → {"status":"ok","version":"1.0.0","ts":"..."}
```

---

## Offline / Stub Mode

When `OPENAI_API_KEY` is not set:

- The **Planner** returns a single-step plan containing the raw task text.
- The **Solver** wraps the step in an `[offline] …` marker.
- The **Critic** always returns `{ "pass": true, "feedback": "" }`.

This lets you verify the pipeline, test tool invocations, and develop custom tools without an active API key.

---

## Stopping the Server

Press **Ctrl+C** in the terminal where `npm start` is running.

---

## Next Steps

- [Architecture](Architecture) — understand how the agent pipeline works
- [MCP Tools](MCP-Tools) — explore built-in tools and create custom ones
- [Configuration](Configuration) — tune timeouts, model, cron schedule, and more
- [API Reference](API-Reference) — integrate QuantumForge into your own scripts
