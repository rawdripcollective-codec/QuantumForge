/**
 * MCP Fabric – tool registry and dispatcher.
 * Provides integration points via a named tool registry.
 * Tools can be registered programmatically or loaded from the registry file.
 *
 * Built-in fs tools are restricted to the project root to prevent path traversal.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config/default.json');

const registryPath = path.resolve(config.mcp.registryPath);

// Safe root for file-system tools: restrict all fs operations to the project dir.
// Use realpathSync so that a symlinked project directory is handled correctly.
const FS_SAFE_ROOT = (() => {
  try { return fs.realpathSync(path.resolve('.')); } catch { return path.resolve('.'); }
  // realpathSync can only fail here if the CWD itself is missing, which is
  // an OS-level anomaly; the lexical fallback is safe for that edge case.
})();

/** Resolve a user-supplied path and assert it stays within FS_SAFE_ROOT.
 *  Symlinks are resolved so a symlink inside the project cannot escape the sandbox. */
function safePath(userPath) {
  const resolved = path.resolve(userPath);
  // Lexical pre-check: catches obvious traversal before hitting the filesystem
  const relLex = path.relative(FS_SAFE_ROOT, resolved);
  if (relLex.startsWith('..') || path.isAbsolute(relLex)) {
    throw new Error(`Access denied: path is outside the allowed directory (${FS_SAFE_ROOT})`);
  }

  // Resolve symlinks so that a symlink inside the project cannot point outside.
  // For paths that don't exist yet (e.g. new file writes) we resolve the nearest
  // existing ancestor and reconstruct the full real path from there.
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    try {
      const parent = fs.realpathSync(path.dirname(resolved));
      real = path.join(parent, path.basename(resolved));
    } catch {
      // Neither the path nor its direct parent exist yet - the lexical check above
      // is sufficient for non-existent paths (no symlink to follow).
    }
  }

  const relReal = path.relative(FS_SAFE_ROOT, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`Access denied: path is outside the allowed directory (${FS_SAFE_ROOT})`);
  }
  return real;
}

const _tools = new Map();

function ensureRegistry() {
  if (!fs.existsSync(registryPath)) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify([], null, 2));
  }
}

/** Register a tool programmatically. */
function register(name, { description, schema, handler }) {
  if (typeof handler !== 'function') throw new Error(`handler for "${name}" must be a function`);
  _tools.set(name, { name, description, schema: schema || {}, handler });
}

/** Load persisted tool definitions from registry file (handler = null for external tools). */
function loadRegistry() {
  ensureRegistry();
  try {
    const defs = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    for (const def of defs) {
      if (!_tools.has(def.name)) {
        _tools.set(def.name, { ...def, handler: null });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[mcp/fabric] Could not load registry (possibly malformed):', err.message);
    }
    // File missing is fine – start with an empty registry
  }
}

/** Persist the current registry (non-handler entries) to disk. */
function saveRegistry() {
  ensureRegistry();
  const defs = [..._tools.values()].map(({ name, description, schema }) => ({ name, description, schema }));
  fs.writeFileSync(registryPath, JSON.stringify(defs, null, 2));
}

/** List all registered tools (metadata only). */
function listTools() {
  return [..._tools.values()].map(({ name, description, schema }) => ({ name, description, schema }));
}

/** Invoke a tool by name with args. */
async function invoke(name, args = {}) {
  const tool = _tools.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!tool.handler) throw new Error(`Tool "${name}" has no local handler (external MCP server)`);
  return tool.handler(args);
}

// ── Built-in tools ─────────────────────────────────────────────────────────────

register('fs.read', {
  description: 'Read a file from the local filesystem (restricted to project directory).',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  handler: ({ path: p }) => fs.readFileSync(safePath(p), 'utf8')
});

register('fs.write', {
  description: 'Write content to a local file (restricted to project directory).',
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  },
  handler: ({ path: p, content }) => {
    const resolved = safePath(p);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    return { written: true };
  }
});

register('fs.list', {
  description: 'List files in a directory (restricted to project directory).',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  handler: ({ path: p }) => fs.readdirSync(safePath(p))
});

register('fs.append', {
  description: 'Append content to a local file (restricted to project directory). Creates the file if it does not exist.',
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  },
  handler: ({ path: p, content }) => {
    const resolved = safePath(p);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, content, 'utf8');
    return { appended: true };
  }
});

register('memory.set', {
  description: 'Store a key-value pair in persistent memory.',
  schema: {
    type: 'object',
    properties: { key: { type: 'string' }, value: {} },
    required: ['key', 'value']
  },
  handler: ({ key, value }) => {
    require('../memory').set(key, value);
    return { stored: true };
  }
});

register('memory.get', {
  description: 'Retrieve a value from persistent memory.',
  schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  handler: ({ key }) => require('../memory').get(key)
});

register('memory.search', {
  description: 'Search persistent memory for entries whose key or value contains the query string.',
  schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  handler: ({ query }) => {
    const mem = require('../memory');
    const all = mem.getAll();
    const q = String(query).toLowerCase();
    const results = {};
    for (const [k, v] of Object.entries(all.memory)) {
      if (k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)) {
        results[k] = v;
      }
    }
    return results;
  }
});

register('http.fetch', {
  description: 'Fetch a URL over HTTP/HTTPS and return status + body (first 8 KB). Must be enabled via config.tools.http.enabled.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', default: 'GET' },
      headers: { type: 'object' },
      body: { type: 'string' }
    },
    required: ['url']
  },
  handler: async ({ url, method = 'GET', headers = {}, body }) => {
    if (!config.tools?.http?.enabled) {
      throw new Error('http.fetch is disabled. Set config.tools.http.enabled = true to enable it.');
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? body : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 8192) };
  }
});

register('shell.exec', {
  description: 'Execute an allowed shell command (execFile, no shell interpolation). Disabled by default; requires config.tools.shell.enabled = true and the command listed in config.tools.shell.allowedCommands.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' }
    },
    required: ['command']
  },
  handler: ({ command, args = [], cwd = '.' }) => {
    if (!config.tools?.shell?.enabled) {
      throw new Error('shell.exec is disabled. Set config.tools.shell.enabled = true to enable it.');
    }
    const allowed = config.tools?.shell?.allowedCommands || [];
    if (!allowed.includes(command)) {
      throw new Error(`Command not allowed: "${command}". Add it to config.tools.shell.allowedCommands to permit it.`);
    }
    const { execFileSync } = require('child_process');
    const safeCwd = safePath(cwd);
    const output = execFileSync(command, args, {
      cwd: safeCwd,
      encoding: 'utf8',
      timeout: 15000
    });
    return { output };
  }
});

loadRegistry();

module.exports = { register, listTools, invoke, loadRegistry, saveRegistry };
