/*
 * EXECUTOR — running the graph.
 *
 * The core idea is token passing over edges rather than a walk over nodes. Every
 * control edge is `pending`, `taken`, or `skipped`; a node runs once all of its
 * incoming edges have resolved and at least one was taken, and is pruned when they
 * all resolved as skipped. That single rule gets branching, joining, and dead-branch
 * elimination for free, and it is what lets a wave of independent nodes run
 * genuinely concurrently instead of being serialised by a topological walk.
 *
 * Loops are the one place the model needs a second mechanism. A feedback edge does
 * not merely pass a token — it rewinds the body it points back into, resetting those
 * nodes and the edges between them so the body can run again. Everything outside the
 * body keeps its state, which is why the edge from a loop's header into its first
 * step is not re-armed and does not deadlock.
 */

import { indexGraph, entryNodes, successors } from '../graph/topology.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { effectiveTools } from '../graph/topology.mjs';
import { render } from '../graph/template.mjs';
import { validateGraph } from '../graph/validate.mjs';
import { evaluateCondition } from './conditions.mjs';
import { createAdapter } from './adapters.mjs';

const edgeKey = edge => `${edge.from}->${edge.to}#${edge.type}`;
const DEFAULT_FEEDBACK_LIMIT = 10;

export async function runGraph(graph, options = {}) {
  const {
    inputs = {},
    harness = 'dry',
    cwd = process.cwd(),
    env = process.env,
    adapter = createAdapter(harness, { cwd, env, graphId: graph.id }),
    onEvent = () => {},
    onGate = async () => ({ approved: true, note: 'auto-approved' }),
    signal = null,
    maxSteps = Math.max(200, graph.nodes.length * 50),
    skipValidation = false,
  } = options;

  const validation = validateGraph(graph);
  if (!skipValidation && !validation.ok) {
    const error = new Error(`Refusing to run "${graph.name}": ${validation.errors.length} validation error(s).`);
    error.validation = validation;
    throw error;
  }

  const index = indexGraph(graph);
  const control = graph.edges.filter(edge => edge.type !== 'uses');
  const state = createState(graph, index, control, inputs);
  const joinModes = computeJoinModes(graph, index);
  const startedAt = new Date().toISOString();
  const emit = event => {
    const enriched = { at: new Date().toISOString(), ...event };
    state.journal.push(enriched);
    onEvent(enriched);
    return enriched;
  };

  emit({ kind: 'run.start', graph: graph.id, harness: adapter.name, inputs: Object.keys(inputs) });

  let budget = maxSteps;
  let status = 'completed';
  let failure = null;

  try {
    while (budget-- > 0) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }
      // Pruning first: a node whose every input was skipped can never run, and
      // resolving it unblocks whatever was waiting on its outgoing edges.
      const pruned = pending(state, index).filter(node => readiness(node.id, state, index, joinModes) === 'skip');
      if (pruned.length) {
        for (const node of pruned) prune(node.id, state, index, emit);
        continue;
      }

      const ready = pending(state, index).filter(node => readiness(node.id, state, index, joinModes) === 'run');
      if (!ready.length) break;

      const wave = ready.slice(0, waveLimit(ready, graph, index));
      for (const node of wave) state.nodes.set(node.id, 'running');

      const results = await Promise.all(
        wave.map(async node => {
          try {
            return { node, result: await executeNode(node, { graph, index, state, adapter, emit, onGate, cwd, env }) };
          } catch (error) {
            return { node, error };
          }
        }),
      );

      for (const entry of results) {
        if (entry.error) throw decorate(entry.error, entry.node);
        state.nodes.set(entry.node.id, 'done');
        recordOutput(entry.node, entry.result.output, state);
        emit({
          kind: 'node.done',
          node: entry.node.id,
          type: entry.node.type,
          output: entry.result.output,
          preview: preview(entry.result.output),
          invocation: entry.result.invocation ?? null,
        });
      }

      // Routing happens after the whole wave lands, so a join sees every sibling.
      for (const entry of results) {
        const routing = routeFrom(entry.node, entry.result, { graph, index, state, emit });
        if (routing.halt) {
          status = routing.halt;
          budget = 0;
          break;
        }
      }
    }
    if (budget <= 0 && status === 'completed') status = 'exhausted';
  } catch (error) {
    status = 'failed';
    failure = error;
    emit({ kind: 'run.error', node: error.nodeId ?? null, message: String(error.message ?? error) });
  }

  const finishedAt = new Date().toISOString();
  emit({ kind: 'run.end', status });

  return {
    status,
    graph: graph.id,
    harness: adapter.name,
    startedAt,
    finishedAt,
    inputs: state.scope.inputs,
    outputs: state.scope.outputs,
    steps: [...state.steps.values()],
    journal: state.journal,
    validation,
    error: failure ? String(failure.message ?? failure) : null,
  };
}

