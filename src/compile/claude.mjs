/*
 * TARGET: Claude Code.
 *
 * Claude Code already has a subagent system, so every agent node becomes a real
 * `.claude/agents/*.md` file that the Task tool can dispatch to. What it has no
 * native form for is the pipeline between them — so the graph's control flow is
 * emitted as a slash command whose body is the orchestration instruction sheet.
 * Running `/<graph-id> <task>` therefore executes the graph.
 */

import {
  agentDescription,
  agentNodes,
  bundle,
  executionPlan,
  file,
  frontmatter,
  inputsSection,
  planNarrative,
  producerLabels,
  rewritePrompt,
} from './common.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { effectiveTools, indexGraph } from '../graph/topology.mjs';
import { toYaml } from '../graph/serialize.mjs';

const TOOL_NAMES = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  bash: 'Bash',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo: 'TodoWrite',
};

const toolName = tool => TOOL_NAMES[tool] ?? tool;

// The first input is what `/command <argument>` fills; the rest are asked for.
const promptOptions = graph => {
  const primary = graph.inputs[0]?.id;
  const label = producerLabels(graph);
  return {
    inputToken: reference => (reference.id === primary ? '$ARGUMENTS' : `the ${reference.id} the user gave you`),
    nodeToken: reference => `the output of ${label(reference)}`,
  };
};

export function compileClaude(graph) {
  const index = indexGraph(graph);
  const plan = executionPlan(graph);
  const options = promptOptions(graph);
  const files = [];

  for (const node of agentNodes(graph)) {
    const resolved = resolveNode(graph, node);
    const tools = effectiveTools(graph, node, index).map(toolName);
    const body = [
      frontmatter({
        name: node.id,
        description: agentDescription(node),
        tools,
        model: resolved.model,
      }),
      '',
      node.system ? rewritePrompt(node.system, options) : `You are the ${node.name || node.id} step of the ${graph.name} pipeline.`,
      '',
      '## Your task',
      '',
      rewritePrompt(node.prompt, options),
      '',
      `## Output`,
      '',
      `Report your result as \`${node.output || node.id}\`. The pipeline passes it to the next step verbatim, so lead with the result itself.`,
    ].join('\n');
    files.push(file(`.claude/agents/${node.id}.md`, body));
  }

  const command = [
    frontmatter({
      description: graph.description || `Run the ${graph.name} pipeline`,
      'argument-hint': graph.inputs[0] ? `<${graph.inputs[0].id}>` : undefined,
    }),
    '',
    `# ${graph.name}`,
    '',
    graph.description || '',
    '',
    inputsSection(graph),
    '## How to run this',
    '',
    'Work through the steps in order. Dispatch each agent step with the Task tool using the named subagent — do not do its work yourself.',
    '',
    planNarrative(graph, plan),
    '',
    '## Rules',
    '',
    '- Pass each step its inputs verbatim. Do not summarise a previous step before handing it on.',
    '- A gate step means stop and wait for the user. Never approve on their behalf.',
    '- If a step fails, report which one and stop; do not improvise a different path through the graph.',
    '',
    `_Compiled from \`${graph.id}${'.agentgraph.yaml'}\` by Graph Factory. Edit the graph, not this file._`,
  ].join('\n');
  files.push(file(`.claude/commands/${graph.id}.md`, command));

  // The source travels with the build so a checkout can be recompiled without the app.
  files.push(file(`.claude/graph-factory/${graph.id}.agentgraph.yaml`, toYaml(graph)));

  return bundle('claude', files, [
    `${agentNodes(graph).length} subagent file(s) under .claude/agents/`,
    `Run it with /${graph.id}${graph.inputs[0] ? ` <${graph.inputs[0].id}>` : ''}`,
  ]);
}
