/*
 * VALIDATE — can this graph be executed, and will it do what it looks like it does?
 *
 * Two severities, and the split matters. An **error** means no harness can be
 * handed this graph: a step with no instructions, a prompt referring to a value
 * nothing produces, a cycle with no way out. A **warning** means it will run, but
 * the picture and the program disagree — an unreachable branch, a tool nobody
 * calls, a router whose conditions can all be false.
 *
 * Compilation refuses on errors and proceeds on warnings, because the second kind
 * is often a graph mid-edit rather than a graph that is wrong.
 */

import { EDGE_TYPES, HARNESSES, ID_PATTERN, NODE_TYPES, nodeFlow } from './schema.mjs';
import { effectiveTools, entryNodes, findCycles, indexGraph, reachable, successors } from './topology.mjs';
import { nodeReferences } from './template.mjs';

const problem = (severity, code, message, where = {}) => ({ severity, code, message, ...where });

export function validateGraph(graph) {
  const issues = [];
  const index = indexGraph(graph);
  const error = (code, message, where) => issues.push(problem('error', code, message, where));
  const warn = (code, message, where) => issues.push(problem('warning', code, message, where));

  checkIdentity(graph, error, warn);
  checkInputs(graph, error, warn);
  checkNodes(graph, index, error, warn);
  checkEdges(graph, index, error, warn);
  checkFlow(graph, index, error, warn);
  checkReferences(graph, error);

  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    errors: issues.filter(issue => issue.severity === 'error'),
    warnings: issues.filter(issue => issue.severity === 'warning'),
    issues,
  };
}

function checkIdentity(graph, error, warn) {
  if (!ID_PATTERN.test(graph.id ?? '')) {
    error('graph.id', `Graph id "${graph.id}" must be lowercase letters, digits, dashes or underscores.`);
  }
  if (!graph.name?.trim()) warn('graph.name', 'The graph has no name. Compiled files will be titled "Untitled graph".');
  if (graph.defaults?.harness && !HARNESSES[graph.defaults.harness]) {
    error('graph.harness', `Unknown default harness "${graph.defaults.harness}".`);
  }
  if (!graph.nodes.length) error('graph.empty', 'The graph has no nodes, so there is nothing to run.');
}

function checkInputs(graph, error, warn) {
  const seen = new Set();
  for (const input of graph.inputs) {
    if (!ID_PATTERN.test(input.id)) error('input.id', `Input id "${input.id}" is not a valid identifier.`, { input: input.id });
    if (seen.has(input.id)) error('input.duplicate', `Two inputs share the id "${input.id}".`, { input: input.id });
    seen.add(input.id);
    if (input.required && input.default !== undefined) {
      warn('input.required', `Input "${input.id}" is required but also has a default, so it can never be missing.`, { input: input.id });
    }
  }
}

function checkNodes(graph, index, error, warn) {
  const seen = new Set();
  for (const node of graph.nodes) {
    const where = { node: node.id };
    if (!ID_PATTERN.test(node.id)) error('node.id', `Node id "${node.id}" is not a valid identifier.`, where);
    if (seen.has(node.id)) error('node.duplicate', `Two nodes share the id "${node.id}".`, where);
    seen.add(node.id);
    if (!NODE_TYPES[node.type]) {
      error('node.type', `Node "${node.id}" has unknown type "${node.type}".`, where);
      continue;
    }
    checkNodeBody(graph, index, node, where, error, warn);
  }
  // Two producers claiming one output name is not an error — the later one simply
  // overwrites — but it is almost never what the author meant.
  const outputs = new Map();
  for (const node of graph.nodes) {
    if (!node.output || node.type === 'end') continue;
    if (outputs.has(node.output)) {
      warn('node.output', `"${node.id}" and "${outputs.get(node.output)}" both produce \`${node.output}\`. Whichever runs last wins.`, {
        node: node.id,
      });
    }
    outputs.set(node.output, node.id);
  }
  const starts = graph.nodes.filter(node => node.type === 'start');
  if (starts.length > 1) warn('graph.starts', `${starts.length} start nodes: every one of them begins its own branch.`);
  if (!entryNodes(graph, index).length && graph.nodes.length) {
    error('graph.entry', 'No entry point: every node has something leading into it, so a run has nowhere to begin.');
  }
}