/* -------------------------------------------------------------------------- */

function createState(graph, index, control, inputs) {
  const resolved = {};
  for (const input of graph.inputs) {
    const supplied = inputs[input.id];
    resolved[input.id] = supplied === undefined || supplied === '' ? (input.default ?? '') : supplied;
  }
  // An input nobody declared is still passed through: a graph is often run by a
  // wrapper that knows more than the file does.
  for (const [key, value] of Object.entries(inputs)) if (!(key in resolved)) resolved[key] = value;

  return {
    nodes: new Map(graph.nodes.map(node => [node.id, 'pending'])),
    edges: new Map(control.map(edge => [edgeKey(edge), 'pending'])),
    iterations: new Map(),
    steps: new Map(),
    journal: [],
    scope: { inputs: resolved, outputs: {}, env: process.env, graph: { id: graph.id, name: graph.name } },
  };
}

const pending = (state, index) =>
  [...state.nodes.entries()]
    .filter(([, value]) => value === 'pending')
    .map(([id]) => index.nodes.get(id))
    .filter(Boolean);

function readiness(nodeId, state, index, joinModes) {
  const inbound = (index.incoming.get(nodeId) ?? []).filter(edge => edge.type !== 'feedback');
  const feedback = (index.incoming.get(nodeId) ?? []).filter(edge => edge.type === 'feedback');
  // A feedback token re-enters the body directly; it does not wait on the forward
  // edges, which are the reason the body ran the first time.
  if (feedback.some(edge => state.edges.get(edgeKey(edge)) === 'taken')) return 'run';
  if (!inbound.length) return 'run';

  const states = inbound.map(edge => state.edges.get(edgeKey(edge)) ?? 'pending');
  const taken = states.filter(value => value === 'taken').length;
  if (joinModes.get(nodeId) === 'any' && taken > 0) return 'run';
  if (states.includes('pending')) return 'wait';
  return taken > 0 ? 'run' : 'skip';
}

function prune(nodeId, state, index, emit) {
  state.nodes.set(nodeId, 'skipped');
  for (const edge of index.out.get(nodeId) ?? []) state.edges.set(edgeKey(edge), 'skipped');
  emit({ kind: 'node.skipped', node: nodeId });
}

// Concurrency is bounded by the tightest limit any parallel node in play declares.
function waveLimit(ready, graph, index) {
  const limits = graph.nodes.filter(node => node.type === 'parallel' && node.concurrency).map(node => node.concurrency);
  return limits.length ? Math.max(1, Math.min(...limits, ready.length)) : ready.length;
}

/*
 * A node downstream of a `join: any` parallel must not wait for its slower siblings.
 * The mode is a property of the parallel node, but the waiting happens at the merge,
 * so it is pushed down to every node the parallel can reach.
 */
function computeJoinModes(graph, index) {
  const modes = new Map();
  for (const node of graph.nodes) {
    if (node.type !== 'parallel' || node.join !== 'any') continue;
    const queue = (index.out.get(node.id) ?? []).filter(edge => edge.type !== 'feedback').map(edge => edge.to);
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      modes.set(id, 'any');
      for (const edge of index.out.get(id) ?? []) if (edge.type !== 'feedback') queue.push(edge.to);
    }
  }
  return modes;
}

/* -------------------------------------------------------------------------- */

