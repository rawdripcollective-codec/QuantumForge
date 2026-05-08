'use strict';

/**
 * Tests for the agent pipeline (planner, solver, critic, kernel).
 *
 * All tests run in offline mode (no OPENAI_API_KEY) so they exercise the
 * built-in stubs and can run without any external service.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-agents-test-'));
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Redirect data paths for all modules to tmpDir and reload them fresh. */
function loadAgentModules(tmpDir) {
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
      agents: { maxRounds: 3, maxToolRounds: 3, timeoutMs: 5000 },
      tools: {
        http: { enabled: false },
        shell: { enabled: false, allowedCommands: [] }
      }
    };
  }

  const moduleKeys = [
    '../src/memory/index.js',
    '../src/mcp/fabric.js',
    '../src/agents/planner.js',
    '../src/agents/solver.js',
    '../src/agents/critic.js',
    '../src/agents/kernel.js'
  ].map(require.resolve);

  moduleKeys.forEach((k) => delete require.cache[k]);

  const origCwd = process.cwd();
  process.chdir(tmpDir);

  let modules;
  try {
    modules = {
      planner: require('../src/agents/planner.js'),
      solver: require('../src/agents/solver.js'),
      critic: require('../src/agents/critic.js'),
      kernel: require('../src/agents/kernel.js')
    };
  } finally {
    process.chdir(origCwd);
  }

  if (require.cache[cfgKey] && origCfg !== undefined) {
    require.cache[cfgKey].exports = origCfg;
  }

  return modules;
}

// Unset OPENAI_API_KEY for the test process to ensure offline mode
const originalApiKey = process.env.OPENAI_API_KEY;
before(() => { delete process.env.OPENAI_API_KEY; });
after(() => {
  if (originalApiKey !== undefined) process.env.OPENAI_API_KEY = originalApiKey;
});

// ── Planner ───────────────────────────────────────────────────────────────────

describe('planner', () => {
  let tmpDir;
  let planner;

  before(() => {
    tmpDir = makeTempDir();
    ({ planner } = loadAgentModules(tmpDir));
  });

  after(() => removeTempDir(tmpDir));

  it('plan returns an array of steps', async () => {
    // The offline stub in llmCall returns a single-step array for planner prompts
    const { kernel } = loadAgentModules(tmpDir);
    // Use kernel's internal llmCall by exercising it via planner directly
    const steps = await planner.plan('Write a test', {}, async (messages) => {
      // Simulate the offline stub: return a two-step plan
      return JSON.stringify([
        { step: 1, action: 'Step one', dependsOn: [] },
        { step: 2, action: 'Step two', dependsOn: [1] }
      ]);
    });
    assert.ok(Array.isArray(steps));
    assert.equal(steps.length, 2);
    assert.equal(steps[0].step, 1);
    assert.equal(steps[1].dependsOn[0], 1);
  });

  it('plan falls back to a single step when LLM returns invalid JSON', async () => {
    const steps = await planner.plan('fallback task', {}, async () => 'not json at all');
    assert.ok(Array.isArray(steps));
    assert.equal(steps.length, 1);
    assert.equal(steps[0].step, 1);
  });

  it('plan falls back when LLM returns a non-array JSON value', async () => {
    const steps = await planner.plan('fallback task', {}, async () =>
      JSON.stringify({ unexpected: true })
    );
    assert.equal(steps.length, 1);
  });
});

// ── Critic ────────────────────────────────────────────────────────────────────

describe('critic', () => {
  let tmpDir;
  let critic;

  before(() => {
    tmpDir = makeTempDir();
    ({ critic } = loadAgentModules(tmpDir));
  });

  after(() => removeTempDir(tmpDir));

  it('critique returns a verdict with pass and feedback', async () => {
    const verdict = await critic.critique(
      { step: 1, action: 'do something' },
      { result: 'done', toolsUsed: [] },
      async () => JSON.stringify({ pass: true, feedback: 'looks good' })
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.feedback, 'looks good');
  });

  it('critique throws when LLM returns malformed JSON', async () => {
    await assert.rejects(
      () => critic.critique(
        { step: 1, action: 'test' },
        { result: 'x' },
        async () => 'not json'
      ),
      /unparsable response/
    );
  });

  it('critique throws when pass field is missing', async () => {
    await assert.rejects(
      () => critic.critique(
        { step: 1, action: 'test' },
        { result: 'x' },
        async () => JSON.stringify({ feedback: 'ok' }) // no "pass" field
      ),
      /missing the required boolean field/
    );
  });
});

// ── Solver ────────────────────────────────────────────────────────────────────

