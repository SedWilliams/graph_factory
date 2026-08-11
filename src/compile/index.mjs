/*
 * COMPILE — the target registry and the only entry point callers should use.
 *
 * Compilation refuses on validation errors. A bundle that will not run is worse
 * than no bundle: it lands as real files in someone's repo, gets committed, and
 * fails at 2am inside a harness that has no idea where it came from.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { validateGraph } from '../graph/validate.mjs';
import { normalizeGraph } from '../graph/normalize.mjs';
import { isInsideDir } from '../app_paths.mjs';
import { compileClaude } from './claude.mjs';
import { compilePi } from './pi.mjs';
import { compileOpencode } from './opencode.mjs';
import { compileCodex } from './codex.mjs';
import { compilePortable, runManifest } from './portable.mjs';

export const TARGETS = {
  claude: { label: 'Claude Code', blurb: 'Subagents in .claude/agents plus a slash command that runs the pipeline.', compile: compileClaude },
  pi: { label: 'Pi', blurb: 'Agent files, an executable agent-chain entry, and a team.', compile: compilePi },
  opencode: { label: 'opencode', blurb: 'Agents and a command in opencode.json, with explicit tool permissions.', compile: compileOpencode },
  codex: { label: 'Codex', blurb: 'AGENTS.md, config.toml profiles, prompt files, and a shell runner.', compile: compileCodex },
  portable: { label: 'Portable bundle', blurb: 'The canonical YAML, a Markdown doc, and a resolved run.json manifest.', compile: compilePortable },
};

export function targetList() {
  return Object.entries(TARGETS).map(([key, value]) => ({ key, label: value.label, blurb: value.blurb }));
}

export function compileGraph(graph, target) {
  const normalized = normalizeGraph(graph);
  const entry = TARGETS[target];
  if (!entry) throw new Error(`Unknown compile target "${target}". Known targets: ${Object.keys(TARGETS).join(', ')}.`);
  const validation = validateGraph(normalized);
  if (!validation.ok) {
    const error = new Error(`"${normalized.name}" has ${validation.errors.length} error(s) and cannot be compiled.`);
    error.validation = validation;
    throw error;
  }
  const result = entry.compile(normalized);
  return { ...result, label: entry.label, validation, manifest: runManifest(normalized) };
}

export function compileAll(graph) {
  return Object.keys(TARGETS).map(target => compileGraph(graph, target));
}

/*
 * Writing is separate from compiling on purpose: the editor previews a bundle
 * before anything touches disk, and the CLI writes without a preview. Every path is
 * confined to the output directory — a compiler bug must not be able to write
 * outside the folder the caller named.
 */
export async function writeBundle(bundleResult, outDir) {
  const root = path.resolve(outDir);
  const written = [];
  for (const entry of bundleResult.files) {
    const target = path.resolve(root, entry.path);
    if (!isInsideDir(root, target)) throw new Error(`Refusing to write outside the output directory: ${entry.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.contents, 'utf8');
    written.push(target);
  }
  return { outDir: root, written };
}
