# API Reference

Base URL: `http://127.0.0.1:18789`

---

## REST Endpoints

### `GET /health`

Returns server status.

**Response `200`**
```json
{ "status": "ok", "version": "1.0.0", "ts": "2026-05-08T15:00:00.000Z" }
```

---

### `POST /api/agent`

Runs the full Planner → Solver → Critic pipeline for a task.

**Request body**
```json
{
  "task": "Write a shell script to back up the data directory",
  "context": { "optional": "extra facts the agents can use" }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `task` | string | ✅ | Natural-language description of what to do |
| `context` | object | ❌ | Optional key-value facts injected into every agent prompt |

**Response `200`**
```json
{
  "steps": [
    { "step": 1, "action": "Create a backup script" },
    { "step": 2, "action": "Make the script executable" }
  ],
  "results": [
    {
      "step": { "step": 1, "action": "Create a backup script" },
      "result": { "result": "#!/bin/bash\ntar -czf backup.tar.gz data/", "toolsUsed": [] },
      "rounds": 1,
      "accepted": true
    }
  ],
  "summary": "Step 1: #!/bin/bash\ntar …\nStep 2: chmod +x backup.sh"
}
```

**Response `400`** — `task` is missing or not a non-empty string, or `context` is not an object.

**Response `500`** — Pipeline execution error; the mistake is automatically saved to memory.

---

### `GET /api/tools`

Returns metadata for all registered MCP tools.

**Response `200`**
```json
[
  {
    "name": "fs.read",
    "description": "Read a file from the local filesystem (restricted to project directory).",
    "schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
  },
  ...
]
```

---

### `POST /api/tools/:name`

Invokes a registered MCP tool directly.

**URL parameter** — `:name` is the tool name (e.g., `fs.read`).

**Request body**
```json
{ "args": { "path": "package.json" } }
```

**Response `200`**
```json
{ "result": "{\n  \"name\": \"quantumforge\",\n  ..." }
```

**Response `500`** — Tool not found or handler threw an error.

**Example:**
```bash
curl -s -X POST http://127.0.0.1:18789/api/tools/fs.list \
  -H "Content-Type: application/json" \
  -d '{"args": {"path": "."}}'
```

---

### `POST /api/mcp/gen`

Auto-generates a scaffold MCP server module and writes it to `data/mcp-servers/<name>.js`.

**Request body**
```json
{
  "name": "weather",
  "tools": [
    {
      "name": "weather.current",
      "description": "Get current weather for a city",
      "schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ]
}
```

**Response `200`**
```json
{
  "name": "weather",
  "path": "/abs/path/to/data/mcp-servers/weather.js",
  "tools": ["weather.current"],
  "status": "scaffold"
}
```

The generated file contains stub handlers. Open it and replace each handler body with a real implementation, then register the tools with `mcpFabric.register()`.

---

### `GET /api/memory`

Returns the full in-process memory store.

**Response `200`**
```json
{
  "memory": { "selfImprove.lastInsights": [...] },
  "episodes": [ { "task": "...", "result": {...}, "ts": "..." } ],
  "mistakes": [ { "task": "...", "error": "...", "ts": "..." } ]
}
```

---

### `GET /api/self-improve/status`

Returns the current state of the self-improvement scheduler.

**Response `200`**
```json
{
  "enabled": true,
  "schedule": "0 * * * *",
  "lastRun": "2026-05-08T14:00:00.000Z",
  "lastReport": { "insights": [...], "mistakesAnalysed": 5, "episodesAnalysed": 12 },
  "running": true
}
```

---

### `POST /api/self-improve/run`

Triggers an immediate self-improvement cycle (does not wait for the cron schedule).

**Response `200`**
```json
{
  "insights": [
    {
      "type": "recurring_error",
      "error": "Unknown tool: weather.current",
      "count": 3,
      "lesson": "Recurring error \"Unknown tool: weather.current\" – review handler logic"
    }
  ],
  "mistakesAnalysed": 5,
  "episodesAnalysed": 12
}
```

---

## WebSocket Protocol

**Endpoint:** `ws://127.0.0.1:18789`

WebSocket connections are only accepted from `http://127.0.0.1:18789` and `http://localhost:18789` to prevent cross-origin access. CLI tools (e.g. `wscat`) that send no `Origin` header are also accepted.

### Connect

On connection the server immediately sends:
```json
{ "type": "connected", "ts": "2026-05-08T15:00:00.000Z" }
```

### Run an Agent Task

Send:
```json
{ "type": "agent", "task": "Summarise the README", "context": {} }
```

| Field | Type | Required |
|---|---|---|
| `type` | `"agent"` | ✅ |
| `task` | string | ✅ |
| `context` | object | ❌ |

### Streaming Events

The server emits a sequence of chunk messages as the pipeline progresses:

| `type` | Payload fields | Description |
|---|---|---|
| `planning` | `task` | Planner is about to decompose the task |
| `steps` | `steps[]` | Planner returned the step list |
| `solving` | `step`, `round` | Solver is executing this step (round N) |
| `critiquing` | `step`, `solverResult` | Critic is reviewing the solver output |
| `verdict` | `step`, `verdict` | Critic issued a pass/fail verdict |
| `done` | `result` | Pipeline complete; `result` is `{ steps, results, summary }` |
| `error` | `error` | Pipeline threw an error |

### Example (wscat)

```bash
npm install -g wscat
wscat -c ws://127.0.0.1:18789
# After connecting:
> {"type":"agent","task":"Write a hello-world in Python"}
< {"type":"chunk","type":"planning","task":"Write a hello-world in Python"}
< {"type":"chunk","type":"steps","steps":[...]}
...
< {"type":"done","result":{...}}
```
