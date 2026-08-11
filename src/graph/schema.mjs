/*
 * SCHEMA — the agent-graph contract.
 *
 * One file describes one agentic coding system. Everything downstream reads the
 * catalogs below: the editor builds its palette from NODE_TYPES, the validator
 * derives its rules from them, and every harness compiler maps them onto the
 * shape its own runtime expects.
 *
 * The canonical serialisation is YAML (see serialize.mjs for why). This module
 * only describes the in-memory object; it never touches disk.
 */

export const SCHEMA_VERSION = 1;

// A node id has to survive being a filename, a YAML key, a shell argument, and a
// harness agent name, so the intersection of those is what we allow.
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/*
 * NODE TYPES
 *
 * `fields` drives the inspector form in the editor and the normaliser's coercion.
 * `flow` says how control passes through the node:
 *   - 'linear'   one outgoing flow edge is followed
 *   - 'branch'   outgoing edges carry `when` conditions; one wins
 *   - 'fanout'   every outgoing edge runs, then results join
 *   - 'terminal' nothing downstream
 *   - 'none'     not part of control flow at all (tools hang off agents)
 */
export const NODE_TYPES = {
  start: {
    label: 'Start',
    hint: 'Entry point. Binds the graph inputs into the first prompt.',
    flow: 'linear',
    accent: 'start',
    maxPerGraph: null,
    fields: ['name', 'description'],
  },
  agent: {
    label: 'Agent',
    hint: 'An LLM turn: a role, a system prompt, a model, and an allow-list of tools.',
    flow: 'linear',
    accent: 'agent',
    fields: ['name', 'role', 'description', 'model', 'prompt', 'system', 'tools', 'output', 'maxTurns', 'harness'],
  },
  tool: {
    label: 'Tool',
    hint: 'A deterministic step: a shell command or an MCP tool. No model call.',
    flow: 'linear',
    accent: 'tool',
    fields: ['name', 'description', 'run', 'mcp', 'output', 'continueOnError'],
  },
  gate: {
    label: 'Gate',
    hint: 'A human checkpoint. Execution pauses until someone approves or rejects.',
    flow: 'branch',
    accent: 'gate',
    fields: ['name', 'description', 'prompt', 'onReject'],
  },
  router: {
    label: 'Router',
    hint: 'Picks one outgoing branch by evaluating each edge condition in order.',
    flow: 'branch',
    accent: 'router',
    fields: ['name', 'description', 'expression'],
  },
  parallel: {
    label: 'Parallel',
    hint: 'Runs every outgoing branch at once and joins their outputs before continuing.',
    flow: 'fanout',
    accent: 'parallel',
    fields: ['name', 'description', 'join', 'concurrency'],
  },
  loop: {
    label: 'Loop',
    hint: 'Repeats its downstream body until the condition holds or the cap is hit.',
    flow: 'linear',
    accent: 'loop',
    fields: ['name', 'description', 'until', 'maxIterations'],
  },
  end: {
    label: 'End',
    hint: 'Terminal node. Names what the run produces.',
    flow: 'terminal',
    accent: 'end',
    fields: ['name', 'description', 'output'],
  },
};

/*
 * EDGE TYPES
 *
 * `control` marks edges that carry execution. `uses` does not: it binds a tool to
 * the agent allowed to call it, which compilers turn into a tool allow-list rather
 * than a step. `feedback` is the only edge permitted to close a cycle.
 */
export const EDGE_TYPES = {
  flow: { label: 'Flow', hint: 'Run the target after the source.', control: true, mayCycle: false },
  branch: { label: 'Branch', hint: 'Run the target only when the condition holds.', control: true, mayCycle: false, condition: true },
  handoff: { label: 'Handoff', hint: 'Delegate to another agent, carrying the conversation context.', control: true, mayCycle: false },
  feedback: { label: 'Feedback', hint: 'Loop back to an earlier node. The only edge allowed to form a cycle.', control: true, mayCycle: true },
  uses: { label: 'Uses', hint: 'Bind a tool to an agent. Not a step — it becomes a tool permission.', control: false, mayCycle: true },
};

// Harnesses the compilers and the executor know how to target.
export const HARNESSES = {
  claude: { label: 'Claude Code', agentDir: '.claude/agents', command: 'claude' },
  pi: { label: 'Pi', agentDir: '.pi/agent/agents', command: 'pi' },
  opencode: { label: 'opencode', agentDir: '.opencode/agent', command: 'opencode' },
  codex: { label: 'Codex', agentDir: '.codex', command: 'codex' },
  portable: { label: 'Portable bundle', agentDir: 'agents', command: null },
};

// Tool names shared across harnesses. Compilers translate to each harness's spelling.
export const CANONICAL_TOOLS = ['read', 'write', 'edit', 'grep', 'glob', 'bash', 'web_search', 'web_fetch', 'todo'];

export const DEFAULT_MODEL = 'claude-opus-5';

export function nodeTypeNames() {
  return Object.keys(NODE_TYPES);
}

export function edgeTypeNames() {
  return Object.keys(EDGE_TYPES);
}

export function isControlEdge(type) {
  return EDGE_TYPES[type]?.control === true;
}

export function nodeFlow(type) {
  return NODE_TYPES[type]?.flow ?? 'linear';
}

// An empty graph still has to be a valid graph, or the editor has nothing to open.
export function emptyGraph(overrides = {}) {
  return {
    version: SCHEMA_VERSION,
    id: 'untitled-graph',
    name: 'Untitled graph',
    description: '',
    defaults: { model: DEFAULT_MODEL, harness: 'claude', maxTurns: 30 },
    inputs: [],
    nodes: [],
    edges: [],
    layout: {},
    ...overrides,
  };
}
