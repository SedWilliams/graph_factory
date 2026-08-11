/*
 * TARGET: Codex.
 *
 * Codex has no subagent registry: there is one agent, configured by profiles in
 * `config.toml` and instructed by `AGENTS.md`. So the graph compiles differently
 * here than anywhere else — the agent nodes become *roles the single agent adopts
 * in sequence* rather than separate agents, and each one's brief lives in its own
 * prompt file that the run step points at.
 *
 * This is the least faithful of the four targets and the compiler says so in its
 * notes, because a graph that relies on genuine parallelism will be serialised.
 */

import { agentDescription, agentNodes, bundle, executionPlan, file, inputsSection, planNarrative, producerLabels, rewritePrompt } from './common.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { effectiveTools, indexGraph } from '../graph/topology.mjs';
import { toYaml } from '../graph/serialize.mjs';

const WRITE_TOOLS = new Set(['write', 'edit', 'bash']);

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function compileCodex(graph) {
  const index = indexGraph(graph);
  const plan = executionPlan(graph);
  const agents = agentNodes(graph);
  const files = [];
  const label = producerLabels(graph);
  const promptOptions = {
    inputToken: reference => `<${reference.id}>`,
    nodeToken: reference => `the output of ${label(reference)}`,
  };

  const profiles = [
    `# Compiled from ${graph.id}.agentgraph.yaml by Graph Factory.`,
    '# Merge these profiles into ~/.codex/config.toml, then select one with --profile.',
    '',
  ];
  for (const node of agents) {
    const resolved = resolveNode(graph, node);
    const tools = effectiveTools(graph, node, index);
    const writes = tools.some(tool => WRITE_TOOLS.has(tool));
    profiles.push(
      `[profiles.${graph.id}-${node.id}]`,
      `model = ${tomlString(resolved.model)}`,
      // A read-only step should not be able to write. Codex expresses that as the
      // sandbox and approval policy rather than as a tool list.
      `approval_policy = ${tomlString(writes ? 'on-request' : 'never')}`,
      `sandbox_mode = ${tomlString(writes ? 'workspace-write' : 'read-only')}`,
      '',
    );
  }
  files.push(file('.codex/config.toml', profiles.join('\n')));

  for (const node of agents) {
    const body = [
      `# ${node.name || node.id}`,
      '',
      `${agentDescription(node)}.`,
      '',
      node.system ? `${node.system}\n` : '',
      '## Task',
      '',
      rewritePrompt(node.prompt, promptOptions),
      '',
      '## Output',
      '',
      `Report your result as \`${node.output || node.id}\`. Lead with the result itself.`,
    ].join('\n');
    files.push(file(`.codex/prompts/${graph.id}-${node.id}.md`, body));
  }

  const runner = [
    '#!/usr/bin/env bash',
    '# Compiled from ' + graph.id + '.agentgraph.yaml by Graph Factory.',
    '# Runs the linear spine of the graph as a sequence of codex exec calls.',
    'set -euo pipefail',
    '',
    'TASK="${1:?usage: run.sh <task>}"',
    'OUT="$(mktemp -d)"',
    'echo "$TASK" > "$OUT/input.txt"',
    '',
    ...plan.steps
      .filter(step => step.type === 'agent' || step.type === 'tool' || step.type === 'gate')
      .flatMap(step => {
        if (step.type === 'gate') {
          return [`# gate: ${step.name}`, `read -r -p ${tomlString(`${step.name} — continue? [y/N] `)} reply`, '[ "$reply" = "y" ] || exit 1', ''];
        }
        if (step.type === 'tool') {
          return [`# tool: ${step.name}`, `${step.run || `echo "MCP tool ${step.mcp} — run it yourself"`} | tee "$OUT/${step.output}.txt"`, ''];
        }
        return [
          `# agent: ${step.name}`,
          `codex exec --profile ${graph.id}-${step.id} \\`,
          `  "$(cat .codex/prompts/${graph.id}-${step.id}.md)\n\nInput:\n$(cat "$OUT/input.txt")" \\`,
          `  | tee "$OUT/${step.output}.txt"`,
          `cp "$OUT/${step.output}.txt" "$OUT/input.txt"`,
          '',
        ];
      }),
    'echo "Run complete. Artifacts in $OUT"',
  ].join('\n');
  files.push(file(`.codex/${graph.id}-run.sh`, runner));

  const agentsMd = [
    `# ${graph.name}`,
    '',
    graph.description || '',
    '',
    inputsSection(graph),
    '## Pipeline',
    '',
    'This repository runs an agent pipeline. When asked to run it, adopt each role below in order, one at a time, and do not skip ahead.',
    '',
    planNarrative(graph, plan),
    '',
    '## Roles',
    '',
    agents
      .map(node => {
        const tools = effectiveTools(graph, node, index);
        return `### ${node.id}\n\n${agentDescription(node)}. Profile \`${graph.id}-${node.id}\`, tools: ${tools.join(', ') || 'none'}.\n\nBrief: \`.codex/prompts/${graph.id}-${node.id}.md\``;
      })
      .join('\n\n'),
    '',
    '## Rules',
    '',
    '- A gate step means stop and ask. Never approve on your own behalf.',
    '- Steps marked parallel are independent; Codex runs one agent, so do them back to back and keep their outputs separate.',
    '',
    `_Compiled from \`${graph.id}.agentgraph.yaml\` by Graph Factory. Edit the graph, not this file._`,
  ].join('\n');
  files.push(file('AGENTS.md', agentsMd));
  files.push(file(`.codex/graph-factory/${graph.id}.agentgraph.yaml`, toYaml(graph)));

  const parallel = plan.steps.filter(step => step.type === 'parallel').length;
  const notes = [`${agents.length} profile(s) and prompt file(s)`, `Shell runner at .codex/${graph.id}-run.sh`];
  if (parallel) notes.push(`${parallel} parallel node(s) will run sequentially — Codex has one agent`);
  return bundle('codex', files, notes);
}
