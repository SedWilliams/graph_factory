import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGraph, slugify, toList } from '../src/graph/normalize.mjs';
import { fromYaml, toMarkdown, toYaml } from '../src/graph/serialize.mjs';
import { validateGraph } from '../src/graph/validate.mjs';
import { effectiveTools, entryNodes, findCycles, indexGraph, rankNodes, topoOrder } from '../src/graph/topology.mjs';
import { references, render } from '../src/graph/template.mjs';
import { starterGraphs, templateGraph } from '../src/graph/templates.mjs';

const linear = () =>
  normalizeGraph({
    id: 'linear',
    name: 'Linear',
    inputs: [{ id: 'task', required: true }],
    nodes: [
      { id: 'begin', type: 'start' },
      { id: 'one', type: 'agent', prompt: 'Do {{inputs.task}}', tools: ['read'], output: 'first' },
      { id: 'two', type: 'agent', prompt: 'Check {{first}}', tools: ['read'] },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { from: 'begin', to: 'one' },
      { from: 'one', to: 'two' },
      { from: 'two', to: 'done' },
    ],
  });

test('slugify keeps underscores so output names survive a round trip', () => {
  assert.equal(slugify('test_output'), 'test_output');
  assert.equal(slugify('My Node Name'), 'my-node-name');
  assert.equal(slugify('  '), 'node');
  assert.equal(slugify('---'), 'node');
  assert.equal(slugify('9lives'), '9lives');
});

test('toList accepts arrays, commas, and whitespace', () => {
  assert.deepEqual(toList(['read', 'grep']), ['read', 'grep']);
  assert.deepEqual(toList('read, grep, glob'), ['read', 'grep', 'glob']);
  assert.deepEqual(toList('read grep'), ['read', 'grep']);
  assert.deepEqual(toList(''), []);
  assert.deepEqual(toList(null), []);
});

test('normalize drops fields that do not belong to the node type', () => {
  const graph = normalizeGraph({ nodes: [{ id: 'tool', type: 'tool', run: 'npm test', prompt: 'should be dropped', model: 'x' }] });
  const node = graph.nodes[0];
  assert.equal(node.run, 'npm test');
  assert.equal(node.prompt, undefined);
  assert.equal(node.model, undefined);
});

test('normalize repairs duplicate node ids rather than dropping a node', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent' },
      { id: 'a', type: 'agent' },
      { id: 'a', type: 'agent' },
    ],
  });
  assert.deepEqual(
    graph.nodes.map(node => node.id),
    ['a', 'a-2', 'a-3'],
  );
});

test('normalize infers a branch edge from the presence of a condition', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent' },
      { id: 'b', type: 'agent' },
    ],
    edges: [{ source: 'a', target: 'b', when: 'contains(a, "yes")' }],
  });
  assert.equal(graph.edges[0].type, 'branch');
  assert.equal(graph.edges[0].from, 'a');
  assert.equal(graph.edges[0].to, 'b');
});

test('normalize removes duplicate edges', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent' },
      { id: 'b', type: 'agent' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b', type: 'handoff' },
    ],
  });
  assert.equal(graph.edges.length, 2);
});

test('YAML round trips byte for byte', () => {
  for (const graph of starterGraphs()) {
    const yaml = toYaml(graph);
    assert.equal(toYaml(fromYaml(yaml)), yaml, `${graph.id} is not stable`);
  }
});

test('YAML keeps multi-line prompts as readable block scalars', () => {
  const yaml = toYaml(templateGraph('plan-build-review'));
  assert.match(yaml, /prompt: \|-?\n/);
  assert.doesNotMatch(yaml, /prompt: "[^"]*\\n/);
});

test('every starter graph validates clean', () => {
  for (const graph of starterGraphs()) {
    const result = validateGraph(graph);
    assert.equal(result.errors.length, 0, `${graph.id}: ${result.errors.map(issue => issue.message).join('; ')}`);
  }
});

