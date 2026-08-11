#!/usr/bin/env node
/*
 * CLI — the headless half of the app.
 *
 * The editor is where a graph gets designed; this is where it gets used. Everything
 * the UI can do to a graph file, `graph-factory` can do from a shell or a CI job,
 * against a path rather than against the library — because a graph belongs in the
 * repository it drives, not in this app's store.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { parseGraphFile, toMarkdown, toYaml } from '../src/graph/serialize.mjs';
import { formatIssues, validateGraph } from '../src/graph/validate.mjs';
import { compileGraph, targetList, writeBundle } from '../src/compile/index.mjs';
import { runGraph } from '../src/run/executor.mjs';
import { createAdapter, COMMANDS } from '../src/run/adapters.mjs';
import { templateGraph, templateList } from '../src/graph/templates.mjs';

const USAGE = `graph-factory — design and run agentic coding systems from a graph file

  graph-factory validate <file>
      Check a graph and report every error and warning.

  graph-factory compile <file> --target <name> [--out <dir>]
      Write harness files. Targets: ${targetList()
        .map(target => target.key)
        .join(', ')}

  graph-factory run <file> [--harness <name>] [--input k=v]... [--yes] [--cwd <dir>]
      Execute the graph. Harnesses: dry, ${Object.keys(COMMANDS).join(', ')}
      Default is dry: prompts are rendered and printed, no model is called.

  graph-factory show <file> [--format yaml|json|markdown|plan]
      Print the graph in another form.

  graph-factory new <template> [--out <file>]
      Write a starter graph. Templates: ${templateList()
        .map(template => template.key)
        .join(', ')}

  graph-factory serve [--port 4180]
      Start the editor.
`;

const argv = process.argv.slice(2);
const command = argv[0];

// A tiny flag parser: --flag value, --flag=value, and repeatable --input k=v.
function parseFlags(args) {
  const flags = { _: [], input: {} };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      flags._.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    const value = inline ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    if (name === 'input') {
      const [key, ...rest] = String(value).split('=');
      flags.input[key] = rest.join('=');
    } else {
      flags[name] = value;
    }
  }
  return flags;
}

const flags = parseFlags(argv.slice(1));
const fail = message => {
  console.error(`graph-factory: ${message}`);
  process.exit(1);
};

async function loadGraphFile(file) {
  if (!file) fail('a graph file is required.');
  const resolved = path.resolve(file);
  const source = await fs.readFile(resolved, 'utf8').catch(() => fail(`cannot read ${resolved}`));
  return { graph: parseGraphFile(source, resolved), file: resolved };
}

function report(validation) {
  if (validation.issues.length) console.error(formatIssues(validation));
  return validation.ok;
}

const commands = {
  async validate() {
    const { graph, file } = await loadGraphFile(flags._[0]);
    const validation = validateGraph(graph);
    console.log(`${graph.name} — ${graph.nodes.length} nodes, ${graph.edges.length} edges (${path.basename(file)})`);
    report(validation);
    console.log(validation.ok ? `OK: ${validation.warnings.length} warning(s), no errors.` : `FAILED: ${validation.errors.length} error(s).`);
    process.exit(validation.ok ? 0 : 1);
  },

  async compile() {
    const { graph } = await loadGraphFile(flags._[0]);
    const target = flags.target ?? 'portable';
    let bundle;
    try {
      bundle = compileGraph(graph, target);
    } catch (error) {
      if (error.validation) report(error.validation);
      return fail(error.message);
    }
    const outDir = path.resolve(flags.out ?? '.');
    const { written } = await writeBundle(bundle, outDir);
    console.log(`${bundle.label}: ${written.length} file(s) → ${outDir}`);
    for (const entry of bundle.files) console.log(`  ${entry.path}`);
    for (const note of bundle.notes) console.log(`  · ${note}`);
  },

  async run() {
    const { graph } = await loadGraphFile(flags._[0]);
    const harness = flags.harness ?? 'dry';
    const cwd = path.resolve(flags.cwd ?? process.cwd());
    const validation = validateGraph(graph);
    if (!validation.ok) {
      report(validation);
      return fail(`"${graph.name}" has ${validation.errors.length} error(s) and will not run.`);
    }

    const missing = graph.inputs.filter(input => input.required && !flags.input[input.id] && input.default === undefined);
    if (missing.length) return fail(`missing required input(s): ${missing.map(input => `--input ${input.id}=…`).join(' ')}`);

    const rl = flags.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
    const result = await runGraph(graph, {
      inputs: flags.input,
      cwd,
      adapter: createAdapter(harness, { cwd, graphId: graph.id }),
      onEvent: event => logEvent(event, harness),
      // A gate exists to stop the machine and ask a person. `--yes` is the explicit
      // opt out for CI; without it the CLI genuinely waits on stdin.
      onGate: async request => {
        if (!rl) return { approved: true, note: 'approved with --yes' };
        console.log(`\n  GATE  ${request.name}\n  ${request.message || 'Approve to continue.'}`);
        const answer = await rl.question('  Approve? [y/N] ');
        return { approved: /^y(es)?$/i.test(answer.trim()), note: answer.trim() };
      },
    });
    rl?.close();

    console.log(`\n${result.status.toUpperCase()} — ${result.steps.length} step(s) in ${duration(result)}`);
    if (result.error) console.error(`  ${result.error}`);
    const last = result.steps[result.steps.length - 1];
    if (last?.output) console.log(`\n${last.output}`);
    process.exit(result.status === 'completed' ? 0 : 1);
  },

  async show() {
    const { graph } = await loadGraphFile(flags._[0]);
    const format = flags.format ?? 'yaml';
    if (format === 'json') return console.log(JSON.stringify(graph, null, 2));
    if (format === 'markdown') return console.log(toMarkdown(graph));
    if (format === 'plan') {
      const { executionPlan, planNarrative } = await import('../src/compile/common.mjs');
      return console.log(planNarrative(graph, executionPlan(graph)));
    }
    return console.log(toYaml(graph));
  },

  async new() {
    const key = flags._[0];
    const graph = templateGraph(key);
    if (!graph)
      return fail(
        `unknown template "${key}". Try: ${templateList()
          .map(template => template.key)
          .join(', ')}`,
      );
    const out = path.resolve(flags.out ?? `${graph.id}.agentgraph.yaml`);
    await fs.writeFile(out, toYaml(graph), 'utf8');
    console.log(`Wrote ${out}`);
  },

  async serve() {
    if (flags.port) process.env.PORT = String(flags.port);
    await import('../src/server.mjs');
  },
};

function logEvent(event, harness) {
  if (event.kind === 'node.start') console.log(`→ ${event.name} (${event.type})`);
  if (event.kind === 'node.done' && event.preview) console.log(`  ${event.preview.split('\n').join('\n  ')}`);
  if (event.kind === 'node.skipped') console.log(`· skipped ${event.node}`);
  if (event.kind === 'route.taken') console.log(`  ↳ ${event.node} → ${event.to}${event.when ? ` (${event.when})` : ''}`);
  if (event.kind === 'loop.rewind') console.log(`  ↺ loop back to ${event.to} (round ${event.iteration} of ${event.limit})`);
  if (event.kind === 'loop.exhausted') console.log(`  ✗ loop hit its cap of ${event.limit}`);
  if (event.kind === 'template.missing') console.log(`  ! ${event.node}.${event.field} referenced {{${event.reference}}} but nothing produced it`);
  if (event.kind === 'run.error') console.error(`  ✗ ${event.message}`);
  if (harness === 'dry' && event.kind === 'node.done' && event.invocation) {
    console.log(`  $ ${event.invocation.command} ${(event.invocation.args ?? []).map(quote).join(' ')}`);
  }
}

const quote = argument => (/[\s"']/.test(String(argument)) ? JSON.stringify(String(argument).slice(0, 120)) : String(argument));

function duration(result) {
  const ms = new Date(result.finishedAt) - new Date(result.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (!commands[command]) {
  console.error(`graph-factory: unknown command "${command}".\n`);
  console.log(USAGE);
  process.exit(1);
}
await commands[command]();
