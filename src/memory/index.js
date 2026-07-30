/**
 * Memory / episodes store (file-backed JSON).
 * Persists episodes (task + result pairs), mistakes, and key-value memory.
 *
 * Capacity caps (FIFO):
 *   - episodes capped at config.memory.maxEpisodes  (default 1000)
 *   - mistakes capped at config.memory.maxMistakes (default 1000)
 *
 * Race condition: read → modify → write is not atomic. A concurrent
 * saveEpisode + saveMistake + set can clobber. For a single-user Termux
 * process the probability is low; for multi-tenant use, swap to SQLite.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config/default.json');

const memPath = path.resolve(config.memory.path);
const epsPath = path.resolve(config.memory.episodesPath);
const mistakesPath = path.resolve(config.memory.mistakesPath);
const MAX_EPISODES = config.memory.maxEpisodes;
const MAX_MISTAKES = config.memory.maxMistakes || 1000;

function ensureFile(p, init) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(init, null, 2));
  }
}

function readJSON(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`[memory] Could not read ${p}: ${err.message}`);
  }
  // Separate the parse step so a corrupted file throws rather than silently
  // returning null and letting callers overwrite all prior history.
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[memory] Corrupted JSON in ${p}: ${err.message}`);
  }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

ensureFile(memPath, {});
ensureFile(epsPath, []);
ensureFile(mistakesPath, []);

function set(key, value) {
  const mem = readJSON(memPath) || {};
  mem[key] = value;
  writeJSON(memPath, mem);
}

function get(key) {
  const mem = readJSON(memPath) || {};
  return mem[key];
}

function getAll() {
  return {
    memory: readJSON(memPath) || {},
    episodes: readJSON(epsPath) || [],
    mistakes: readJSON(mistakesPath) || []
  };
}

function saveEpisode(episode) {
  const eps = readJSON(epsPath) || [];
  eps.push({ ...episode, ts: new Date().toISOString() });
  if (eps.length > MAX_EPISODES) eps.splice(0, eps.length - MAX_EPISODES);
  writeJSON(epsPath, eps);
}

function saveMistake(mistake) {
  const mistakes = readJSON(mistakesPath) || [];
  mistakes.push({ ...mistake, ts: new Date().toISOString() });
  // Cap mistakes to prevent slow-leak disk fill (was unbounded before)
  if (mistakes.length > MAX_MISTAKES) mistakes.splice(0, mistakes.length - MAX_MISTAKES);
  writeJSON(mistakesPath, mistakes);
}

function recentEpisodes(n = 10) {
  const eps = readJSON(epsPath) || [];
  return eps.slice(-n);
}

function recentMistakes(n = 10) {
  const mistakes = readJSON(mistakesPath) || [];
  return mistakes.slice(-n);
}

module.exports = {
  set, get, getAll, saveEpisode, saveMistake,
  recentEpisodes, recentMistakes,
  MAX_EPISODES, MAX_MISTAKES,
};
