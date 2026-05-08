'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempCwd, freshRequire } = require('../support/helpers');

const memoryModulePath = path.join(__dirname, '..', 'src', 'memory', 'index.js');

test('memory initializes storage files and persists key-value data', () => {
  withTempCwd((cwd) => {
    const memory = freshRequire(memoryModulePath);
    const dataDir = path.join(cwd, 'data');

    assert.equal(fs.existsSync(path.join(dataDir, 'memory.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'episodes.json')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'mistakes.json')), true);

    memory.set('profile', { language: 'js', count: 2 });

    assert.deepEqual(memory.get('profile'), { language: 'js', count: 2 });
    assert.deepEqual(memory.getAll().memory, { profile: { language: 'js', count: 2 } });

    const reloaded = freshRequire(memoryModulePath);
    assert.deepEqual(reloaded.get('profile'), { language: 'js', count: 2 });
  });
});

test('memory rotates old episodes and returns recent history', () => {
  withTempCwd((cwd) => {
    const memory = freshRequire(memoryModulePath);
    const episodesPath = path.join(cwd, 'data', 'episodes.json');
    const seededEpisodes = Array.from({ length: 1000 }, (_, i) => ({
      task: `seed-task-${i}`,
      result: { index: i },
      ts: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString()
    }));

    fs.writeFileSync(episodesPath, JSON.stringify(seededEpisodes, null, 2), 'utf8');

    memory.saveEpisode({ task: 'task-1000', result: { index: 1000 } });
    memory.saveEpisode({ task: 'task-1001', result: { index: 1001 } });

    memory.saveMistake({ task: 'broken-task', error: 'boom' });

    const all = memory.getAll();
    assert.equal(all.episodes.length, 1000);
    assert.equal(all.episodes[0].task, 'seed-task-2');
    assert.match(all.episodes[0].ts, /\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      memory.recentEpisodes(2).map((episode) => episode.task),
      ['task-1000', 'task-1001']
    );
    assert.equal(all.mistakes.length, 1);
    assert.equal(memory.recentMistakes(1)[0].error, 'boom');
  });
});

test('memory surfaces corrupted JSON and tolerates missing files', () => {
  withTempCwd((cwd) => {
    const memory = freshRequire(memoryModulePath);
    const memoryPath = path.join(cwd, 'data', 'memory.json');

    fs.writeFileSync(memoryPath, '{broken json', 'utf8');
    assert.throws(() => memory.get('anything'), /Corrupted JSON/);

    fs.rmSync(memoryPath);
    assert.equal(memory.get('anything'), undefined);
  });
});