function checkNodeBody(graph, index, node, where, error, warn) {
  if (node.type === 'agent') {
    if (!node.prompt?.trim()) error('agent.prompt', `Agent "${node.id}" has no prompt, so there is nothing to send the model.`, where);
    if (!effectiveTools(graph, node, index).length) {
      warn('agent.tools', `Agent "${node.id}" has no tools, so it can only produce text.`, where);
    }
  }
  if (node.type === 'tool') {
    if (!node.run?.trim() && !node.mcp?.trim()) {
      error('tool.action', `Tool "${node.id}" needs either a command to run or an MCP tool to call.`, where);
    }
    if (node.run?.trim() && node.mcp?.trim()) {
      warn('tool.action', `Tool "${node.id}" declares both a command and an MCP tool; the command wins.`, where);
    }
    if (!(index.usedBy.get(node.id) ?? []).length && !(index.incoming.get(node.id) ?? []).length) {
      warn('tool.orphan', `Tool "${node.id}" is not wired to anything, so it will never run.`, where);
    }
  }
  if (node.type === 'loop') {
    if (!node.until?.trim() && !node.maxIterations) {
      error('loop.bound', `Loop "${node.id}" has neither an exit condition nor an iteration cap, so it cannot terminate.`, where);
    }
    if (!node.maxIterations) warn('loop.cap', `Loop "${node.id}" has no iteration cap. A condition that never holds will run forever.`, where);
  }
  if (node.type === 'gate' && !node.prompt?.trim() && !node.description?.trim()) {
    warn('gate.prompt', `Gate "${node.id}" gives the reviewer nothing to read before approving.`, where);
  }
}

function checkEdges(graph, index, error, warn) {
  for (const edge of index.dangling) {
    const missing = index.nodes.has(edge.from) ? edge.to : edge.from;
    error('edge.dangling', `Edge ${edge.from} → ${edge.to} points at "${missing}", which is not a node in this graph.`, { edge: edge.id });
  }
  for (const edge of graph.edges) {
    const where = { edge: edge.id };
    if (!EDGE_TYPES[edge.type]) error('edge.type', `Edge ${edge.from} → ${edge.to} has unknown type "${edge.type}".`, where);
    if (edge.from === edge.to && edge.type !== 'feedback') {
      error('edge.self', `Node "${edge.from}" links to itself. Use a feedback edge if that loop is deliberate.`, where);
    }
    if (edge.type === 'uses') {
      const from = index.nodes.get(edge.from);
      const to = index.nodes.get(edge.to);
      if (from && from.type !== 'agent') error('edge.uses', `Only agents can use tools, but "${edge.from}" is a ${from.type}.`, where);
      if (to && to.type !== 'tool') error('edge.uses', `A "uses" edge must point at a tool, but "${edge.to}" is a ${to.type}.`, where);
    }
    if (edge.type === 'branch' && !edge.when?.trim() && !edge.default) {
      error('edge.when', `Branch ${edge.from} → ${edge.to} has no condition and is not the default, so it can never be taken.`, where);
    }
  }
}

