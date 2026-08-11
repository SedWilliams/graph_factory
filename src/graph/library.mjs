/*
 * LIBRARY — the graphs on disk.
 *
 * The store is a flat directory of `<id>.agentgraph.yaml`, and that is the whole
 * database. It matters that these are ordinary files: a graph is source code for an
 * agent system, so it has to be diffable, committable, and editable in the editor
 * the developer already has open. Nothing here holds a lock or caches, so a file
 * changed outside the app is simply the new truth on next read.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { graphsDir } from '../app_paths.mjs';
import { FILE_EXTENSION, parseGraphFile, toYaml } from './serialize.mjs';
import { normalizeGraph, slugify } from './normalize.mjs';
import { validateGraph } from './validate.mjs';
import { starterGraphs } from './templates.mjs';

const isGraphFile = name => name.endsWith(FILE_EXTENSION) || name.endsWith('.agentgraph.json');

function fileFor(dir, id) {
  return path.join(dir, `${id}${FILE_EXTENSION}`);
}

export async function ensureLibrary(storeDir) {
  const dir = graphsDir(storeDir);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir).catch(() => []);
  if (existing.some(isGraphFile)) return dir;
  // A first run with an empty library is a dead end — there is nothing to open and
  // no way to learn the format. Seed it with the starters.
  for (const graph of starterGraphs()) {
    await fs.writeFile(fileFor(dir, graph.id), toYaml(graph), 'utf8');
  }
  return dir;
}

export async function listGraphs(storeDir) {
  const dir = graphsDir(storeDir);
  const names = (await fs.readdir(dir).catch(() => [])).filter(isGraphFile).sort();
  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const graph = parseGraphFile(raw, name);
      const stats = await fs.stat(file);
      const result = validateGraph(graph);
      entries.push({
        id: graph.id,
        name: graph.name,
        description: graph.description,
        file,
        fileName: name,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        errors: result.errors.length,
        warnings: result.warnings.length,
        updatedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      // A file that will not parse still belongs in the list — hiding it makes the
      // graph look deleted when it is only broken.
      entries.push({ id: name.replace(/\..*$/, ''), name, file, fileName: name, broken: String(error.message ?? error) });
    }
  }
  return entries;
}

export async function readGraph(storeDir, id) {
  const dir = graphsDir(storeDir);
  const file = fileFor(dir, slugify(id, ''));
  const raw = await fs.readFile(file, 'utf8');
  return { graph: parseGraphFile(raw, file), file, raw };
}

export async function writeGraph(storeDir, graph, { previousId = null } = {}) {
  const dir = graphsDir(storeDir);
  await fs.mkdir(dir, { recursive: true });
  const normalized = normalizeGraph(graph);
  const file = fileFor(dir, normalized.id);
  const body = toYaml(normalized);
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, body, 'utf8');
  await fs.rename(temporary, file);
  // Renaming a graph changes its filename. Drop the old one rather than leaving a
  // stale duplicate that reappears in the library next reload.
  if (previousId && previousId !== normalized.id) {
    await fs.rm(fileFor(dir, slugify(previousId, '')), { force: true });
  }
  return { graph: normalized, file };
}

export async function deleteGraph(storeDir, id) {
  const file = fileFor(graphsDir(storeDir), slugify(id, ''));
  await fs.rm(file, { force: true });
  return { file };
}

export async function uniqueGraphId(storeDir, wanted) {
  const dir = graphsDir(storeDir);
  const taken = new Set((await fs.readdir(dir).catch(() => [])).filter(isGraphFile).map(name => name.replace(FILE_EXTENSION, '')));
  const base = slugify(wanted, 'graph');
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export async function duplicateGraph(storeDir, id) {
  const { graph } = await readGraph(storeDir, id);
  const nextId = await uniqueGraphId(storeDir, `${graph.id}-copy`);
  return writeGraph(storeDir, { ...graph, id: nextId, name: `${graph.name} (copy)` });
}