test('markdown export names every node and draws a mermaid diagram', () => {
  const graph = templateGraph('parallel-audit');
  const markdown = toMarkdown(graph);
  assert.match(markdown, /```mermaid/);
  for (const node of graph.nodes) assert.ok(markdown.includes(node.id), `missing ${node.id}`);
});

/* ------------------------------------------------------------- topology -- */

test('topological order respects flow and ignores uses edges', () => {
  const { order, complete } = topoOrder(linear());
  assert.ok(complete);
  assert.deepEqual(order, ['begin', 'one', 'two', 'done']);
});

test('a feedback edge is a legal cycle and does not break ordering', () => {
  const graph = templateGraph('review-until-clean');
  const cycles = findCycles(graph);
  assert.ok(cycles.length > 0);
  assert.ok(cycles.every(cycle => cycle.viaFeedback));
  assert.ok(topoOrder(graph).complete);
});

test('a cycle without a feedback edge is reported as an error', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent', prompt: 'x' },
      { id: 'b', type: 'agent', prompt: 'y' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  });
  const result = validateGraph(graph);
  assert.ok(result.errors.some(issue => issue.code === 'flow.cycle'));
});

test('entry nodes prefer an explicit start', () => {
  assert.deepEqual(
    entryNodes(linear()).map(node => node.id),
    ['begin'],
  );
});

test('ranking lays a pipeline out left to right', () => {
  const ranks = rankNodes(linear());
  assert.equal(ranks.get('begin'), 0);
  assert.equal(ranks.get('one'), 1);
  assert.equal(ranks.get('done'), 3);
});

test('a uses edge grants the agent a tool permission, not a step', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent', prompt: 'x', tools: ['read'] },
      { id: 'shell', type: 'tool', run: 'npm test' },
      { id: 'server', type: 'tool', mcp: 'mcp__db__query' },
    ],
    edges: [
      { from: 'a', to: 'shell', type: 'uses' },
      { from: 'a', to: 'server', type: 'uses' },
    ],
  });
  const tools = effectiveTools(graph, graph.nodes[0]);
  assert.deepEqual(tools.sort(), ['bash', 'mcp__db__query', 'read']);
  // And it must not appear in the control flow.
  assert.equal(indexGraph(graph).out.get('a').length, 0);
});

/* ------------------------------------------------------------ templates -- */

test('references are parsed into the right kinds', () => {
  const found = references('{{inputs.task}} {{plan}} {{nodes.plan.output}} {{env.HOME}} {{a.b.c.d}}');
  assert.deepEqual(
    found.map(reference => reference.kind),
    ['input', 'node', 'node', 'env', 'unknown'],
  );
});

test('render substitutes what it can and reports what it cannot', () => {
  const { output, missing } = render('Do {{inputs.task}} using {{plan}}', { inputs: { task: 'the thing' }, outputs: {} });
  assert.equal(output, 'Do the thing using ');
  assert.deepEqual(
    missing.map(reference => reference.id),
    ['plan'],
  );
});

/* ----------------------------------------------------------- validation -- */

test('a prompt reading a value produced downstream is an ordering error', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'first', type: 'agent', prompt: 'Use {{second}}', tools: ['read'] },
      { id: 'second', type: 'agent', prompt: 'go', tools: ['read'] },
    ],
    edges: [{ from: 'first', to: 'second' }],
  });
  const result = validateGraph(graph);
  assert.ok(
    result.errors.some(issue => issue.code === 'ref.order'),
    JSON.stringify(result.errors),
  );
});

test('an end node naming an existing output is not treated as a producer', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'begin', type: 'start' },
      { id: 'work', type: 'agent', prompt: 'go', tools: ['read'], output: 'result' },
      { id: 'check', type: 'agent', prompt: 'Review {{result}}', tools: ['read'] },
      { id: 'done', type: 'end', output: 'result' },
    ],
    edges: [
      { from: 'begin', to: 'work' },
      { from: 'work', to: 'check' },
      { from: 'check', to: 'done' },
    ],
  });
  assert.equal(validateGraph(graph).errors.length, 0);
});

test('a loop with no bound is an error and one with no cap is a warning', () => {
  const unbounded = normalizeGraph({
    nodes: [
      { id: 'l', type: 'loop' },
      { id: 'a', type: 'agent', prompt: 'x' },
    ],
    edges: [{ from: 'l', to: 'a' }],
  });
  assert.ok(validateGraph(unbounded).errors.some(issue => issue.code === 'loop.bound'));

  const uncapped = normalizeGraph({
    nodes: [
      { id: 'l', type: 'loop', until: 'done' },
      { id: 'a', type: 'agent', prompt: 'x' },
    ],
    edges: [{ from: 'l', to: 'a' }],
  });
  assert.ok(validateGraph(uncapped).warnings.some(issue => issue.code === 'loop.cap'));
});

test('a uses edge that does not run agent to tool is rejected', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent', prompt: 'x' },
      { id: 'b', type: 'agent', prompt: 'y' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'uses' }],
  });
  assert.ok(validateGraph(graph).errors.some(issue => issue.code === 'edge.uses'));
});

test('an edge pointing at a node that does not exist is reported', () => {
  const graph = normalizeGraph({ nodes: [{ id: 'a', type: 'agent', prompt: 'x' }], edges: [{ from: 'a', to: 'ghost' }] });
  assert.ok(validateGraph(graph).errors.some(issue => issue.code === 'edge.dangling'));
});

test('two producers of one output name warn but do not fail', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', type: 'agent', prompt: 'x', tools: ['read'], output: 'shared' },
      { id: 'b', type: 'agent', prompt: 'y', tools: ['read'], output: 'shared' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  const result = validateGraph(graph);
  assert.ok(result.warnings.some(issue => issue.code === 'node.output'));
  assert.equal(result.errors.length, 0);
});
