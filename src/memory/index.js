/**
 * Memory / episodes store (file-backed JSON).
 * Persists episodes (task + result pairs), mistakes, and key-value memory.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config/default.json');

const memPath = path.resolve(config.memory.path);
const epsPath = path.resolve(config.memory.episodesPath);
const mistakesPath = path.resolve(config.memory.mistakesPath);
const MAX_EPISODES = config.memory.maxEpisodes;

function ensureFile(p, init) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(init, null, 2));
  }
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[memory] Could not parse ${p}:`, err.message);
    }
    return null;
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

module.exports = { set, get, getAll, saveEpisode, saveMistake, recentEpisodes, recentMistakes };
