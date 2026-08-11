/*
 * TARGET: opencode.
 *
 * opencode keeps agents in `opencode.json` rather than in files, and its tool
 * permissions are an explicit allow/deny map instead of a list — so a tool the graph
 * does not grant has to be written as `false`, not merely omitted. Its model ids are
 * namespaced by provider, which the graph's bare model names are not, so the
 * compiler infers the provider from the model family.
 *
 * The graph's control flow becomes a `command` entry: one primary agent whose
 * template is the instruction sheet, with every agent node registered as a subagent
 * it can hand work to.
 */

import { agentDescription, agentNodes, bundle, executionPlan, file, inputsSection, planNarrative, producerLabels, rewritePrompt } from './common.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { CANONICAL_TOOLS } from '../graph/schema.mjs';
import { effectiveTools, indexGraph } from '../graph/topology.mjs';
import { toYaml } from '../graph/serialize.mjs';

const TOOL_NAMES = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  glob: 'glob',
  bash: 'bash',
  web_search: 'websearch',
  web_fetch: 'webfetch',
  todo: 'todowrite',
};

const ALL_TOOLS = [...new Set([...CANONICAL_TOOLS.map(tool => TOOL_NAMES[tool] ?? tool), 'list', 'patch', 'todoread'])];

function providerFor(model) {
  const id = String(model ?? '').toLowerCase();
  if (id.includes('/')) return null;
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('codex')) return 'openai';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('llama') || id.startsWith('qwen') || id.startsWith('deepseek')) return 'ollama';
  return null;
}

function qualifiedModel(model) {
  const provider = providerFor(model);
  return provider ? `${provider}/${model}` : model;
}

export function compileOpencode(graph) {
  const index = indexGraph(graph);
  const plan = executionPlan(graph);
  const agents = agentNodes(graph);
  const label = producerLabels(graph);
  const promptOptions = {
    inputToken: reference => `$${reference.id.toUpperCase()}`,
    nodeToken: reference => `the output of ${label(reference)}`,
  };

  const agentConfig = {};
  for (const node of agents) {
    const resolved = resolveNode(graph, node);
    const granted = new Set(effectiveTools(graph, node, index).map(tool => TOOL_NAMES[tool] ?? tool));
    const tools = {};
    for (const tool of ALL_TOOLS) tools[tool] = granted.has(tool);
    // A tool the graph names but opencode does not ship — an MCP tool, say — is still
    // granted; opencode resolves it at run time.
    for (const tool of granted) if (!(tool in tools)) tools[tool] = true;

    agentConfig[node.id] = {
      description: agentDescription(node),
      mode: 'subagent',
      model: qualifiedModel(resolved.model),
      temperature: 0.1,
      prompt: [
        node.system || `You are the ${node.name || node.id} step of the ${graph.name} pipeline.`,
        '',
        rewritePrompt(node.prompt, promptOptions),
        '',
        `Report your result as \`${node.output || node.id}\`.`,
      ].join('\n'),
      tools,
    };
  }

  const orchestrator = `${graph.id}-orchestrator`;
  agentConfig[orchestrator] = {
    description: graph.description || `Runs the ${graph.name} pipeline`,
    mode: 'primary',
    model: qualifiedModel(graph.defaults.model),
    prompt: orchestratorPrompt(graph, plan, agents),
    tools: Object.fromEntries(ALL_TOOLS.map(tool => [tool, tool === 'read' || tool === 'grep' || tool === 'glob' || tool === 'list'])),
  };

  const config = {
    $schema: 'https://opencode.ai/config.json',
    agent: agentConfig,
    command: {
      [graph.id]: {
        description: graph.description || `Run the ${graph.name} pipeline`,
        agent: orchestrator,
        template: `$ARGUMENTS\n\nRun the ${graph.name} pipeline against the request above, following your orchestration plan exactly.`,
      },
    },
  };

  return bundle(
    'opencode',
    [
      file('opencode.json', JSON.stringify(config, null, 2)),
      file(`.opencode/graph-factory/${graph.id}.md`, orchestratorPrompt(graph, plan, agents)),
      file(`.opencode/graph-factory/${graph.id}.agentgraph.yaml`, toYaml(graph)),
    ],
    [
      `${agents.length} subagent(s) plus the \`${orchestrator}\` primary agent`,
      'Merge `agent` and `command` into an existing opencode.json rather than overwriting it',
      `Run it with /${graph.id}`,
    ],
  );
}

function orchestratorPrompt(graph, plan, agents) {
  return [
    `# ${graph.name}`,
    '',
    graph.description || '',
    '',
    inputsSection(graph),
    '## Plan',
    '',
    'Follow these steps in order. Delegate every agent step to the named subagent with the task tool — do not do their work yourself.',
    '',
    planNarrative(graph, plan),
    '',
    '## Subagents',
    '',
    agents.map(node => `- \`${node.id}\` — ${agentDescription(node)}`).join('\n'),
    '',
    '## Rules',
    '',
    '- Pass each step its inputs verbatim.',
    '- A gate step means stop and wait for the user. Never approve on their behalf.',
    '- If a step fails, say which one and stop.',
    '',
    `_Compiled from \`${graph.id}.agentgraph.yaml\` by Graph Factory._`,
  ].join('\n');
}
