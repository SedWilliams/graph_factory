/*
 * COMPILE/COMMON — the parts every harness target needs.
 *
 * A compiler's job is translation, not interpretation. Each harness has its own
 * spelling for the same three things — an agent definition, a tool permission, and
 * an orchestration entry point — and the differences are almost entirely surface.
 * What is NOT surface is control flow: no harness config format can express a
 * router or a feedback loop. So every compiler emits the agents natively and then
 * emits the control flow as an ordered, explicit instruction sheet the harness's
 * top-level agent follows. That is why the compiled output always includes a
 * written plan alongside the agent files.
 */

import { NODE_TYPES } from '../graph/schema.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { effectiveTools, indexGraph, successors, topoOrder } from '../graph/topology.mjs';
import { rewrite } from '../graph/template.mjs';

export function agentNodes(graph) {
  return graph.nodes.filter(node => node.type === 'agent');
}

export function toolNodes(graph) {
  return graph.nodes.filter(node => node.type === 'tool');
}

/*
 * A static, ordered reading of the graph. Branches are not resolved — they cannot
 * be, before the run — so a branching step carries its options as data and the
 * instruction sheet tells the orchestrator to choose between them.
 */
export function executionPlan(graph) {
  const index = indexGraph(graph);
  const { order, complete } = topoOrder(graph, index);
  const steps = order
    .map(id => index.nodes.get(id))
    .filter(Boolean)
    .filter(node => node.type !== 'tool' || (index.incoming.get(node.id) ?? []).length)
    .map((node, position) => {
      const resolved = resolveNode(graph, node);
      const next = successors(node, index);
      return {
        position: position + 1,
        id: node.id,
        type: node.type,
        name: node.name || node.id,
        typeLabel: NODE_TYPES[node.type]?.label ?? node.type,
        model: node.type === 'agent' ? resolved.model : null,
        tools: node.type === 'agent' ? effectiveTools(graph, node, index) : [],
        prompt: node.prompt ?? '',
        system: node.system ?? '',
        run: node.run ?? '',
        mcp: node.mcp ?? '',
        output: node.output || node.id,
        dependsOn: (index.incoming.get(node.id) ?? []).filter(edge => edge.type !== 'feedback').map(edge => edge.from),
        next: next.map(edge => ({ to: edge.to, when: edge.when ?? '', default: Boolean(edge.default), type: edge.type })),
        feedback: (index.out.get(node.id) ?? []).filter(edge => edge.type === 'feedback').map(edge => ({ to: edge.to, label: edge.label ?? '' })),
        parallelWith: node.type === 'parallel' ? next.map(edge => edge.to) : [],
        loop: node.type === 'loop' ? { until: node.until ?? '', maxIterations: node.maxIterations ?? null } : null,
      };
    });
  return { steps, complete };
}

/*
 * The instruction sheet. Every target embeds some form of this, because it is the
 * only place the graph's control flow survives translation.
 */
export function planNarrative(graph, plan = executionPlan(graph)) {
  const lines = [];
  for (const step of plan.steps) {
    const head = `${step.position}. **${step.name}** (\`${step.id}\`, ${step.typeLabel.toLowerCase()})`;
    if (step.type === 'agent') {
      lines.push(`${head} — delegate to the \`${step.id}\` agent. It produces \`${step.output}\`.`);
    } else if (step.type === 'tool') {
      lines.push(`${head} — run \`${step.run || step.mcp}\` and capture the result as \`${step.output}\`.`);
    } else if (step.type === 'gate') {
      lines.push(`${head} — **stop and ask the user to approve.** ${step.prompt || 'Do not continue without an explicit yes.'}`);
    } else if (step.type === 'router') {
      const options = step.next.map(edge => (edge.default ? `otherwise go to \`${edge.to}\`` : `if ${edge.when} go to \`${edge.to}\``));
      lines.push(`${head} — choose one: ${options.join('; ')}.`);
    } else if (step.type === 'parallel') {
      lines.push(`${head} — run these at the same time and wait for all of them: ${step.parallelWith.map(id => `\`${id}\``).join(', ')}.`);
    } else if (step.type === 'loop') {
      const bound = [step.loop.until && `until ${step.loop.until}`, step.loop.maxIterations && `at most ${step.loop.maxIterations} times`].filter(
        Boolean,
      );
      lines.push(`${head} — repeat the steps below ${bound.join(', ') || 'until it is done'}.`);
    } else if (step.type === 'start') {
      lines.push(`${head} — the run begins here with the inputs below.`);
    } else if (step.type === 'end') {
      lines.push(`${head} — the run finishes. Report \`${step.output}\`.`);
    }
    for (const back of step.feedback) {
      lines.push(`   - If the check fails, go back to \`${back.to}\`${back.label ? ` (${back.label})` : ''} and try again.`);
    }
  }
  if (!plan.complete) lines.push('', '> This graph contains a cycle that is not marked as feedback. The order above is a best effort.');
  return lines.join('\n');
}

/*
 * A reference names a value; the reader needs the step that produces it. Without
 * this, a compiled prompt says "the output of the `work` step" when `work` is an
 * output name and `builder` is the step — which reads as a step that does not exist.
 */
export function producerLabels(graph) {
  const byName = new Map();
  for (const node of graph.nodes) {
    if (node.type === 'end') continue;
    if (node.output && !byName.has(node.output)) byName.set(node.output, node);
  }
  for (const node of graph.nodes) byName.set(node.id, node);
  return reference => {
    const node = byName.get(reference.id);
    return node ? `the \`${node.id}\` step (${node.name || node.id})` : `the \`${reference.id}\` step`;
  };
}

export function inputsSection(graph) {
  if (!graph.inputs.length) return '';
  const rows = graph.inputs.map(input => {
    const bits = [input.type || 'string'];
    if (input.required) bits.push('required');
    if (input.default !== undefined) bits.push(`default: ${input.default}`);
    return `- \`${input.id}\` (${bits.join(', ')})${input.label ? ` — ${input.label}` : ''}`;
  });
  return `## Inputs\n\n${rows.join('\n')}\n`;
}

/*
 * `{{plan}}` means nothing to a harness. Rewriting maps each reference onto whatever
 * that harness can actually substitute, and everything else becomes a plain
 * instruction to the orchestrator: "the output of step X".
 */
export function rewritePrompt(source, { inputToken = ref => `<${ref.id}>`, nodeToken = ref => `<output of ${ref.id}>` } = {}) {
  return rewrite(source, reference => {
    if (reference.kind === 'input') return inputToken(reference);
    if (reference.kind === 'node') return nodeToken(reference);
    if (reference.kind === 'env') return `$${reference.id}`;
    return undefined;
  });
}

export function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}: ${value.join(', ')}`);
      continue;
    }
    const text = String(value);
    lines.push(`${key}: ${/[:#\n]/.test(text) ? JSON.stringify(text) : text}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function agentDescription(node) {
  return (node.role || node.description || `The ${node.name || node.id} step of this pipeline`).replace(/\s+/g, ' ').trim();
}

// A compiled bundle is a plain list of files. Nothing is written until the caller
// decides where — so the editor can preview a compile without touching disk.
export function bundle(target, files, notes = []) {
  return { target, files: files.filter(file => file && file.path && file.contents !== undefined), notes };
}

export function file(path, contents) {
  return { path, contents: contents.endsWith('\n') ? contents : `${contents}\n` };
}
