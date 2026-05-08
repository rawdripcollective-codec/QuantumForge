'use strict';

/**
 * Tests for src/mcp/fabric.js
 *
 * Uses Node's built-in test runner. Tests run offline (no OPENAI_API_KEY).
 * File-system tool tests use a temporary directory isolated from the live
 * project directory.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-fabric-test-'));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Load a fresh fabric instance whose FS_SAFE_ROOT and registry path are
 * redirected to a temporary directory.
 */
function loadFabric(tmpDir) {
  // Point config cache at tmpDir for the registry path
  const cfgKey = require.resolve('../config/default.json');
  const origCfg = require.cache[cfgKey]?.exports;

  if (require.cache[cfgKey]) {
    require.cache[cfgKey].exports = {
      ...require.cache[cfgKey].exports,
      mcp: { registryPath: path.join(tmpDir, 'mcp-registry.json') },
      memory: {
        path: path.join(tmpDir, 'memory.json'),
        episodesPath: path.join(tmpDir, 'episodes.json'),
        mistakesPath: path.join(tmpDir, 'mistakes.json'),
        maxEpisodes: 100
      },
      tools: {
        http: { enabled: false },
        shell: { enabled: false, allowedCommands: [] }
      }
    };
  }

  // Evict memory and fabric from require cache
  delete require.cache[require.resolve('../src/memory/index.js')];
  delete require.cache[require.resolve('../src/mcp/fabric.js')];

  // Change CWD so FS_SAFE_ROOT resolves to tmpDir
  const origCwd = process.cwd();
  process.chdir(tmpDir);

  let fabric;
  try {
    fabric = require('../src/mcp/fabric.js');
  } finally {
    process.chdir(origCwd);
  }

  // Restore config
  if (require.cache[cfgKey] && origCfg !== undefined) {
    require.cache[cfgKey].exports = origCfg;
  }

  return fabric;
}

// ── Tool registry ─────────────────────────────────────────────────────────────

describe('fabric – tool registry', () => {
  it('listTools returns built-in tools', () => {
    const fabric = require('../src/mcp/fabric.js');
    const tools = fabric.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('fs.read'));
    assert.ok(names.includes('fs.write'));
    assert.ok(names.includes('fs.list'));
    assert.ok(names.includes('fs.append'));
    assert.ok(names.includes('memory.set'));
    assert.ok(names.includes('memory.get'));
    assert.ok(names.includes('memory.search'));
    assert.ok(names.includes('http.fetch'));
    assert.ok(names.includes('shell.exec'));
  });

  it('register adds a custom tool and invoke calls its handler', async () => {
    const fabric = require('../src/mcp/fabric.js');
    fabric.register('test.echo', {
      description: 'Echo args',
      handler: (args) => args
    });
    const result = await fabric.invoke('test.echo', { hello: 'world' });
    assert.deepEqual(result, { hello: 'world' });
  });

  it('invoke throws for unknown tool', async () => {
    const fabric = require('../src/mcp/fabric.js');
    await assert.rejects(
      () => fabric.invoke('no.such.tool', {}),
      /Unknown tool/
    );
  });

  it('register throws when handler is not a function', () => {
    const fabric = require('../src/mcp/fabric.js');
    assert.throws(
      () => fabric.register('bad.tool', { description: '', handler: 'not-a-function' }),
      /handler.*must be a function/
    );
  });
});

// ── fs tools ──────────────────────────────────────────────────────────────────

