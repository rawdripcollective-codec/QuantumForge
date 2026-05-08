# Memory System

QuantumForge maintains three separate file-backed JSON stores under the `data/` directory (created automatically on first run, excluded from version control).

| Store | Default path | Purpose |
|---|---|---|
| Key-value memory | `data/memory.json` | Arbitrary persistent facts (e.g. last deployment target, self-improve insights) |
| Episodes | `data/episodes.json` | History of every completed agent task |
| Mistakes | `data/mistakes.json` | History of every failed agent task |

---

## Key-Value Memory

A simple persistent dictionary. Agents and the self-improvement loop use it to share information across runs.

### Via MCP Tools

```bash
# Store a value
curl -X POST http://127.0.0.1:18789/api/tools/memory.set \
  -H "Content-Type: application/json" \
  -d '{"args": {"key": "project.name", "value": "my-app"}}'

# Retrieve it
curl -X POST http://127.0.0.1:18789/api/tools/memory.get \
  -H "Content-Type: application/json" \
  -d '{"args": {"key": "project.name"}}'
```

### Programmatically

```js
const memory = require('./src/memory');

memory.set('deploy.target', 'production');
const target = memory.get('deploy.target'); // 'production'
```

---

## Episodes

Every successful `POST /api/agent` call (or WebSocket `agent` message) saves an episode:

```json
{
  "task": "Write a hello-world Python script",
  "context": {},
  "result": {
    "steps": [...],
    "results": [...],
    "summary": "Step 1: print('Hello, world!')"
  },
  "ts": "2026-05-08T15:00:00.000Z"
}
```

The store is capped at `config.memory.maxEpisodes` entries (default **1000**); the oldest entries are dropped when the limit is exceeded.

The kernel automatically enriches each new task's context with the **5 most recent episodes** so the agents have short-term memory of what they just did.

---

## Mistakes

Every `POST /api/agent` call that throws an error saves a mistake:

```json
{
  "task": "Read /etc/shadow",
  "context": {},
  "error": "Access denied: path is outside the allowed directory",
  "ts": "2026-05-08T15:01:00.000Z"
}
```

Mistakes are read by the self-improvement loop to identify recurring errors and suggest lessons.

---

## Viewing Memory in the UI

1. Open [http://127.0.0.1:18789](http://127.0.0.1:18789).
2. Click the **Memory** tab.
3. Click **↻ Refresh** to load the latest episodes and mistakes.

The **Recent Episodes** table shows the timestamp, task description, and step summary. The **Mistakes** table shows the timestamp, task, and error message.

---

## Viewing Memory via REST

```bash
curl http://127.0.0.1:18789/api/memory | jq .
```

Returns all three stores in one response:
```json
{
  "memory": { "selfImprove.lastInsights": [...], "selfImprove.lastRunTs": "..." },
  "episodes": [...],
  "mistakes": [...]
}
```

---

## Programmatic API

```js
const memory = require('./src/memory');

// Key-value
memory.set(key, value)
memory.get(key)

// Episodes
memory.saveEpisode({ task, context, result })
memory.recentEpisodes(n)   // returns the last n episodes (default 10)

// Mistakes
memory.saveMistake({ task, context, error })
memory.recentMistakes(n)   // returns the last n mistakes (default 10)

// Full dump
memory.getAll()            // returns { memory, episodes, mistakes }
```

---

## Data Directory

All runtime data lives in `data/` which is listed in `.gitignore` and is never committed. You can safely delete its contents to reset all memory, episodes, and mistakes to an empty state.

```bash
rm -rf data/
# QuantumForge will recreate the directory and empty JSON files on next start.
```
