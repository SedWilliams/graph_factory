/*
 * NORMALIZE — turn anything graph-shaped into the canonical object.
 *
 * Two callers need this and they are very different. The editor sends well-formed
 * JSON that only needs defaults filled in. A hand-edited YAML file sends whatever
 * the developer typed: a scalar where a list belongs, `from`/`to` instead of
 * `source`/`target`, a tool list written as a comma-separated string.
 *
 * So normalisation coerces rather than rejects. Anything genuinely wrong survives
 * as a value the validator can then complain about with a useful message — the
 * alternative is a parse error that points at a line number and explains nothing.
 */

import { DEFAULT_MODEL, EDGE_TYPES, HARNESSES, NODE_TYPES, SCHEMA_VERSION } from './schema.mjs';

const text = (value, max = 4000) => (value === null || value === undefined ? '' : String(value)).slice(0, max);
const trimmed = (value, max = 4000) => text(value, max).trim();

// Underscores survive: identifiers here are also output names, and `test_output`
// silently becoming `test-output` breaks every `{{test_output}}` that referred to it.
export function slugify(value, fallback = 'node') {
  const slug = trimmed(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 63);
  return slug && /^[a-z0-9]/.test(slug) ? slug : fallback;
}

// Tools arrive as a list, as "read, grep, glob", or as "read grep glob" depending
// on which harness's config the developer copied from.
export function toList(value) {
  if (Array.isArray(value)) return value.map(entry => trimmed(entry, 120)).filter(Boolean);
  const raw = trimmed(value, 2000);
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .flatMap(part => part.split(/\s+/))
    .map(part => part.trim())
    .filter(Boolean);
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const raw = trimmed(value).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(raw)) return true;
  if (['false', 'no', 'off', '0'].includes(raw)) return false;
  return fallback;
}

// Only keys with a value are kept, so a round trip through YAML does not sprout a
// field the author never wrote.
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function normalizeInput(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : { id: raw };
  const id = slugify(source.id ?? source.name ?? `input-${index + 1}`, `input-${index + 1}`);
  return compact({
    id,
    label: trimmed(source.label ?? source.title, 160),
    description: trimmed(source.description, 2000),
    type: trimmed(source.type, 40) || 'string',
    required: source.required === undefined ? undefined : toBool(source.required),
    default: source.default === undefined ? undefined : source.default,
  });
}