async function executeNode(node, context) {
  const { graph, index, state, adapter, emit, onGate } = context;
  const step = { id: node.id, type: node.type, name: node.name || node.id, startedAt: new Date().toISOString() };
  emit({ kind: 'node.start', node: node.id, type: node.type, name: step.name });

  const finish = (output, extra = {}) => {
    state.steps.set(node.id, { ...step, ...extra, output, finishedAt: new Date().toISOString() });
    return { output, ...extra };
  };

  if (node.type === 'start') {
    const summary = Object.entries(state.scope.inputs)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    return finish(summary);
  }

  if (node.type === 'end') {
    const named = node.output && state.scope.outputs[node.output];
    return finish(named ?? lastOutput(state) ?? '');
  }

  if (node.type === 'agent') {
    const resolved = resolveNode(graph, node);
    const prompt = renderField(node.prompt, state, emit, node.id, 'prompt');
    const system = renderField(node.system, state, emit, node.id, 'system');
    const result = await adapter.agent({
      id: node.id,
      agent: node.id,
      name: step.name,
      model: resolved.model,
      harness: resolved.harness,
      maxTurns: resolved.maxTurns,
      tools: effectiveTools(graph, node, index),
      prompt,
      system,
    });
    return finish(result.output, { prompt, system, model: resolved.model, invocation: result.invocation });
  }

  if (node.type === 'tool') {
    const command = renderField(node.run, state, emit, node.id, 'run');
    const result = await adapter.tool({ id: node.id, name: step.name, run: command, mcp: node.mcp, continueOnError: node.continueOnError });
    return finish(result.output, { command, exitCode: result.exitCode ?? null, invocation: result.invocation });
  }

  if (node.type === 'gate') {
    const message = renderField(node.prompt || node.description, state, emit, node.id, 'prompt');
    emit({ kind: 'gate.waiting', node: node.id, name: step.name, message });
    const decision = await onGate({ id: node.id, name: step.name, message, outputs: state.scope.outputs });
    emit({ kind: 'gate.decided', node: node.id, approved: Boolean(decision?.approved), note: decision?.note ?? '' });
    return finish(decision?.note || (decision?.approved ? 'approved' : 'rejected'), { approved: Boolean(decision?.approved) });
  }

  if (node.type === 'router') {
    const value = node.expression ? (state.scope.outputs[node.expression] ?? '') : '';
    return finish(value, { routed: true });
  }

  if (node.type === 'parallel') return finish('');

  if (node.type === 'loop') {
    const key = `loop:${node.id}`;
    const count = (state.iterations.get(key) ?? 0) + 1;
    state.iterations.set(key, count);
    emit({ kind: 'loop.iteration', node: node.id, iteration: count });
    return finish(String(count), { iteration: count });
  }

  return finish('');
}

function renderField(source, state, emit, nodeId, field) {
  const { output, missing } = render(source, state.scope);
  for (const reference of missing) {
    emit({ kind: 'template.missing', node: nodeId, field, reference: reference.raw });
  }
  return output;
}

// A node's result is addressable both by its declared output name and by its id, so
// `{{plan}}` and `{{planner}}` both work without the author having to think about it.
function recordOutput(node, value, state) {
  state.scope.outputs[node.id] = value;
  if (node.output) state.scope.outputs[node.output] = value;
  state.scope.outputs.__last = value;
}

const lastOutput = state => state.scope.outputs.__last;

/* -------------------------------------------------------------------------- */

/*
 * Deciding which edges fire. Forward branches are considered in order with the
 * default last; feedback edges are considered only if no forward branch was taken,
 * which is what makes "loop back unless the reviewer approved" the natural reading
 * of a router with one conditional branch and one feedback edge.
 */
function routeFrom(node, result, { graph, index, state, emit }) {
  const forward = successors(node, index);
  const feedback = (index.out.get(node.id) ?? []).filter(edge => edge.type === 'feedback');
  const flow =
    node.type === 'gate' || node.type === 'router' ? 'branch' : node.type === 'parallel' ? 'fanout' : node.type === 'end' ? 'terminal' : 'linear';

  if (flow === 'terminal') return {};

  if (node.type === 'gate' && result.approved === false) {
    for (const edge of forward) state.edges.set(edgeKey(edge), 'skipped');
    emit({ kind: 'gate.rejected', node: node.id, onReject: node.onReject || 'stop' });
    return node.onReject === 'continue' ? {} : { halt: 'rejected' };
  }

  if (flow === 'branch') {
    const chosen = chooseBranch([...forward, ...feedback], state, emit, node);
    for (const edge of [...forward, ...feedback]) {
      state.edges.set(edgeKey(edge), edge === chosen ? 'taken' : 'skipped');
    }
    if (!chosen) {
      emit({ kind: 'route.none', node: node.id, message: 'No branch condition matched and there is no default. This path stops here.' });
      return {};
    }
    emit({ kind: 'route.taken', node: node.id, to: chosen.to, type: chosen.type, when: chosen.when ?? '' });
    return chosen.type === 'feedback' ? rewind(chosen, { graph, index, state, emit }) : {};
  }

  // Linear and fan-out both take every forward edge. A conditional feedback edge on
  // a linear node is the "retry this step" idiom and is checked separately.
  for (const edge of forward) state.edges.set(edgeKey(edge), 'taken');
  for (const edge of feedback) {
    const verdict = edge.when ? evaluateCondition(edge.when, state.scope) : { value: false };
    if (!verdict.value) {
      state.edges.set(edgeKey(edge), 'skipped');
      continue;
    }
    for (const other of forward) state.edges.set(edgeKey(other), 'skipped');
    state.edges.set(edgeKey(edge), 'taken');
    emit({ kind: 'route.taken', node: node.id, to: edge.to, type: 'feedback', when: edge.when });
    return rewind(edge, { graph, index, state, emit });
  }
  return {};
}

