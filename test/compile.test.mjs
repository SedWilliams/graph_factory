import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { compileGraph, TARGETS, writeBundle } from '../src/compile/index.mjs';
import { runManifest } from '../src/compile/portable.mjs';
import { executionPlan } from '../src/compile/common.mjs';
import { normalizeGraph } from '../src/graph/normalize.mjs';
import { starterGraphs, templateGraph } from '../src/graph/templates.mjs';
import { fromYaml } from '../src/graph/serialize.mjs';

const find = (bundle, suffix) => bundle.files.find(file => file.path.endsWith(suffix));

test('every target compiles every starter graph', () => {
  for (const graph of starterGraphs()) {
    for (const target of Object.keys(TARGETS)) {
      const bundle = compileGraph(graph, target);
      assert.ok(bundle.files.length > 0, `${graph.id} → ${target} produced nothing`);
      for (const file of bundle.files) {
        assert.ok(file.contents.trim().length > 0, `${target}:${file.path} is empty`);
        // A reference that survived translation would reach the harness as literal
        // braces and never be substituted. Two kinds of file are exempt because they
        // are descriptions of the graph rather than instructions to a model: the
        // bundled source, and everything in the portable bundle.
        if (target === 'portable' || /\.agentgraph\.yaml$|\.graph\.json$/.test(file.path)) continue;
        assert.doesNotMatch(file.contents, /\{\{\s*inputs\./, `${target}:${file.path} still has an unresolved input reference`);
        assert.doesNotMatch(file.contents, /\{\{\s*[a-z][a-z0-9_]*\s*\}\}/, `${target}:${file.path} still has an unresolved node reference`);
      }
    }
  }
});

test('compilation is refused when the graph has errors', () => {
  const broken = normalizeGraph({ nodes: [{ id: 'a', type: 'agent' }] });
  assert.throws(() => compileGraph(broken, 'claude'), /cannot be compiled/);
});

test('an unknown target is named in the error', () => {
  assert.throws(() => compileGraph(templateGraph('plan-build-review'), 'emacs'), /Unknown compile target "emacs"/);
});

/* ----------------------------------------------------------------- claude -- */

test('claude gets one subagent file per agent, with valid frontmatter', () => {
  const graph = templateGraph('plan-build-review');
  const bundle = compileGraph(graph, 'claude');
  for (const node of graph.nodes.filter(candidate => candidate.type === 'agent')) {
    const file = find(bundle, `.claude/agents/${node.id}.md`);
    assert.ok(file, `no agent file for ${node.id}`);
    const frontmatter = file.contents.split('---')[1];
    assert.match(frontmatter, new RegExp(`name: ${node.id}`));
    assert.match(frontmatter, /model: /);
    assert.match(frontmatter, /description: /);
  }
  // Tool names must be Claude's, not the graph's canonical spelling.
  assert.match(find(bundle, '.claude/agents/planner.md').contents, /tools: Read, Grep, Glob/);
});

test('claude gets a slash command carrying the control flow', () => {
  const bundle = compileGraph(templateGraph('review-until-clean'), 'claude');
  const command = find(bundle, '.claude/commands/review-until-clean.md');
  assert.match(command.contents, /argument-hint: <task>/);
  assert.match(command.contents, /go to `shipped`/);
  assert.match(command.contents, /go back to `builder`/);
});

test('the source graph travels with the compiled bundle and still parses', () => {
  const graph = templateGraph('parallel-audit');
  const bundle = compileGraph(graph, 'claude');
  const embedded = find(bundle, 'parallel-audit.agentgraph.yaml');
  assert.deepEqual(
    fromYaml(embedded.contents).nodes.map(node => node.id),
    graph.nodes.map(node => node.id),
  );
});

/* --------------------------------------------------------------------- pi -- */

test('pi gets a chain that is valid YAML and names real agents', () => {
  const graph = templateGraph('plan-build-review');
  const bundle = compileGraph(graph, 'pi');
  const chain = YAML.parse(find(bundle, 'agent-chain.yaml').contents);
  assert.ok(chain['plan-build-review']);
  const agentIds = new Set(graph.nodes.filter(node => node.type === 'agent').map(node => node.id));
  for (const step of chain['plan-build-review'].steps) assert.ok(agentIds.has(step.agent), `unknown agent ${step.agent}`);

  const team = YAML.parse(find(bundle, 'teams.yaml').contents);
  assert.deepEqual(team['plan-build-review'], [...agentIds]);
});

test('pi rewrites a reference to the previous step as $INPUT and nothing else', () => {
  const bundle = compileGraph(templateGraph('plan-build-review'), 'pi');
  const chain = YAML.parse(find(bundle, 'agent-chain.yaml').contents)['plan-build-review'];
  const builder = chain.steps.find(step => step.agent === 'builder');
  assert.match(builder.prompt, /\$INPUT/);
  // The reviewer also reads a tool node's output, which is not the previous chain
  // step, so that one must be described rather than mislabelled as $INPUT.
  const reviewer = chain.steps.find(step => step.agent === 'reviewer');
  assert.match(reviewer.prompt, /the output of the `tests` step/);
  assert.doesNotMatch(reviewer.prompt.split('Test output:')[1], /\$INPUT/);
});

test('pi is told which nodes the chain cannot express', () => {
  const bundle = compileGraph(templateGraph('review-until-clean'), 'pi');
  assert.ok(bundle.notes.some(note => /outside the chain/.test(note)));
});

/* --------------------------------------------------------------- opencode -- */

test('opencode.json is valid JSON with namespaced models and explicit tool permissions', () => {
  const graph = templateGraph('plan-build-review');
  const bundle = compileGraph(graph, 'opencode');
  const config = JSON.parse(find(bundle, 'opencode.json').contents);
  assert.equal(config.$schema, 'https://opencode.ai/config.json');

  const planner = config.agent.planner;
  assert.equal(planner.mode, 'subagent');
  assert.equal(planner.model, 'anthropic/claude-opus-5');
  assert.equal(planner.tools.read, true);
  // A tool the graph withheld has to be denied, not merely omitted.
  assert.equal(planner.tools.write, false);
  assert.equal(planner.tools.bash, false);

  assert.equal(config.agent['plan-build-review-orchestrator'].mode, 'primary');
  assert.equal(config.command['plan-build-review'].agent, 'plan-build-review-orchestrator');
});

/* ------------------------------------------------------------------ codex -- */

test('codex gets profiles whose sandbox matches what each agent may do', () => {
  const bundle = compileGraph(templateGraph('plan-build-review'), 'codex');
  const toml = find(bundle, 'config.toml').contents;
  // The planner only reads; the builder writes.
  const planner = toml.slice(toml.indexOf('[profiles.plan-build-review-planner]'));
  assert.match(planner.split('[profiles')[0] + planner.split('[profiles')[1], /sandbox_mode = "read-only"/);
  assert.match(toml, /sandbox_mode = "workspace-write"/);
  assert.ok(find(bundle, 'AGENTS.md'));
  assert.ok(find(bundle, 'plan-build-review-run.sh'));
});

test('codex admits that it will serialise a parallel node', () => {
  const bundle = compileGraph(templateGraph('parallel-audit'), 'codex');
  assert.ok(bundle.notes.some(note => /run sequentially/.test(note)));
});

/* --------------------------------------------------------------- portable -- */

test('the run manifest carries every step, its dependencies, and its branches', () => {
  const graph = templateGraph('review-until-clean');
  const manifest = runManifest(graph);
  assert.equal(manifest.manifest, 1);
  assert.deepEqual(manifest.entry, ['begin']);
  assert.deepEqual(
    manifest.steps.map(step => step.id),
    executionPlan(graph).steps.map(step => step.id),
  );
  const verdict = manifest.steps.find(step => step.id === 'verdict');
  assert.ok(verdict.next.some(edge => edge.when.includes('APPROVED')));
  assert.deepEqual(
    verdict.feedback.map(edge => edge.to),
    ['builder'],
  );
  const reviewer = manifest.steps.find(step => step.id === 'reviewer');
  assert.deepEqual(reviewer.dependsOn, ['builder']);
  // Prompts are carried unresolved: the manifest is the graph, fully described.
  assert.match(reviewer.prompt, /\{\{work\}\}/);
});

test('the portable bundle round trips back into the same graph', () => {
  const graph = templateGraph('parallel-audit');
  const bundle = compileGraph(graph, 'portable');
  const reparsed = fromYaml(find(bundle, 'parallel-audit.agentgraph.yaml').contents);
  assert.deepEqual(reparsed, graph);
  assert.ok(JSON.parse(find(bundle, 'run.json').contents).steps.length > 0);
});

/* ------------------------------------------------------------------ write -- */

test('writing a bundle creates every file under the chosen directory', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-factory-'));
  try {
    const bundle = compileGraph(templateGraph('plan-build-review'), 'claude');
    const { written } = await writeBundle(bundle, outDir);
    assert.equal(written.length, bundle.files.length);
    for (const file of bundle.files) {
      const contents = await fs.readFile(path.join(outDir, file.path), 'utf8');
      assert.equal(contents, file.contents);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('a bundle cannot write outside the directory it was given', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-factory-'));
  try {
    const escape = { target: 'evil', files: [{ path: '../escaped.txt', contents: 'no' }], notes: [] };
    await assert.rejects(() => writeBundle(escape, outDir), /Refusing to write outside/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
