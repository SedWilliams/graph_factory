import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGraph } from '../src/graph/normalize.mjs';
import { templateGraph } from '../src/graph/templates.mjs';
import { runGraph } from '../src/run/executor.mjs';
import { evaluateCondition } from '../src/run/conditions.mjs';
import { buildCommand, COMMANDS, createDryAdapter } from '../src/run/adapters.mjs';

// A scripted adapter: each node id maps to the text that step should "return", so a
// test can steer a router or a loop without a model in the loop.
function scripted(script = {}) {
  const calls = [];
  return {
    adapter: {
      name: 'scripted',
      live: false,
      async agent(step) {
        calls.push({ id: step.id, prompt: step.prompt, tools: step.tools, model: step.model });
        const value = script[step.id];
        return { output: typeof value === 'function' ? value(calls) : (value ?? `output of ${step.id}`) };
      },
      async tool(step) {
        calls.push({ id: step.id, run: step.run });
        return { output: script[step.id] ?? '' };
      },
    },
    calls,
  };
}

/* ------------------------------------------------------------ conditions -- */

test('conditions cover the predicates a review router needs', () => {
  const scope = { outputs: { review: 'Looks good. APPROVED', notes: '   ', count: '3' }, inputs: { mode: 'strict' } };
  const check = expression => evaluateCondition(expression, scope).value;

  assert.equal(check('contains(review, "approved")'), true);
  assert.equal(check('contains(review, "rejected")'), false);
  assert.equal(check('not contains(review, "rejected")'), true);
  assert.equal(check('empty(notes)'), true);
  assert.equal(check('not empty(review)'), true);
  assert.equal(check('equals(inputs.mode, "strict")'), true);
  assert.equal(check('startswith(review, "looks")'), true);
  assert.equal(check('endswith(review, "APPROVED")'), true);
  assert.equal(check('matches(review, "APP.OVED")'), true);
  assert.equal(check('contains(review, "APPROVED") and not empty(count)'), true);
  assert.equal(check('empty(review) or contains(review, "APPROVED")'), true);
  assert.equal(check(''), true);
});

test('a separator inside a quoted argument does not split the expression', () => {
  const scope = { outputs: { review: 'ready and waiting' } };
  assert.equal(evaluateCondition('contains(review, "and waiting")', scope).value, true);
});

test('an unparsable condition is false rather than silently true', () => {
  const verdict = evaluateCondition('matches(x, "[unclosed")', { outputs: { x: 'a' } });
  assert.equal(verdict.value, false);
  assert.match(verdict.reason, /unparsable/);
});

/* -------------------------------------------------------------- adapters -- */

test('each harness adapter builds the command line its CLI actually takes', () => {
  const step = { id: 'reviewer', agent: 'reviewer', prompt: 'Review it', system: 'Be terse', model: 'claude-opus-5', tools: ['read', 'glob'] };

  const claude = buildCommand('claude', step);
  assert.equal(claude.command, 'claude');
  assert.ok(claude.args.includes('-p'));
  assert.equal(claude.args[claude.args.indexOf('--allowedTools') + 1], 'Read,Glob');
  assert.equal(claude.args[claude.args.indexOf('--model') + 1], 'claude-opus-5');

  const pi = buildCommand('pi', step);
  assert.ok(pi.args.includes('--print'));
  // pi maps glob onto find, and takes the message as the final positional.
  assert.equal(pi.args[pi.args.indexOf('--tools') + 1], 'read,find');
  assert.equal(pi.args[pi.args.length - 1], 'Review it');

  const opencode = buildCommand('opencode', step);
  assert.equal(opencode.args[0], 'run');
  assert.equal(opencode.args[opencode.args.indexOf('--model') + 1], 'anthropic/claude-opus-5');
  assert.equal(opencode.args[opencode.args.indexOf('--agent') + 1], 'reviewer');

  const codex = buildCommand('codex', { ...step }, { graphId: 'my-graph' });
  assert.equal(codex.args[0], 'exec');
  assert.equal(codex.args[codex.args.indexOf('--profile') + 1], 'my-graph-reviewer');
});

test('an unknown harness is refused by name', () => {
  assert.throws(() => buildCommand('nope', { prompt: 'x' }), /No adapter for harness "nope"/);
  assert.deepEqual(Object.keys(COMMANDS), ['claude', 'pi', 'opencode', 'codex']);
});

test('the dry adapter reports the command without running it', async () => {
  const adapter = createDryAdapter();
  const result = await adapter.agent({ id: 'a', prompt: 'hello', tools: ['read'], model: 'claude-opus-5', harness: 'claude' }, {});
  assert.equal(result.invocation.command, 'claude');
  assert.match(result.output, /dry run/);
});

/* -------------------------------------------------------------- executor -- */

