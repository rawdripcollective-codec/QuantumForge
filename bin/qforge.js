#!/usr/bin/env node
/**
 * qforge — QuantumForge CLI
 *
 * Run agent tasks directly from the shell. Posts to the running gateway
 * at http://127.0.0.1:18789 (or QFORGE_URL env var).
 *
 * Usage:
 *   qforge "list the files in this directory"
 *   qforge "find the package.json and report its version" --json
 *   qforge --status
 *   qforge --providers
 *
 * Examples (Termux):
 *   qforge "write a hello world script to hello.js"
 *   qforge "run the tests" --json
 *
 * Environment:
 *   QFORGE_URL      Gateway URL  (default: http://127.0.0.1:18789)
 *   QFORGE_TIMEOUT  Request timeout in ms (default: 120000)
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.env.QFORGE_URL || 'http://127.0.0.1:18789';
const TIMEOUT  = parseInt(process.env.QFORGE_TIMEOUT || '120000', 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function request(path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const postData = body ? JSON.stringify(body) : null;
    const reqOpts = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   body ? 'POST' : 'GET',
      headers:  {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'User-Agent':   'qforge/1.0',
      },
    };

    const req = client.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(TIMEOUT, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT}ms`));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

function pp(json) {
  console.log(JSON.stringify(json, null, 2));
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const health = await request('/health');
  pp(health);
}

async function cmdProviders() {
  const providers = await request('/api/providers');
  pp(providers);
}

async function cmdTools() {
  const tools = await request('/api/tools');
  pp(tools);
}

async function cmdMemory() {
  const mem = await request('/api/memory');
  pp(mem);
}

async function cmdSelfImprove() {
  const status = await request('/api/self-improve/status');
  pp(status);
}

async function cmdRun(task, opts = {}) {
  process.stdout.write(`Running agent: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}\n\n`);

  const result = await request('/api/agent', { task });

  if (opts.json) {
    pp(result);
  } else {
    console.log('=== Summary ===');
    console.log(result.summary || '(no summary)');
    if (result.costUsd !== undefined) {
      console.log(`\nCost: $${result.costUsd.toFixed(4)} USD`);
    }
    if (result.steps) {
      console.log(`\nSteps: ${result.steps.length}`);
      result.results?.forEach((r, i) => {
        const label = r.accepted ? '✅' : '❌';
        console.log(`  ${label} Step ${i + 1}: ${r.step?.action || '(unknown)'}`);
      });
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opts = { json: false };
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json' || arg === '-j') {
    opts.json = true;
  } else if (arg === '--status' || arg === '-s') {
    cmdStatus().catch((e) => { console.error(e.message); process.exit(1); });
    return;
  } else if (arg === '--providers' || arg === '-p') {
    cmdProviders().catch((e) => { console.error(e.message); process.exit(1); });
    return;
  } else if (arg === '--tools' || arg === '-t') {
    cmdTools().catch((e) => { console.error(e.message); process.exit(1); });
    return;
  } else if (arg === '--memory' || arg === '-m') {
    cmdMemory().catch((e) => { console.error(e.message); process.exit(1); });
    return;
  } else if (arg === '--self-improve' || arg === '-i') {
    cmdSelfImprove().catch((e) => { console.error(e.message); process.exit(1); });
    return;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    return;
  } else {
    positional.push(arg);
  }
}

if (positional.length === 0) {
  console.error('qforge: no task specified.\n');
  printHelp();
  process.exit(1);
}

const task = positional.join(' ');
cmdRun(task, opts).catch((e) => {
  console.error(`qforge: error — ${e.message}`);
  process.exit(1);
});

function printHelp() {
  console.log(`qforge — QuantumForge CLI

Usage:
  qforge "task description"       Run an agent task
  qforge --status (-s)             Show gateway health & provider
  qforge --providers (-p)         List configured LLM providers
  qforge --tools (-t)              List available MCP tools
  qforge --memory (-m)             Show recent memory episodes
  qforge --self-improve (-i)       Show self-improve status
  qforge "task" --json (-j)        Output raw JSON result

Examples:
  qforge "list the files in this directory"
  qforge "find package.json and report the version"
  qforge "write a hello world script to hello.js" --json

Environment:
  QFORGE_URL      Gateway URL  (default: http://127.0.0.1:18789)
  QFORGE_TIMEOUT  Request timeout in ms (default: 120000)

The gateway must be running. Start it with: npm start`);
}
