/*
 * SERIALIZE — the on-disk representation.
 *
 * YAML is canonical. The three candidates were weighed against what this file has
 * to survive:
 *
 *   Markdown  reads beautifully and parses ambiguously. A graph is a set of typed
 *             edges, and there is no way to write an edge list in prose that two
 *             tools will agree on. It stays as a generated document (toMarkdown),
 *             never as the source of truth.
 *   JSON      parses unambiguously and edits badly. Every prompt in this format is
 *             multi-line, and JSON has no multi-line string — a prompt becomes one
 *             line of \n escapes that no reviewer can read in a diff. Kept as a
 *             lossless interchange format for tools.
 *   YAML      parses unambiguously, and block scalars keep prompts readable and
 *             diffable. It also happens to be what every harness already speaks,
 *             so a compiled artifact and its source look like relatives.
 *
 * Emission is deterministic: fixed key order, no folded lines, prompts always as
 * literal blocks. Two saves of the same graph produce byte-identical files, which
 * is what makes the format usable under version control.
 */

import YAML from 'yaml';
import { normalizeGraph } from './normalize.mjs';
import { NODE_TYPES } from './schema.mjs';
import { indexGraph } from './topology.mjs';

export const FILE_EXTENSION = '.agentgraph.yaml';

const GRAPH_KEYS = ['version', 'id', 'name', 'description', 'defaults', 'inputs', 'nodes', 'edges', 'layout'];
const NODE_KEYS = [
  'id',
  'type',
  'name',
  'role',
  'description',
  'model',
  'harness',
  'tools',
  'maxTurns',
  'system',
  'prompt',
  'run',
  'mcp',
  'continueOnError',
  'expression',
  'onReject',
  'until',
  'maxIterations',
  'join',
  'concurrency',
  'output',
];
const EDGE_KEYS = ['from', 'to', 'type', 'when', 'default', 'label'];
const INPUT_KEYS = ['id', 'label', 'description', 'type', 'required', 'default'];
const BLOCK_FIELDS = new Set(['prompt', 'system', 'run', 'description']);

// An empty value is not a value. Writing `description: ""` into the canonical file
// adds a line to every diff and tells a reader nothing.
function ordered(source, keys) {
  const keep = value => value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  const out = {};
  for (const key of keys) if (keep(source[key])) out[key] = source[key];
  for (const key of Object.keys(source)) if (!(key in out) && keep(source[key])) out[key] = source[key];
  return out;
}

export function toYaml(graph) {
  const normalized = normalizeGraph(graph);
  const document = new YAML.Document(
    ordered(
      {
        ...normalized,
        inputs: normalized.inputs.length ? normalized.inputs.map(input => ordered(input, INPUT_KEYS)) : undefined,
        nodes: normalized.nodes.map(node => ordered(node, NODE_KEYS)),
        edges: normalized.edges.length ? normalized.edges.map(edge => ordered(stripEdgeId(edge), EDGE_KEYS)) : undefined,
        layout: Object.keys(normalized.layout).length ? normalized.layout : undefined,
      },
      GRAPH_KEYS,
    ),
  );
  forceBlockScalars(document);
  return document.toString({ lineWidth: 0, minContentWidth: 0, indent: 2, nullStr: '' });
}

// The id is derived from the endpoints, so writing it back would be redundant and
// would churn the diff whenever an edge is reordered.
function stripEdgeId(edge) {
  const { id, ...rest } = edge;
  return rest;
}

// A prompt written as a quoted string with \n escapes is unreviewable. Walk the
// document and force every prose field onto a literal block.
function forceBlockScalars(document) {
  YAML.visit(document, {
    Pair(_, pair) {
      const key = String(pair.key?.value ?? '');
      if (!BLOCK_FIELDS.has(key)) return;
      const value = pair.value;
      if (!value || typeof value.value !== 'string' || !value.value.includes('\n')) return;
      value.type = 'BLOCK_LITERAL';
    },
  });
}