function chooseBranch(edges, state, emit, node) {
  const conditional = edges.filter(edge => edge.when && !edge.default);
  const fallbacks = edges.filter(edge => !edge.when);
  for (const edge of conditional) {
    const verdict = evaluateCondition(edge.when, state.scope);
    emit({ kind: 'route.test', node: node.id, to: edge.to, when: edge.when, result: verdict.value, reason: verdict.reason });
    if (verdict.value) return edge;
  }
  // An explicit default beats a bare feedback edge; a bare forward edge beats both,
  // because it is the branch the author drew as the ordinary path.
  return fallbacks.find(edge => edge.default) ?? fallbacks.find(edge => edge.type !== 'feedback') ?? fallbacks[0] ?? null;
}

/*
 * Rewind: re-arm the loop body so it can run again.
 *
 * The body is the intersection of "reachable forward from the feedback target" and
 * "can reach the feedback source" — precisely the nodes that participate in the
 * loop. Nodes outside it keep their state, which is the point: the edge that fed the
 * loop from above stays `taken`, so the body's first node is ready immediately
 * instead of waiting on a node that will never run twice.
 */
function rewind(edge, { graph, index, state, emit }) {
  const body = loopBody(edge, index);
  const guard = loopGuard(edge, graph, index, body);
  const key = `feedback:${edgeKey(edge)}`;
  const count = (state.iterations.get(key) ?? 0) + 1;
  state.iterations.set(key, count);

  if (guard.until) {
    const verdict = evaluateCondition(guard.until, state.scope);
    if (verdict.value) {
      emit({ kind: 'loop.exit', node: edge.from, reason: `condition held: ${guard.until}` });
      state.edges.set(edgeKey(edge), 'skipped');
      return {};
    }
  }
  if (count > guard.limit) {
    emit({ kind: 'loop.exhausted', node: edge.from, to: edge.to, iterations: count - 1, limit: guard.limit });
    state.edges.set(edgeKey(edge), 'skipped');
    return { halt: 'exhausted' };
  }

  for (const id of body) {
    state.nodes.set(id, 'pending');
    state.steps.delete(id);
  }
  for (const candidate of graph.edges) {
    if (candidate.type === 'uses') continue;
    if (candidate === edge) continue;
    if (body.has(candidate.from)) state.edges.set(edgeKey(candidate), 'pending');
  }
  // Anything pruned downstream may become live again on the next pass.
  for (const [id, value] of state.nodes) if (value === 'skipped') state.nodes.set(id, 'pending');
  state.edges.set(edgeKey(edge), 'taken');

  emit({ kind: 'loop.rewind', node: edge.from, to: edge.to, iteration: count, limit: guard.limit, body: [...body] });
  return {};
}

function loopBody(edge, index) {
  const forward = new Set();
  const queue = [edge.to];
  while (queue.length) {
    const id = queue.shift();
    if (forward.has(id)) continue;
    forward.add(id);
    for (const next of index.out.get(id) ?? []) if (next.type !== 'feedback') queue.push(next.to);
  }
  const backward = new Set();
  const back = [edge.from];
  while (back.length) {
    const id = back.shift();
    if (backward.has(id)) continue;
    backward.add(id);
    for (const previous of index.incoming.get(id) ?? []) if (previous.type !== 'feedback') back.push(previous.from);
  }
  const body = new Set([...forward].filter(id => backward.has(id)));
  body.add(edge.to);
  body.add(edge.from);
  return body;
}

// The cap comes from the enclosing loop node when there is one, because that is
// where the author wrote their intent. Without one, a conservative default keeps a
// runaway feedback edge from burning tokens indefinitely.
function loopGuard(edge, graph, index, body) {
  const header = graph.nodes.find(
    node => node.type === 'loop' && (body.has(node.id) || (index.out.get(node.id) ?? []).some(out => body.has(out.to))),
  );
  return {
    limit: header?.maxIterations ?? DEFAULT_FEEDBACK_LIMIT,
    until: header?.until ?? '',
  };
}

function decorate(error, node) {
  error.nodeId = node.id;
  error.message = `Step "${node.id}" failed: ${error.message}`;
  return error;
}

function preview(value) {
  const text = String(value ?? '').trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
