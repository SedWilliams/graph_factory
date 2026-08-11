/*
 * TARGET: portable bundle.
 *
 * The other four targets translate the graph into a harness's own idiom and lose
 * something doing it. This one loses nothing. It emits the canonical YAML, a
 * generated Markdown document for reviewers, and `run.json` — a fully resolved
 * execution manifest with every prompt expanded and every branch condition intact.
 *
 * `run.json` is the contract for anything that wants to execute a graph without
 * depending on this app: the built-in executor reads it, and so can a CI job. It is
 * the reason "pass the file to a harness and have it execute correctly" is a
 * property of the format rather than a property of the editor.
 */

import { bundle, executionPlan, file, planNarrative } from './common.mjs';
import { resolveNode } from '../graph/normalize.mjs';
import { effectiveTools, entryNodes, indexGraph } from '../graph/topology.mjs';
import { toJson, toMarkdown, toYaml } from '../graph/serialize.mjs';
import { HARNESSES } from '../graph/schema.mjs';

export const MANIFEST_VERSION = 1;

export function runManifest(graph) {
  const index = indexGraph(graph);
  const plan = executionPlan(graph);
  return {
    manifest: MANIFEST_VERSION,
    graph: { id: graph.id, name: graph.name, description: graph.description },
    defaults: graph.defaults,
    inputs: graph.inputs,
    entry: entryNodes(graph, index).map(node => node.id),
    steps: plan.steps.map(step => {
      const node = index.nodes.get(step.id);
      const resolved = resolveNode(graph, node);
      return {
        id: step.id,
        type: step.type,
        name: step.name,
        model: step.type === 'agent' ? resolved.model : undefined,
        harness: step.type === 'agent' ? resolved.harness : undefined,
        maxTurns: step.type === 'agent' ? resolved.maxTurns : undefined,
        tools: step.type === 'agent' ? effectiveTools(graph, node, index) : undefined,
        system: node.system || undefined,
        prompt: node.prompt || undefined,
        run: node.run || undefined,
        mcp: node.mcp || undefined,
        expression: node.expression || undefined,
        until: node.until || undefined,
        maxIterations: node.maxIterations ?? undefined,
        join: node.join || undefined,
        concurrency: node.concurrency ?? undefined,
        onReject: node.onReject || undefined,
        continueOnError: node.continueOnError ?? undefined,
        output: step.output,
        dependsOn: step.dependsOn,
        next: step.next,
        feedback: step.feedback,
      };
    }),
    // The invocation each harness needs, so a runner does not have to know four CLIs.
    harnesses: Object.fromEntries(
      Object.entries(HARNESSES)
        .filter(([, value]) => value.command)
        .map(([key, value]) => [key, { command: value.command, agentDir: value.agentDir }]),
    ),
  };
}

export function compilePortable(graph) {
  const plan = executionPlan(graph);
  const readme = [
    `# ${graph.name}`,
    '',
    graph.description || '',
    '',
    '## What is in this bundle',
    '',
    `- \`${graph.id}.agentgraph.yaml\` — the graph. This is the source of truth; everything else is generated from it.`,
    `- \`${graph.id}.md\` — the same pipeline written out for a human reviewer, with a Mermaid diagram.`,
    `- \`run.json\` — a resolved execution manifest. Ordered steps, expanded prompts, branch conditions intact.`,
    `- \`${graph.id}.graph.json\` — the graph as JSON, for tools that would rather not parse YAML.`,
    '',
    '## Running it',
    '',
    '```bash',
    `graph-factory run ${graph.id}.agentgraph.yaml --harness claude --input task="…"`,
    '```',
    '',
    'Or compile it into a harness first:',
    '',
    '```bash',
    `graph-factory compile ${graph.id}.agentgraph.yaml --target claude --out .`,
    '```',
    '',
    '## Plan',
    '',
    planNarrative(graph, plan),
  ].join('\n');

  return bundle(
    'portable',
    [
      file(`${graph.id}.agentgraph.yaml`, toYaml(graph)),
      file(`${graph.id}.md`, toMarkdown(graph)),
      file(`${graph.id}.graph.json`, toJson(graph)),
      file('run.json', JSON.stringify(runManifest(graph), null, 2)),
      file('README.md', readme),
    ],
    ['Loses nothing — the canonical format plus a resolved run manifest', 'run.json is what the built-in executor consumes'],
  );
}
