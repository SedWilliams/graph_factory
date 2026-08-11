/*
 * TARGET: Pi.
 *
 * Pi is the closest fit of the four, because it already has a chain format:
 * `agent-chain.yaml` names a sequence of agents and the prompt each one receives,
 * with `$INPUT` carrying the previous step's output and `$ORIGINAL` the initial
 * request. A linear graph therefore compiles to a real, executable chain.
 *
 * Branches, gates, and loops have no chain equivalent, so the compiler is honest
 * about it: the chain covers the linear spine, and anything the spine cannot hold
 * is emitted as an orchestration brief for the top-level agent, plus a note saying
 * exactly which nodes fell outside the chain.
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
import YAML from 'yaml';

const TOOL_NAMES = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  glob: 'find',
  bash: 'bash',
  web_search: 'websearch',
  web_fetch: 'webfetch',
  todo: 'todo',
};

const toolName = tool => TOOL_NAMES[tool] ?? tool;

export function compilePi(graph) {
  const index = indexGraph(graph);
  const plan = executionPlan(graph);
  const files = [];
  const agents = agentNodes(graph);

  for (const node of agents) {
    const resolved = resolveNode(graph, node);
    const body = [
      frontmatter({
        name: node.id,
        description: agentDescription(node),
        tools: effectiveTools(graph, node, index).map(toolName).join(','),
        model: resolved.model,
      }),
      '',
      node.system || `You are the ${node.name || node.id} step of the ${graph.name} pipeline.`,
      '',
      rewritePrompt(node.prompt, { inputToken: reference => `<${reference.id}>`, nodeToken: reference => `<output of ${reference.id}>` }),
    ].join('\n');
    files.push(file(`.pi/agent/agents/${node.id}.md`, body));
  }

  // The chain: the agent steps of the plan, in order, up to the first construct a
  // chain cannot represent.
  const spine = [];
  const excluded = [];
  for (const step of plan.steps) {
    if (step.type === 'start' || step.type === 'end') continue;
    if (step.type === 'agent') {
      spine.push(step);
      continue;
    }
    excluded.push(step);
  }

  /*
   * A chain substitutes exactly two things: `$INPUT` is the previous step's output
   * and `$ORIGINAL` is the initial request. So a reference is rewritten to `$INPUT`
   * only when it really does name the step immediately before this one — anything
   * else would silently hand a step the wrong text, which is worse than telling the
   * agent in words which output it needs.
   */
  const label = producerLabels(graph);
  const firstInput = graph.inputs[0]?.id;
  const chain = {
    [graph.id]: {
      description: graph.description || graph.name,
      steps: spine.map((step, position) => {
        const previous = spine[position - 1];
        const options = {
          inputToken: reference => (reference.id === firstInput ? '$ORIGINAL' : `<${reference.id}>`),
          nodeToken: reference =>
            previous && (reference.id === previous.id || reference.id === previous.output) ? '$INPUT' : `the output of ${label(reference)}`,
        };
        const body = rewritePrompt(step.prompt, options);
        return { agent: step.id, prompt: position === 0 ? `${body}\n\nRequest: $INPUT` : body };
      }),
    },
  };
  files.push(
    file(
      '.pi/agent/agents/agent-chain.yaml',
      `# Compiled from ${graph.id}.agentgraph.yaml by Graph Factory.\n# Merge this key into your existing agent-chain.yaml.\n${YAML.stringify(chain, { lineWidth: 0 })}`,
    ),
  );

  const team = { [graph.id]: agents.map(node => node.id) };
  files.push(
    file(
      '.pi/agent/agents/teams.yaml',
      `# Compiled from ${graph.id}.agentgraph.yaml by Graph Factory.\n# Merge this key into your existing teams.yaml.\n${YAML.stringify(team, { lineWidth: 0 })}`,
    ),
  );

  const brief = [
    `# ${graph.name}`,
    '',
    graph.description || '',
    '',
    inputsSection(graph),
    '## Orchestration',
    '',
    `The chain \`${graph.id}\` in agent-chain.yaml runs the linear spine of this graph.`,
    excluded.length
      ? `It cannot express ${excluded.map(step => `\`${step.id}\` (${step.typeLabel.toLowerCase()})`).join(', ')} — drive the full plan below by hand, or with the pi-subagents extension.`
      : 'The chain covers the whole graph.',
    '',
    planNarrative(graph, plan),
    '',
    `_Compiled from \`${graph.id}.agentgraph.yaml\` by Graph Factory. Edit the graph, not this file._`,
  ].join('\n');
  files.push(file(`.pi/agent/graph-factory/${graph.id}.md`, brief));
  files.push(file(`.pi/agent/graph-factory/${graph.id}.agentgraph.yaml`, toYaml(graph)));

  const notes = [`${agents.length} agent file(s) under .pi/agent/agents/`, `Chain \`${graph.id}\` covers ${spine.length} step(s)`];
  if (excluded.length) notes.push(`${excluded.length} node(s) are outside the chain and need the orchestration brief`);
  return bundle('pi', files, notes);
}
