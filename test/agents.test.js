'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { freshRequire, withTempCwd } = require('../support/helpers');

const plannerModulePath = path.join(__dirname, '..', 'src', 'agents', 'planner.js');
const solverModulePath = path.join(__dirname, '..', 'src', 'agents', 'solver.js');
const criticModulePath = path.join(__dirname, '..', 'src', 'agents', 'critic.js');
const kernelModulePath = path.join(__dirname, '..', 'src', 'agents', 'kernel.js');
const memoryModulePath = path.join(__dirname, '..', 'src', 'memory', 'index.js');
const fabricModulePath = path.join(__dirname, '..', 'src', 'mcp', 'fabric.js');

test('planner falls back to a single step when the LLM response is invalid', async () => {
  await withTempCwd(async () => {
    const planner = freshRequire(plannerModulePath);

    const fallback = await planner.plan('ship feature', {}, async () => 'not json');
    assert.deepEqual(fallback, [{ step: 1, action: 'ship feature' }]);

    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const nonArray = await planner.plan('ship feature', {}, async () => '{"step":1}');
      assert.deepEqual(nonArray, [{ step: 1, action: 'ship feature' }]);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = warn;
    }
  });
});

test('solver handles raw responses and tool-call follow-up flows', async () => {
  await withTempCwd(async () => {
    const solver = freshRequire(solverModulePath, [fabricModulePath]);
    const fabric = require(fabricModulePath);
    const original = { listTools: fabric.listTools, invoke: fabric.invoke };

    fabric.listTools = () => [{ name: 'demo.echo', description: 'Echo a payload' }];
    fabric.invoke = async (name, args) => ({ name, args, ok: true });

    try {
      const rawResult = await solver.solve({ step: 1, action: 'say hi' }, {}, async () => 'plain text');
      assert.deepEqual(rawResult, { result: 'plain text', toolsUsed: [] });

      let replyIndex = 0;
      const toolResult = await solver.solve(
        { step: 2, action: 'use a tool' },
        { attempt: 1 },
        async () => {
          replyIndex += 1;
          if (replyIndex === 1) {
            return JSON.stringify({ toolCall: { name: 'demo.echo', args: { value: 7 } } });
          }
          return JSON.stringify({ result: 'completed' });
        }
      );

      assert.deepEqual(toolResult, { result: 'completed', toolsUsed: ['demo.echo'] });

      replyIndex = 0;
      const preservedToolResult = await solver.solve(
        { step: 3, action: 'use a tool again' },
        {},
        async () => {
          replyIndex += 1;
          if (replyIndex === 1) {
            return JSON.stringify({ toolCall: { name: 'demo.echo', args: { value: 9 } } });
          }
          return JSON.stringify({ result: 'completed', toolsUsed: [] });
        }
      );

      assert.deepEqual(preservedToolResult, { result: 'completed', toolsUsed: ['demo.echo'] });
    } finally {
      fabric.listTools = original.listTools;
      fabric.invoke = original.invoke;
    }
  });
});

test('critic validates parsed verdicts and rejects malformed responses', async () => {
  await withTempCwd(async () => {
    const critic = freshRequire(criticModulePath);

    const verdict = await critic.critique(
      { step: 1, action: 'check output' },
      { result: 'ok' },
      async () => JSON.stringify({ pass: true, feedback: 'looks good' })
    );
    assert.deepEqual(verdict, { pass: true, feedback: 'looks good' });

    await assert.rejects(
      critic.critique(
        { step: 1, action: 'check output' },
        { result: 'bad' },
        async () => JSON.stringify({ feedback: 'missing pass' })
      ),
      /missing the required boolean field/
    );
  });
});

test('kernel retries failed steps, threads critic feedback, and emits progress chunks', async () => {
  await withTempCwd(async () => {
    const kernel = freshRequire(kernelModulePath, [
      plannerModulePath,
      solverModulePath,
      criticModulePath,
      memoryModulePath,
      fabricModulePath
    ]);
    const planner = require(plannerModulePath);
    const solver = require(solverModulePath);
    const critic = require(criticModulePath);
    const memory = require(memoryModulePath);
    const original = {
      recentEpisodes: memory.recentEpisodes,
      plan: planner.plan,
      solve: solver.solve,
      critique: critic.critique
    };
    const solverContexts = [];
    const events = [];
    let critiqueCount = 0;

    memory.recentEpisodes = () => [{ task: 'past task' }];
    planner.plan = async (_task, context) => {
      assert.deepEqual(context.recentEpisodes, [{ task: 'past task' }]);
      return [
        { step: 1, action: 'first' },
        { step: 2, action: 'second' }
      ];
    };
    solver.solve = async (step, context) => {
      solverContexts.push({ step: step.step, criticFeedback: context.criticFeedback });
      return { result: `result-${step.step}` };
    };
    critic.critique = async (step) => {
      critiqueCount += 1;
      if (step.step === 1 && critiqueCount === 1) {
        return { pass: false, feedback: 'retry with more detail' };
      }
      return { pass: true, feedback: '' };
    };

    try {
      const result = await kernel.run('build feature', { scope: 'tests' }, (chunk) => events.push(chunk.type));

      assert.deepEqual(solverContexts, [
        { step: 1, criticFeedback: undefined },
        { step: 1, criticFeedback: 'retry with more detail' },
        { step: 2, criticFeedback: undefined }
      ]);
      assert.equal(result.results[0].rounds, 2);
      assert.equal(result.results[0].accepted, true);
      assert.equal(result.results[1].rounds, 1);
      assert.match(result.summary, /Step 1: result-1/);
      assert.deepEqual(events, [
        'planning',
        'steps',
        'solving',
        'critiquing',
        'verdict',
        'solving',
        'critiquing',
        'verdict',
        'solving',
        'critiquing',
        'verdict'
      ]);
    } finally {
      memory.recentEpisodes = original.recentEpisodes;
      planner.plan = original.plan;
      solver.solve = original.solve;
      critic.critique = original.critique;
    }
  });
});

test('kernel offline mode uses the built-in stub pipeline without an API key', async () => {
  await withTempCwd(async () => {
    const kernel = freshRequire(kernelModulePath, [
      plannerModulePath,
      solverModulePath,
      criticModulePath,
      memoryModulePath,
      fabricModulePath
    ]);
    const memory = require(memoryModulePath);
    const originalRecentEpisodes = memory.recentEpisodes;
    const originalApiKey = process.env.OPENAI_API_KEY;

    memory.recentEpisodes = () => [];
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await kernel.run('draft release notes');

      assert.deepEqual(result.steps, [{ step: 1, action: 'draft release notes' }]);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].accepted, true);
      assert.match(result.results[0].result.result, /^\[offline\]/);
    } finally {
      memory.recentEpisodes = originalRecentEpisodes;
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });
});