test('a linear pipeline runs in order and threads outputs through prompts', async () => {
  const graph = templateGraph('plan-build-review');
  const { adapter, calls } = scripted({ planner: 'THE PLAN', tests: 'all green' });
  const result = await runGraph(graph, { adapter, inputs: { task: 'add health check' } });

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.steps.map(step => step.id),
    ['begin', 'planner', 'builder', 'tests', 'reviewer', 'done'],
  );
  assert.match(calls.find(call => call.id === 'planner').prompt, /add health check/);
  // The builder must receive the planner's actual output, not a reference to it.
  assert.match(calls.find(call => call.id === 'builder').prompt, /THE PLAN/);
  assert.match(calls.find(call => call.id === 'reviewer').prompt, /all green/);
});

test('a router takes the branch whose condition holds', async () => {
  const graph = templateGraph('review-until-clean');
  const { adapter } = scripted({ reviewer: 'Ship it. APPROVED' });
  const result = await runGraph(graph, { adapter, inputs: { task: 'x' } });

  assert.equal(result.status, 'completed');
  assert.ok(result.steps.some(step => step.id === 'shipped'));
  assert.equal(result.journal.filter(event => event.kind === 'loop.rewind').length, 0);
});

test('a feedback edge re-runs the loop body and stops when the condition holds', async () => {
  const graph = templateGraph('review-until-clean');
  let round = 0;
  const { adapter, calls } = scripted({
    reviewer: () => {
      round += 1;
      return round >= 3 ? 'APPROVED' : 'CHANGES REQUESTED';
    },
  });
  const result = await runGraph(graph, { adapter, inputs: { task: 'x' } });

  assert.equal(result.status, 'completed');
  assert.equal(result.journal.filter(event => event.kind === 'loop.rewind').length, 2);
  assert.equal(calls.filter(call => call.id === 'builder').length, 3);
  assert.ok(result.steps.some(step => step.id === 'shipped'));
});

test('a loop that never satisfies its condition stops at the cap instead of spinning', async () => {
  const graph = templateGraph('review-until-clean');
  const { adapter, calls } = scripted({ reviewer: 'CHANGES REQUESTED' });
  const result = await runGraph(graph, { adapter, inputs: { task: 'x' } });

  assert.equal(result.status, 'exhausted');
  // maxIterations is 3 on the loop header, so the builder runs the initial pass plus
  // three retries and then the run gives up.
  assert.equal(calls.filter(call => call.id === 'builder').length, 4);
  assert.ok(result.journal.some(event => event.kind === 'loop.exhausted'));
});

test('parallel branches all run and the join waits for every one of them', async () => {
  const graph = templateGraph('parallel-audit');
  const order = [];
  const adapter = {
    name: 'ordered',
    live: false,
    async agent(step) {
      order.push(`start:${step.id}`);
      await new Promise(resolve => setTimeout(resolve, step.id === 'security' ? 30 : 1));
      order.push(`end:${step.id}`);
      return { output: `${step.id} report` };
    },
    async tool() {
      return { output: '' };
    },
  };
  const result = await runGraph(graph, { adapter, inputs: { target: 'src/' }, onGate: async () => ({ approved: true }) });

  assert.equal(result.status, 'completed');
  // All three start before the slowest finishes: they really are concurrent.
  const firstEnd = order.findIndex(entry => entry.startsWith('end:'));
  assert.ok(order.slice(0, firstEnd).length >= 3, `not concurrent: ${order.join(' ')}`);
  // And the merge waited for the slow one.
  assert.ok(order.indexOf('start:merge') > order.indexOf('end:security'));
});

test('a rejected gate stops the run and leaves the downstream steps unrun', async () => {
  const graph = templateGraph('parallel-audit');
  const { adapter } = scripted();
  const result = await runGraph(graph, { adapter, inputs: { target: 'x' }, onGate: async () => ({ approved: false, note: 'no' }) });

  assert.equal(result.status, 'rejected');
  assert.ok(!result.steps.some(step => step.id === 'filed'));
});

test('a failing step fails the run and names the step', async () => {
  const graph = templateGraph('plan-build-review');
  const adapter = {
    name: 'broken',
    live: false,
    async agent(step) {
      if (step.id === 'builder') throw new Error('claude exited 1');
      return { output: 'ok' };
    },
    async tool() {
      return { output: '' };
    },
  };
  const result = await runGraph(graph, { adapter, inputs: { task: 'x' } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Step "builder" failed/);
});

test('the executor refuses to run a graph that does not validate', async () => {
  const graph = normalizeGraph({ nodes: [{ id: 'a', type: 'agent' }] });
  await assert.rejects(() => runGraph(graph, { harness: 'dry' }), /validation error/);
});

test('an input falls back to its declared default', async () => {
  const graph = normalizeGraph({
    id: 'defaults',
    inputs: [{ id: 'target', default: 'the working tree' }],
    nodes: [
      { id: 'begin', type: 'start' },
      { id: 'a', type: 'agent', prompt: 'Audit {{inputs.target}}', tools: ['read'] },
    ],
    edges: [{ from: 'begin', to: 'a' }],
  });
  const { adapter, calls } = scripted();
  await runGraph(graph, { adapter });
  assert.match(calls.find(call => call.id === 'a').prompt, /the working tree/);
});
