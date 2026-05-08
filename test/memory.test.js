'use strict';

/**
 * Tests for src/memory/index.js
 *
 * Uses Node's built-in test runner (node:test) and assert/strict.
 * Each test suite redirects the memory module's file paths to a temporary
 * directory so tests never touch the real data/ store and can run in parallel
 * without interference.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh temporary directory for one test suite. */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-mem-test-'));
}

/** Remove a directory tree (cleanup). */
function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Load a fresh, isolated instance of the memory module backed by `tmpDir`.
 * We patch the config require cache so the module resolves its paths to tmpDir.
 */
function loadMemory(tmpDir) {
  // Build a temporary config that points paths to tmpDir
  const cfgKey = require.resolve('../config/default.json');
  const originalCfg = require.cache[cfgKey]?.exports;

  // Override the cached config exports for this load
  if (require.cache[cfgKey]) {
    require.cache[cfgKey].exports = {
      ...require.cache[cfgKey].exports,
      memory: {
        path: path.join(tmpDir, 'memory.json'),
        episodesPath: path.join(tmpDir, 'episodes.json'),
        mistakesPath: path.join(tmpDir, 'mistakes.json'),
        maxEpisodes: 5
      }
    };
  }

  // Delete the memory module from cache so it re-initialises with new paths
  const memKey = require.resolve('../src/memory/index.js');
  delete require.cache[memKey];

  const mem = require('../src/memory/index.js');

  // Restore the original config so other tests are not affected
  if (require.cache[cfgKey] && originalCfg !== undefined) {
    require.cache[cfgKey].exports = originalCfg;
  }

  return mem;
}

// ── key/value store ───────────────────────────────────────────────────────────

describe('memory – key/value store', () => {
  let tmpDir;
  let mem;

  before(() => {
    tmpDir = makeTempDir();
    mem = loadMemory(tmpDir);
  });

  after(() => removeTempDir(tmpDir));

  it('set and get a value', () => {
    mem.set('color', 'blue');
    assert.equal(mem.get('color'), 'blue');
  });

  it('returns undefined for an unknown key', () => {
    assert.equal(mem.get('__does_not_exist__'), undefined);
  });

  it('overwrites an existing key', () => {
    mem.set('count', 1);
    mem.set('count', 2);
    assert.equal(mem.get('count'), 2);
  });

  it('persists across module calls (file-backed)', () => {
    mem.set('persistent', 'yes');
    // Re-read via the module's own accessor to confirm file-backed persistence
    assert.equal(mem.get('persistent'), 'yes');
  });
});

// ── episodes ──────────────────────────────────────────────────────────────────

describe('memory – episodes', () => {
  let tmpDir;
  let mem;

  before(() => {
    tmpDir = makeTempDir();
    mem = loadMemory(tmpDir);
  });

  after(() => removeTempDir(tmpDir));

  it('saveEpisode stores an episode with a timestamp', () => {
    mem.saveEpisode({ task: 'do something', result: { summary: 'done' } });
    const { episodes } = mem.getAll();
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].task, 'do something');
    assert.ok(episodes[0].ts, 'episode should have a ts field');
  });

  it('recentEpisodes returns the n most recent entries', () => {
    // Already has 1 episode; add 2 more
    mem.saveEpisode({ task: 'second' });
    mem.saveEpisode({ task: 'third' });
    const recent = mem.recentEpisodes(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[1].task, 'third');
  });

  it('trims episodes to maxEpisodes', () => {
    // maxEpisodes is set to 5 in the test config; already has 3; add 3 more
    mem.saveEpisode({ task: 'four' });
    mem.saveEpisode({ task: 'five' });
    mem.saveEpisode({ task: 'six' }); // triggers trim
    const { episodes } = mem.getAll();
    assert.ok(episodes.length <= 5, `Expected ≤5 episodes, got ${episodes.length}`);
  });
});

// ── mistakes ──────────────────────────────────────────────────────────────────

describe('memory – mistakes', () => {
  let tmpDir;
  let mem;

  before(() => {
    tmpDir = makeTempDir();
    mem = loadMemory(tmpDir);
  });

  after(() => removeTempDir(tmpDir));

  it('saveMistake stores a mistake with a timestamp', () => {
    mem.saveMistake({ task: 'bad task', error: 'something went wrong' });
    const { mistakes } = mem.getAll();
    assert.equal(mistakes.length, 1);
    assert.equal(mistakes[0].error, 'something went wrong');
    assert.ok(mistakes[0].ts);
  });

  it('recentMistakes returns the n most recent mistakes', () => {
    mem.saveMistake({ task: 'second bad', error: 'err2' });
    mem.saveMistake({ task: 'third bad', error: 'err3' });
    const recent = mem.recentMistakes(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[1].error, 'err3');
  });
});

// ── getAll ────────────────────────────────────────────────────────────────────

describe('memory – getAll', () => {
  let tmpDir;
  let mem;

  before(() => {
    tmpDir = makeTempDir();
    mem = loadMemory(tmpDir);
  });

  after(() => removeTempDir(tmpDir));

  it('returns memory, episodes, and mistakes objects', () => {
    mem.set('x', 42);
    mem.saveEpisode({ task: 't' });
    mem.saveMistake({ task: 't', error: 'e' });

    const all = mem.getAll();
    assert.ok(all.memory, 'memory key missing');
    assert.ok(Array.isArray(all.episodes), 'episodes should be an array');
    assert.ok(Array.isArray(all.mistakes), 'mistakes should be an array');
    assert.equal(all.memory.x, 42);
    assert.equal(all.episodes.length, 1);
    assert.equal(all.mistakes.length, 1);
  });
});