describe('fabric – fs tools', () => {
  let tmpDir;
  let fabric;

  before(() => {
    tmpDir = makeTmpDir();
    fabric = loadFabric(tmpDir);
  });

  after(() => rmTmpDir(tmpDir));

  it('fs.write writes a file', async () => {
    await fabric.invoke('fs.write', { path: path.join(tmpDir, 'hello.txt'), content: 'hello world' });
    const content = fs.readFileSync(path.join(tmpDir, 'hello.txt'), 'utf8');
    assert.equal(content, 'hello world');
  });

  it('fs.read reads a file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'read-me.txt'), 'read content');
    const result = await fabric.invoke('fs.read', { path: path.join(tmpDir, 'read-me.txt') });
    assert.equal(result, 'read content');
  });

  it('fs.list lists files in a directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'list-a.txt'), '');
    fs.writeFileSync(path.join(tmpDir, 'list-b.txt'), '');
    const result = await fabric.invoke('fs.list', { path: tmpDir });
    assert.ok(Array.isArray(result));
    assert.ok(result.includes('list-a.txt'));
    assert.ok(result.includes('list-b.txt'));
  });

  it('fs.append appends to a file', async () => {
    await fabric.invoke('fs.write', { path: path.join(tmpDir, 'append-me.txt'), content: 'line1\n' });
    await fabric.invoke('fs.append', { path: path.join(tmpDir, 'append-me.txt'), content: 'line2\n' });
    const content = fs.readFileSync(path.join(tmpDir, 'append-me.txt'), 'utf8');
    assert.equal(content, 'line1\nline2\n');
  });

  it('fs.append creates the file if it does not exist', async () => {
    await fabric.invoke('fs.append', { path: path.join(tmpDir, 'new-append.txt'), content: 'created' });
    const content = fs.readFileSync(path.join(tmpDir, 'new-append.txt'), 'utf8');
    assert.equal(content, 'created');
  });

  it('fs.read rejects a path traversal attempt', async () => {
    await assert.rejects(
      () => fabric.invoke('fs.read', { path: path.join(tmpDir, '../../../etc/passwd') }),
      /Access denied/
    );
  });

  it('fs.write rejects a path traversal attempt', async () => {
    await assert.rejects(
      () => fabric.invoke('fs.write', { path: path.join(tmpDir, '../../evil.txt'), content: 'x' }),
      /Access denied/
    );
  });
});

// ── memory tools ──────────────────────────────────────────────────────────────

describe('fabric – memory tools', () => {
  let tmpDir;
  let fabric;

  before(() => {
    tmpDir = makeTmpDir();
    fabric = loadFabric(tmpDir);
  });

  after(() => rmTmpDir(tmpDir));

  it('memory.set stores a value', async () => {
    const result = await fabric.invoke('memory.set', { key: 'foo', value: 'bar' });
    assert.deepEqual(result, { stored: true });
  });

  it('memory.get retrieves a stored value', async () => {
    await fabric.invoke('memory.set', { key: 'answer', value: 42 });
    const result = await fabric.invoke('memory.get', { key: 'answer' });
    assert.equal(result, 42);
  });

  it('memory.search finds matching entries', async () => {
    await fabric.invoke('memory.set', { key: 'project.name', value: 'QuantumForge' });
    await fabric.invoke('memory.set', { key: 'project.lang', value: 'JavaScript' });
    await fabric.invoke('memory.set', { key: 'unrelated', value: 'nothing' });

    const results = await fabric.invoke('memory.search', { query: 'project' });
    assert.ok('project.name' in results);
    assert.ok('project.lang' in results);
    assert.ok(!('unrelated' in results));
  });

  it('memory.search finds entries by value substring', async () => {
    await fabric.invoke('memory.set', { key: 'greeting', value: 'hello world' });
    const results = await fabric.invoke('memory.search', { query: 'world' });
    assert.ok('greeting' in results);
  });

  it('memory.search returns empty object when nothing matches', async () => {
    const results = await fabric.invoke('memory.search', { query: '__no_match_xyz__' });
    assert.deepEqual(results, {});
  });
});

// ── http.fetch (disabled) ─────────────────────────────────────────────────────

describe('fabric – http.fetch (disabled by default)', () => {
  it('throws when http.fetch is disabled', async () => {
    const fabric = require('../src/mcp/fabric.js');
    await assert.rejects(
      () => fabric.invoke('http.fetch', { url: 'http://example.com' }),
      /http\.fetch is disabled/
    );
  });
});

// ── shell.exec (disabled) ─────────────────────────────────────────────────────

describe('fabric – shell.exec (disabled by default)', () => {
  it('throws when shell.exec is disabled', async () => {
    const fabric = require('../src/mcp/fabric.js');
    await assert.rejects(
      () => fabric.invoke('shell.exec', { command: 'ls' }),
      /shell\.exec is disabled/
    );
  });
});