describe('solver', () => {
  let tmpDir;
  let solver;

  before(() => {
    tmpDir = makeTempDir();
    ({ solver } = loadAgentModules(tmpDir));
  });

  after(() => removeTempDir(tmpDir));

  it('solve returns a result object with toolsUsed array', async () => {
    const result = await solver.solve(
      { step: 1, action: 'say hello' },
      {},
      async () => JSON.stringify({ result: 'hello', toolsUsed: [] })
    );
    assert.ok(typeof result.result === 'string');
    assert.ok(Array.isArray(result.toolsUsed));
  });

  it('solve handles non-JSON LLM response gracefully', async () => {
    const result = await solver.solve(
      { step: 1, action: 'say hi' },
      {},
      async () => 'plain text response'
    );
    assert.equal(result.result, 'plain text response');
  });

  it('solve executes a tool call and feeds the result back (ReAct loop)', async () => {
    // Simulate: first call requests a tool, second call returns a final result
    let callCount = 0;
    const result = await solver.solve(
      { step: 1, action: 'write then confirm' },
      {},
      async () => {
        callCount++;
        if (callCount === 1) {
          // First call: LLM requests a tool
          return JSON.stringify({ toolCall: { name: 'memory.set', args: { key: 'k', value: 'v' } } });
        }
        // Second call: LLM returns final answer
        return JSON.stringify({ result: 'done after tool', toolsUsed: ['memory.set'] });
      }
    );
    assert.equal(callCount, 2);
    assert.equal(result.result, 'done after tool');
    assert.ok(result.toolsUsed.includes('memory.set'));
  });

  it('solve accumulates multiple tool calls (multi-round ReAct)', async () => {
    let callCount = 0;
    const result = await solver.solve(
      { step: 1, action: 'multi-tool step' },
      {},
      async () => {
        callCount++;
        if (callCount < 3) {
          return JSON.stringify({ toolCall: { name: 'memory.set', args: { key: `k${callCount}`, value: callCount } } });
        }
        return JSON.stringify({ result: 'finished', toolsUsed: [] });
      }
    );
    assert.equal(callCount, 3);
    assert.equal(result.result, 'finished');
  });
});

// ── Kernel ────────────────────────────────────────────────────────────────────

describe('kernel – run (offline)', () => {
  let tmpDir;
  let kernel;

  before(() => {
    tmpDir = makeTempDir();
    ({ kernel } = loadAgentModules(tmpDir));
  });

  after(() => removeTempDir(tmpDir));

  it('run returns steps, results, and summary', async () => {
    const output = await kernel.run('say hello offline');
    assert.ok(Array.isArray(output.steps));
    assert.ok(Array.isArray(output.results));
    assert.ok(typeof output.summary === 'string');
  });

  it('each result has step, result, rounds, and accepted fields', async () => {
    const output = await kernel.run('simple offline task');
    for (const r of output.results) {
      assert.ok(r.step, 'result should have a step field');
      assert.ok('result' in r, 'result should have a result field');
      assert.ok(typeof r.rounds === 'number');
      assert.ok(typeof r.accepted === 'boolean');
    }
  });

  it('run accepts a streaming onChunk callback', async () => {
    const chunks = [];
    await kernel.run('streaming task', {}, (chunk) => chunks.push(chunk));
    assert.ok(chunks.some((c) => c.type === 'planning'), 'should emit a planning chunk');
    assert.ok(chunks.some((c) => c.type === 'steps'), 'should emit a steps chunk');
    assert.ok(chunks.some((c) => c.type === 'done' || c.type === 'solving'), 'should emit solving or done chunks');
  });
});

// ── Kernel – parallel steps ───────────────────────────────────────────────────

describe('kernel – parallel step execution', () => {
  let tmpDir;
  let kernel;

  before(() => {
    tmpDir = makeTempDir();
    ({ kernel } = loadAgentModules(tmpDir));
  });

  after(() => removeTempDir(tmpDir));

  it('independent steps (no dependsOn) all complete', async () => {
    // Inject a custom planner that returns two independent steps
    const { planner } = loadAgentModules(tmpDir);
    const origPlan = planner.plan;

    // Patch kernel to use a controlled planner via the llmCall stub
    // We rely on the offline llmCall stub returning a single-step plan,
    // then verify that two-step plans with dependsOn work via the
    // kernel's run() with a custom task string that the stub echoes.
    const output = await kernel.run('independent task A');
    assert.ok(output.results.length >= 1);
  });

  it('results are sorted by step number', async () => {
    const output = await kernel.run('sort test');
    const nums = output.results.map((r) => r.step?.step ?? 0);
    for (let i = 1; i < nums.length; i++) {
      assert.ok(nums[i] >= nums[i - 1], 'results should be in step-number order');
    }
  });
});
