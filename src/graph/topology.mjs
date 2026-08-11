/*
 * TOPOLOGY — the graph read as a program rather than as a picture.
 *
 * Control flow and tool binding are two different graphs drawn on the same nodes,
 * so every query here says which one it means. `uses` edges bind a tool to an
 * agent and are deliberately invisible to ordering and reachability; `feedback`
 * edges carry control but are cut before ordering, because a loop back to an
 * earlier node is a cycle on purpose and must not block a topological sort.
 */

import { isControlEdge, nodeFlow } from './schema.mjs';

export function indexGraph(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const out = new Map(graph.nodes.map(node => [node.id, []]));
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  const uses = new Map(graph.nodes.map(node => [node.id, []]));
  const usedBy = new Map(graph.nodes.map(node => [node.id, []]));
  const dangling = [];

  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      dangling.push(edge);
      continue;
    }
    if (edge.type === 'uses') {
      uses.get(edge.from).push(edge);
      usedBy.get(edge.to).push(edge);
      continue;
    }
    out.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  return { nodes, out, incoming, uses, usedBy, dangling };
}

export function controlEdges(graph) {
  return graph.edges.filter(edge => isControlEdge(edge.type));
}

// Entry points: an explicit `start`, or — for a graph the author never gave one —
// any control node nothing else leads into.
export function entryNodes(graph, index = indexGraph(graph)) {
  const starts = graph.nodes.filter(node => node.type === 'start');
  if (starts.length) return starts;
  return graph.nodes.filter(node => {
    const inbound = index.incoming.get(node.id) ?? [];
    return inbound.every(edge => edge.type === 'feedback') && (index.out.get(node.id) ?? []).length > 0;
  });
}

export function reachable(graph, index = indexGraph(graph)) {
  const seen = new Set();
  const queue = entryNodes(graph, index).map(node => node.id);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of index.out.get(id) ?? []) queue.push(edge.to);
  }
  return seen;
}

/*
 * Cycle detection over control edges. Two answers are wanted at once:
 * every cycle found, and whether each one is legal — a cycle that passes through a
 * `feedback` edge is the author's retry loop, anything else is a mistake.
 */
export function findCycles(graph, index = indexGraph(graph)) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  const walk = id => {
    state.set(id, 'open');
    stack.push(id);
    for (const edge of index.out.get(id) ?? []) {
      const next = edge.to;
      if (state.get(next) === 'open') {
        const at = stack.indexOf(next);
        const path = stack.slice(at).concat(next);
        cycles.push({ path, viaFeedback: cyclePassesFeedback(path, index) });
      } else if (!state.has(next)) {
        walk(next);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const node of graph.nodes) if (!state.has(node.id)) walk(node.id);
  return cycles;
}

function cyclePassesFeedback(path, index) {
  for (let i = 0; i < path.length - 1; i++) {
    const hop = (index.out.get(path[i]) ?? []).filter(edge => edge.to === path[i + 1]);
    if (hop.some(edge => edge.type === 'feedback')) return true;
  }
  return false;
}

/*
 * Execution order. Feedback edges are cut first so the remaining graph is a DAG;
 * the executor re-introduces them at runtime as jumps. Ties break on the author's
 * own node order, which keeps compiled output stable across saves.
 */
export function topoOrder(graph, index = indexGraph(graph)) {
  const position = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const degree = new Map(graph.nodes.map(node => [node.id, 0]));
  const forward = new Map(graph.nodes.map(node => [node.id, []]));

  for (const [id, edges] of index.out) {
    for (const edge of edges) {
      if (edge.type === 'feedback') continue;
      forward.get(id).push(edge.to);
      degree.set(edge.to, degree.get(edge.to) + 1);
    }
  }

  const ready = graph.nodes.filter(node => degree.get(node.id) === 0).map(node => node.id);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => position.get(a) - position.get(b));
    const id = ready.shift();
    order.push(id);
    for (const next of forward.get(id) ?? []) {
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 0) ready.push(next);
    }
  }
  // Anything still held back sits inside an illegal cycle. Append it so callers
  // always get every node, and let the validator be the one to object.
  const placed = new Set(order);
  for (const node of graph.nodes) if (!placed.has(node.id)) order.push(node.id);
  return { order, complete: placed.size === graph.nodes.length };
}

// Depth from the entry points, used by the editor to lay a fresh graph out in
// readable ranks instead of dropping every node into the force simulation.
export function rankNodes(graph, index = indexGraph(graph)) {
  const rank = new Map();
  const entries = entryNodes(graph, index);
  const queue = entries.map(node => [node.id, 0]);
  for (const node of entries) rank.set(node.id, 0);
  while (queue.length) {
    const [id, depth] = queue.shift();
    for (const edge of index.out.get(id) ?? []) {
      if (edge.type === 'feedback') continue;
      const next = rank.get(edge.to);
      if (next === undefined || next < depth + 1) {
        rank.set(edge.to, depth + 1);
        queue.push([edge.to, depth + 1]);
      }
    }
  }
  let floor = 0;
  for (const value of rank.values()) floor = Math.max(floor, value);
  // Tool nodes have no control edges, so they rank beside the agent that uses them.
  for (const node of graph.nodes) {
    if (rank.has(node.id)) continue;
    const owner = (index.usedBy.get(node.id) ?? [])[0];
    rank.set(node.id, owner && rank.has(owner.from) ? rank.get(owner.from) : floor + 1);
  }
  return rank;
}

// The successors control actually passes to, in the order the runtime should
// consider them. A branch node's default edge always sorts last.
export function successors(node, index) {
  const edges = (index.out.get(node.id) ?? []).filter(edge => edge.type !== 'feedback');
  if (nodeFlow(node.type) !== 'branch') return edges;
  return [...edges].sort((a, b) => Number(Boolean(a.default)) - Number(Boolean(b.default)));
}

export function feedbackTargets(node, index) {
  return (index.out.get(node.id) ?? []).filter(edge => edge.type === 'feedback');
}

/*
 * An agent's effective tool allow-list: what it declares, plus a permission for
 * every tool node wired to it. A shell tool node grants `bash`; an MCP tool node
 * grants that specific MCP tool.
 */
export function effectiveTools(graph, node, index = indexGraph(graph)) {
  const tools = new Set(node.tools?.length ? node.tools : (graph.defaults?.tools ?? []));
  for (const edge of index.uses.get(node.id) ?? []) {
    const target = index.nodes.get(edge.to);
    if (!target || target.type !== 'tool') continue;
    if (target.mcp) tools.add(target.mcp);
    else if (target.run) tools.add('bash');
  }
  return [...tools];
}