export function fromYaml(source) {
  const parsed = YAML.parse(String(source ?? ''), { prettyErrors: true });
  return normalizeGraph(parsed ?? {});
}

export function toJson(graph) {
  return `${JSON.stringify(normalizeGraph(graph), null, 2)}\n`;
}

export function fromJson(source) {
  return normalizeGraph(JSON.parse(String(source ?? '{}')));
}

// Accepts either format so a developer can hand the app whichever file they have.
export function parseGraphFile(source, filename = '') {
  const raw = String(source ?? '').trim();
  if (filename.endsWith('.json') || raw.startsWith('{')) return fromJson(raw || '{}');
  return fromYaml(raw);
}

/*
 * A generated companion document. Not parsed back — this is what you commit next
 * to the YAML so a reviewer can see the pipeline without opening the editor, and
 * what an agent reads when it needs the system described in prose.
 */
export function toMarkdown(graph) {
  const normalized = normalizeGraph(graph);
  const index = indexGraph(normalized);
  const lines = [`# ${normalized.name}`, ''];
  if (normalized.description) lines.push(normalized.description, '');

  lines.push(
    `- **Graph id:** \`${normalized.id}\``,
    `- **Default model:** \`${normalized.defaults.model}\``,
    `- **Default harness:** \`${normalized.defaults.harness}\``,
    `- **Nodes:** ${normalized.nodes.length} · **Edges:** ${normalized.edges.length}`,
    '',
  );

  if (normalized.inputs.length) {
    lines.push('## Inputs', '');
    for (const input of normalized.inputs) {
      const bits = [`\`${input.id}\``, input.type ?? 'string'];
      if (input.required) bits.push('required');
      if (input.default !== undefined) bits.push(`default \`${input.default}\``);
      lines.push(`- ${bits.join(' · ')}${input.label || input.description ? ` — ${input.label || input.description}` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Flow', '', '```mermaid', 'flowchart TD');
  for (const node of normalized.nodes) {
    lines.push(`  ${node.id}${mermaidShape(node)}`);
  }
  for (const edge of normalized.edges) {
    const label = edge.when || edge.label || (edge.default ? 'default' : '');
    const arrow = edge.type === 'uses' ? '-.->' : edge.type === 'feedback' ? '-. retry .->' : '-->';
    lines.push(`  ${edge.from} ${label && arrow === '-->' ? `-- ${escapeLabel(label)} -->` : arrow} ${edge.to}`);
  }
  lines.push('```', '');

  lines.push('## Nodes', '');
  for (const node of normalized.nodes) {
    lines.push(`### ${node.name} \`${node.id}\``, '', `*${NODE_TYPES[node.type]?.label ?? node.type}*${node.role ? ` — ${node.role}` : ''}`, '');
    if (node.description) lines.push(node.description, '');
    if (node.model) lines.push(`- Model: \`${node.model}\``);
    const tools = (index.uses.get(node.id) ?? []).map(edge => edge.to);
    if (node.tools?.length) lines.push(`- Tools: ${node.tools.map(tool => `\`${tool}\``).join(', ')}`);
    if (tools.length) lines.push(`- Tool nodes: ${tools.map(tool => `\`${tool}\``).join(', ')}`);
    if (node.output) lines.push(`- Produces: \`${node.output}\``);
    if (node.run) lines.push('', '```bash', node.run, '```');
    if (node.prompt) lines.push('', '**Prompt**', '', '```text', node.prompt, '```');
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function mermaidShape(node) {
  const label = escapeLabel(node.name || node.id);
  if (node.type === 'router' || node.type === 'gate') return `{"${label}"}`;
  if (node.type === 'start' || node.type === 'end') return `(["${label}"])`;
  if (node.type === 'tool') return `[/"${label}"/]`;
  if (node.type === 'parallel') return `[["${label}"]]`;
  return `["${label}"]`;
}

function escapeLabel(value) {
  return String(value).replace(/["\n]/g, ' ').trim();
}