function normalizeNode(raw, index, seen) {
  const source = raw && typeof raw === 'object' ? raw : { id: raw };
  const type = NODE_TYPES[trimmed(source.type, 40)] ? trimmed(source.type, 40) : 'agent';
  let id = slugify(source.id ?? source.name ?? `${type}-${index + 1}`, `${type}-${index + 1}`);
  // Duplicate ids are recoverable: suffix them and let the validator report the fix.
  if (seen.has(id)) {
    let n = 2;
    while (seen.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  seen.add(id);

  const node = {
    id,
    type,
    name: trimmed(source.name ?? source.label, 160) || defaultName(type, index),
    role: trimmed(source.role, 300),
    description: trimmed(source.description, 2000),
    model: trimmed(source.model, 120),
    prompt: text(source.prompt ?? source.instructions, 20000).replace(/\r\n/g, '\n'),
    system: text(source.system ?? source.systemPrompt, 20000).replace(/\r\n/g, '\n'),
    tools: toList(source.tools),
    output: slugify(source.output ?? source.outputs, '') || '',
    harness: HARNESSES[trimmed(source.harness, 40)] ? trimmed(source.harness, 40) : '',
    maxTurns: toNumber(source.maxTurns, null),
    run: text(source.run ?? source.command, 4000).trim(),
    mcp: trimmed(source.mcp, 200),
    continueOnError: source.continueOnError === undefined ? undefined : toBool(source.continueOnError),
    expression: trimmed(source.expression, 1000),
    onReject: trimmed(source.onReject, 120),
    until: trimmed(source.until, 1000),
    maxIterations: toNumber(source.maxIterations, null),
    join: trimmed(source.join, 40),
    concurrency: toNumber(source.concurrency, null),
  };
  // Only the fields the type actually declares survive, so switching a node from
  // agent to tool in the editor does not leave a stale prompt in the file.
  const allowed = new Set(['name', ...(NODE_TYPES[type]?.fields ?? [])]);
  for (const key of Object.keys(node)) {
    if (key === 'id' || key === 'type') continue;
    if (!allowed.has(key)) delete node[key];
  }
  return compact(node);
}

function defaultName(type, index) {
  return `${NODE_TYPES[type]?.label ?? 'Node'} ${index + 1}`;
}

function normalizeEdge(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const from = slugify(source.from ?? source.source, '');
  const to = slugify(source.to ?? source.target, '');
  const declared = trimmed(source.type ?? source.kind, 40);
  const hasCondition = Boolean(trimmed(source.when ?? source.condition, 1000));
  // An edge with a condition is a branch whether or not it says so.
  const type = EDGE_TYPES[declared] ? declared : hasCondition ? 'branch' : 'flow';
  return compact({
    id: trimmed(source.id, 120) || `${from || '?'}->${to || '?'}#${index + 1}`,
    from,
    to,
    type,
    when: trimmed(source.when ?? source.condition, 1000),
    default: source.default === undefined ? undefined : toBool(source.default),
    label: trimmed(source.label, 160),
  });
}

// Pinned canvas positions. Stored per node id so a saved graph reopens identically
// instead of re-simulating into a different shape every time.
function normalizeLayout(raw, nodeIds) {
  const layout = {};
  if (!raw || typeof raw !== 'object') return layout;
  for (const [key, value] of Object.entries(raw)) {
    const id = slugify(key, '');
    if (!id || !nodeIds.has(id) || !value || typeof value !== 'object') continue;
    const x = toNumber(value.x);
    const y = toNumber(value.y);
    if (x === null || y === null) continue;
    layout[id] = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }
  return layout;
}

export function normalizeGraph(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).map((node, index) => normalizeNode(node, index, seen));
  const nodeIds = new Set(nodes.map(node => node.id));
  const defaults = source.defaults && typeof source.defaults === 'object' ? source.defaults : {};

  return {
    version: toNumber(source.version, SCHEMA_VERSION) || SCHEMA_VERSION,
    id: slugify(source.id ?? source.name, 'untitled-graph'),
    name: trimmed(source.name, 160) || 'Untitled graph',
    description: trimmed(source.description, 4000),
    defaults: compact({
      model: trimmed(defaults.model, 120) || DEFAULT_MODEL,
      harness: HARNESSES[trimmed(defaults.harness, 40)] ? trimmed(defaults.harness, 40) : 'claude',
      maxTurns: toNumber(defaults.maxTurns, 30),
      tools: toList(defaults.tools),
    }),
    inputs: (Array.isArray(source.inputs) ? source.inputs : []).map(normalizeInput),
    nodes,
    edges: (Array.isArray(source.edges) ? source.edges : [])
      .map(normalizeEdge)
      .filter(edge => edge.from && edge.to)
      // A duplicate of an identical edge is noise, not a second path.
      .filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to && other.type === edge.type) === index),
    layout: normalizeLayout(source.layout, nodeIds),
  };
}

// Model, harness, tools and turn budget each fall back to the graph defaults, so a
// node only has to say what makes it different.
export function resolveNode(graph, node) {
  return {
    ...node,
    model: node.model || graph.defaults?.model || DEFAULT_MODEL,
    harness: node.harness || graph.defaults?.harness || 'claude',
    maxTurns: node.maxTurns ?? graph.defaults?.maxTurns ?? 30,
    tools: node.tools?.length ? node.tools : (graph.defaults?.tools ?? []),
  };
}