function checkFlow(graph, index, error, warn) {
  for (const cycle of findCycles(graph, index)) {
    if (cycle.viaFeedback) continue;
    error('flow.cycle', `Cycle with no way out: ${cycle.path.join(' → ')}. Mark the closing edge as feedback to make it a loop.`, {
      node: cycle.path[0],
    });
  }

  const live = reachable(graph, index);
  for (const node of graph.nodes) {
    if (live.has(node.id) || node.type === 'tool') continue;
    warn('flow.unreachable', `Nothing leads to "${node.id}", so it will never run.`, { node: node.id });
  }

  for (const node of graph.nodes) {
    const where = { node: node.id };
    const next = successors(node, index);
    const flow = nodeFlow(node.type);

    if (flow === 'terminal' && next.length) {
      warn('flow.terminal', `"${node.id}" is an end node but still has ${next.length} outgoing edge(s), which will be ignored.`, where);
    }
    if (flow === 'linear' && next.length > 1) {
      warn('flow.linear', `"${node.id}" has ${next.length} outgoing edges. Use a parallel node to run them all, or a router to choose.`, where);
    }
    if (flow === 'linear' && !next.length && node.type !== 'end' && live.has(node.id)) {
      warn('flow.dead-end', `"${node.id}" has nothing after it. The run stops there.`, where);
    }
    if (flow === 'branch') {
      if (!next.length) {
        error('flow.branch', `${NODE_TYPES[node.type].label} "${node.id}" has no outgoing branches.`, where);
      } else if (node.type === 'router') {
        const defaults = next.filter(edge => edge.default);
        if (defaults.length > 1)
          error('flow.default', `Router "${node.id}" has ${defaults.length} default branches. At most one may be the default.`, where);
        // An unconditional feedback edge is a fallback too — "loop back unless one of
        // these conditions held" is the whole point of a review router.
        const fallback = (index.out.get(node.id) ?? []).some(edge => edge.type === 'feedback' && !edge.when);
        if (!defaults.length && !fallback) {
          warn('flow.default', `Router "${node.id}" has no default branch, so the run stops if every condition is false.`, where);
        }
      }
    }
    if (flow === 'fanout' && next.length < 2) {
      warn('flow.parallel', `Parallel node "${node.id}" has ${next.length} branch(es). It needs at least two to be worth the join.`, where);
    }
  }
}

// Every {{reference}} must name something the graph actually produces, and it must
// be produced upstream — a prompt reading a value that is written later is the
// failure mode that looks fine on the canvas and returns an empty string at run time.
function checkReferences(graph, error) {
  const inputs = new Set(graph.inputs.map(input => input.id));
  const produced = producerMap(graph);
  const index = indexGraph(graph);
  const before = ancestorSets(graph, index);

  for (const node of graph.nodes) {
    for (const reference of nodeReferences(node)) {
      const where = { node: node.id, field: reference.field };
      if (reference.kind === 'input') {
        if (!inputs.has(reference.id)) error('ref.input', `"${node.id}" reads {{inputs.${reference.id}}}, but no such input is declared.`, where);
        continue;
      }
      if (reference.kind === 'node') {
        const producer = produced.get(reference.id);
        if (!producer) {
          error('ref.node', `"${node.id}" reads {{${reference.id}}}, but no node produces that value.`, where);
        } else if (producer !== node.id && !before.get(node.id)?.has(producer)) {
          error('ref.order', `"${node.id}" reads {{${reference.id}}}, which is produced by "${producer}" — a node that does not run first.`, where);
        }
        continue;
      }
      if (reference.kind === 'unknown') {
        error('ref.syntax', `"${node.id}" contains {{${reference.raw}}}, which is not a recognised reference.`, where);
      }
    }
  }
}

/*
 * Which node produces which name. A node is reachable as both its id and its
 * declared output, and the id always wins — it is unique by construction, whereas
 * two nodes can name the same output.
 *
 * An `end` node is deliberately not a producer: its `output` says which existing
 * value the run should report, so treating it as one would make every reference to
 * that value appear to come from the last node in the graph.
 */
function producerMap(graph) {
  const produced = new Map();
  for (const node of graph.nodes) {
    if (node.type === 'end') continue;
    if (node.output && !produced.has(node.output)) produced.set(node.output, node.id);
  }
  for (const node of graph.nodes) produced.set(node.id, node.id);
  return produced;
}

// Feedback edges count as ancestry: on the second pass through a loop the earlier
// node has run, and referring back to it is exactly what a retry prompt does.
function ancestorSets(graph, index) {
  const ancestors = new Map(graph.nodes.map(node => [node.id, new Set()]));
  let changed = true;
  let guard = graph.nodes.length + 2;
  while (changed && guard-- > 0) {
    changed = false;
    for (const node of graph.nodes) {
      const set = ancestors.get(node.id);
      const before = set.size;
      for (const edge of index.incoming.get(node.id) ?? []) {
        set.add(edge.from);
        for (const id of ancestors.get(edge.from) ?? []) set.add(id);
      }
      if (set.size !== before) changed = true;
    }
  }
  return ancestors;
}

export function formatIssues(result) {
  return result.issues.map(issue => `${issue.severity === 'error' ? 'ERROR' : 'warn '}  [${issue.code}] ${issue.message}`).join('\n');
}
