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

// ── http.fetch ─────────────────────────────────────────────────────────────────
register('http.fetch', {
  description: 'Fetch content from a URL via GET. Returns status code and trimmed response body.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' }
    },
    required: ['url']
  },
  handler: async ({ url }) => {
    if (!config.tools?.http?.enabled) {
      throw new Error('http.fetch is disabled (set config.tools.http.enabled = true)');
    }
    const timeoutMs = config.tools.http.timeoutMs || 10000;
    const maxBytes = config.tools.http.maxResponseBytes || 32768;

    // Use global fetch when available (Node 18+), otherwise fall back to built-in modules
    if (typeof globalThis.fetch === 'function') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await globalThis.fetch(url, { signal: controller.signal });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, maxBytes) };
      } finally {
        clearTimeout(timer);
      }
    }

    // Fallback: built-in https / http modules
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? require('https') : require('http');
      const timer = setTimeout(() => reject(new Error('http.fetch timeout')), timeoutMs);
      const req = protocol.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > maxBytes) {
            data = data.slice(0, maxBytes);
            req.destroy();
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
});

// ── memory.search ──────────────────────────────────────────────────────────────
register('memory.search', {
  description: 'Keyword search over recent memory episodes and mistakes.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword or phrase.' }
    },
    required: ['query']
  },
  handler: ({ query }) => {
    const mem = require('../memory');
    const q = String(query).toLowerCase();
    const episodes = mem.recentEpisodes(100)
      .filter((e) =>
        (e.task || '').toLowerCase().includes(q) ||
        (e.result?.summary || '').toLowerCase().includes(q)
      )
      .slice(-10);
    const mistakes = mem.recentMistakes(100)
      .filter((m) =>
        (m.task || '').toLowerCase().includes(q) ||
        (m.error || '').toLowerCase().includes(q)
      )
      .slice(-10);
    return { episodes, mistakes, count: episodes.length + mistakes.length };
  }
});

// ── fs.append ──────────────────────────────────────────────────────────────────
register('fs.append', {
  description: 'Append content to a local file (restricted to project directory).',
  schema: {
    type: 'object',
    properties: {
      path:    { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content']
  },
  handler: ({ path: p, content }) => {
    const resolved = safePath(p);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, content, 'utf8');
    return { appended: true };
  }
});

// ── shell.exec ─────────────────────────────────────────────────────────────────
register('shell.exec', {
  description: 'Execute a shell command. Requires shell.enabled in config and the command must be in allowedCommands.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Executable name (e.g. "node", "ls").' },
      args:    { type: 'array',  items: { type: 'string' }, description: 'Argument list.' }
    },
    required: ['command']
  },
  handler: ({ command, args = [] }) => {
    if (!config.tools?.shell?.enabled) {
      throw new Error('shell.exec is disabled (set config.tools.shell.enabled = true)');
    }
    const allowed = Array.isArray(config.tools.shell.allowedCommands)
      ? config.tools.shell.allowedCommands
      : [];
    if (!allowed.includes(command)) {
      throw new Error(`"${command}" is not in the allowed-commands list: [${allowed.join(', ')}]`);
    }
    const { execFile } = require('child_process');
    const timeoutMs = config.tools.shell.timeoutMs || 10000;
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args.map(String),
        { timeout: timeoutMs, cwd: FS_SAFE_ROOT },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(err.message + (stderr ? '\n' + stderr.slice(0, 512) : '')));
          } else {
            resolve({ stdout: stdout.slice(0, 8192), stderr: stderr.slice(0, 1024) });
          }
        }
      );
    });
  }
});

loadRegistry();

module.exports = { register, listTools, invoke, loadRegistry, saveRegistry };
