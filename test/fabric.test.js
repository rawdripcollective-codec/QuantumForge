'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withTempCwd, freshRequire } = require('./helpers');

const fabricModulePath = path.join(__dirname, '..', 'src', 'mcp', 'fabric.js');

test('fabric built-in tools support sandboxed read, write, list, and memory access', async () => {
  await withTempCwd(async (cwd) => {
    const fabric = freshRequire(fabricModulePath);

    await fabric.invoke('fs.write', { path: 'nested/file.txt', content: 'hello world' });

    assert.equal(await fabric.invoke('fs.read', { path: 'nested/file.txt' }), 'hello world');
    assert.deepEqual(await fabric.invoke('fs.list', { path: 'nested' }), ['file.txt']);

    await fabric.invoke('memory.set', { key: 'mode', value: { offline: true } });
    assert.deepEqual(await fabric.invoke('memory.get', { key: 'mode' }), { offline: true });

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantumforge-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'nope', 'utf8');
    fs.symlinkSync(outsideFile, path.join(cwd, 'nested', 'escape-link'));

    await assert.rejects(
      fabric.invoke('fs.read', { path: '../secret.txt' }),
      /Access denied/
    );
    await assert.rejects(
      fabric.invoke('fs.read', { path: 'nested/escape-link' }),
      /Access denied/
    );

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

test('fabric persists registry metadata and rejects external tools without handlers', async () => {
  await withTempCwd(async () => {
    let fabric = freshRequire(fabricModulePath);

    fabric.register('demo.echo', {
      description: 'Echo input for tests',
      schema: { type: 'object' },
      handler: async (args) => args
    });
    fabric.saveRegistry();

    fabric = freshRequire(fabricModulePath);

    const listed = fabric.listTools();
    const persisted = listed.find((tool) => tool.name === 'demo.echo');
    assert.deepEqual(persisted, {
      name: 'demo.echo',
      description: 'Echo input for tests',
      schema: { type: 'object' }
    });

    await assert.rejects(
      fabric.invoke('demo.echo', { value: 1 }),
      /has no local handler/
    );
  });
});

test('fabric tolerates malformed registry files and still loads built-in tools', () => {
  withTempCwd((cwd) => {
    const registryPath = path.join(cwd, 'data', 'mcp-registry.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{not json', 'utf8');

    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const fabric = freshRequire(fabricModulePath);
      const toolNames = fabric.listTools().map((tool) => tool.name);

      assert.equal(toolNames.includes('fs.read'), true);
      assert.equal(toolNames.includes('fs.write'), true);
      assert.equal(warnings.length > 0, true);
    } finally {
      console.warn = warn;
    }
  });
});
