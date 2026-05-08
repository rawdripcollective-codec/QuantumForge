# MCP Tools

The **MCP Fabric** (`src/mcp/fabric.js`) is QuantumForge's tool registry and dispatcher. It manages a named collection of tools that the Solver agent can call during task execution.

---

## Built-in Tools

These five tools are registered automatically when the server starts.

### `fs.read`

Read a file's text content.

```json
{
  "name": "fs.read",
  "args": { "path": "README.md" }
}
```

- `path` (string, required) — relative or absolute path inside the project directory.
- Returns the raw UTF-8 string content of the file.
- Throws `Access denied` if the path resolves outside the project root.

---

### `fs.write`

Write (or overwrite) a file.

```json
{
  "name": "fs.write",
  "args": { "path": "output/result.txt", "content": "Hello, world!" }
}
```

- `path` (string, required) — file path (parent directories are created automatically).
- `content` (string, required) — text to write.
- Returns `{ "written": true }`.
- Throws `Access denied` if the resolved path is outside the project root.

---

### `fs.list`

List entries in a directory.

```json
{
  "name": "fs.list",
  "args": { "path": "src" }
}
```

- `path` (string, required) — directory path inside the project.
- Returns an array of entry names (not recursive).

---

### `memory.set`

Store a key-value pair in persistent memory.

```json
{
  "name": "memory.set",
  "args": { "key": "lastDeployTarget", "value": "production" }
}
```

- `key` (string, required).
- `value` (any JSON-serialisable value, required).
- Returns `{ "stored": true }`.

---

### `memory.get`

Retrieve a previously stored value.

```json
{
  "name": "memory.get",
  "args": { "key": "lastDeployTarget" }
}
```

- `key` (string, required).
- Returns the stored value, or `undefined` if the key does not exist.

---

## Security: File-System Sandbox

All `fs.*` tools enforce a **path-traversal sandbox**:

- Operations are restricted to the project root directory (`FS_SAFE_ROOT`).
- Both the lexical path and the real path (after symlink resolution) are checked.
- Any path that resolves outside `FS_SAFE_ROOT` throws `Access denied`.

This means `fs.read`, `fs.write`, and `fs.list` cannot access `/etc/passwd`, `~/.ssh`, or any file outside the cloned repository.

---

## Invoking Tools via REST

You can call any registered tool directly without going through the agent pipeline:

```bash
# Read a file
curl -s -X POST http://127.0.0.1:18789/api/tools/fs.read \
  -H "Content-Type: application/json" \
  -d '{"args": {"path": "config/default.json"}}'

# Store a memory key
curl -s -X POST http://127.0.0.1:18789/api/tools/memory.set \
  -H "Content-Type: application/json" \
  -d '{"args": {"key": "greeting", "value": "hello"}}'

# Retrieve it
curl -s -X POST http://127.0.0.1:18789/api/tools/memory.get \
  -H "Content-Type: application/json" \
  -d '{"args": {"key": "greeting"}}'
```

---

## Registering a Custom Tool Programmatically

Call `mcpFabric.register()` before or after the server starts:

```js
const mcpFabric = require('./src/mcp/fabric');

mcpFabric.register('http.fetch', {
  description: 'Fetch a URL and return the response body.',
  schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  },
  handler: async ({ url }) => {
    const res = await fetch(url);
    return res.text();
  }
});
```

Once registered, the tool:
- Appears in `GET /api/tools`.
- Is listed in the Solver's system prompt so the LLM can use it.
- Can be called via `POST /api/tools/http.fetch`.

---

## Auto-Generating a Custom MCP Server

Use `POST /api/mcp/gen` to scaffold a new MCP server module:

```bash
curl -s -X POST http://127.0.0.1:18789/api/mcp/gen \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "tools": [
      {
        "name": "github.search",
        "description": "Search GitHub repositories",
        "schema": {
          "type": "object",
          "properties": { "query": { "type": "string" } },
          "required": ["query"]
        }
      }
    ]
  }'
```

This writes `data/mcp-servers/github.js` with stub handlers. The file looks like:

```js
module.exports = {
  name: 'github',
  tools: [
    {
      name: 'github.search',
      description: 'Search GitHub repositories',
      schema: { ... },
      handler: async (args) => {
        return {
          ok: false,
          tool: 'github.search',
          message: 'github.search has not been customized yet. Replace this generated handler with a real implementation.',
          args: args || {}
        };
      }
    }
  ]
};
```

Replace the stub `handler` body with your real implementation, then load the module and register each tool:

```js
const serverDef = require('./data/mcp-servers/github');
for (const tool of serverDef.tools) {
  mcpFabric.register(tool.name, tool);
}
```

---

## Persisted Registry

Non-handler tool metadata is persisted to `data/mcp-registry.json` via `mcpFabric.saveRegistry()`. On startup, `mcpFabric.loadRegistry()` restores previously defined tools (with `handler: null` for externally-defined ones).
