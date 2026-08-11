/*
 * SERVER — the editor's backend.
 *
 * Plain `node:http`, no framework. The whole API is a dozen JSON endpoints over a
 * directory of YAML files, and a dependency-free server is one less thing between a
 * developer and running this in a repo they do not control.
 *
 * It binds to loopback and never to a public interface, because the run endpoints
 * execute agent CLIs with write access to the working directory. That is a local
 * developer tool by construction, not by configuration.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicDir, resolveStoreDir, graphsDir, buildsDir } from './app_paths.mjs';
import { deleteGraph, duplicateGraph, ensureLibrary, listGraphs, readGraph, uniqueGraphId, writeGraph } from './graph/library.mjs';
import { normalizeGraph } from './graph/normalize.mjs';
import { validateGraph } from './graph/validate.mjs';
import { toMarkdown, toYaml, parseGraphFile } from './graph/serialize.mjs';
import { emptyGraph, EDGE_TYPES, HARNESSES, NODE_TYPES, CANONICAL_TOOLS } from './graph/schema.mjs';
import { templateGraph, templateList } from './graph/templates.mjs';
import { compileGraph, targetList, writeBundle } from './compile/index.mjs';
import { createRunStore } from './run/run_store.mjs';
import { COMMANDS } from './run/adapters.mjs';

const storeDir = resolveStoreDir();
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const runStore = createRunStore(storeDir);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

await ensureLibrary(storeDir);

/*
 * Routes are matched as `METHOD /path` with `:name` segments. Small enough to read
 * in one screen, which is the point of not pulling in a router.
 */
const routes = [
  ['GET', '/api/meta', () => meta()],
  ['GET', '/api/graphs', () => listGraphs(storeDir)],
  ['POST', '/api/graphs', ({ body }) => createGraph(body)],
  ['GET', '/api/graphs/:id', ({ params }) => loadGraph(params.id)],
  ['PUT', '/api/graphs/:id', ({ params, body }) => saveGraph(params.id, body)],
  ['DELETE', '/api/graphs/:id', ({ params }) => deleteGraph(storeDir, params.id)],
  ['POST', '/api/graphs/:id/duplicate', ({ params }) => duplicateGraph(storeDir, params.id)],
  ['POST', '/api/validate', ({ body }) => validateGraph(normalizeGraph(body.graph))],
  ['POST', '/api/preview', ({ body }) => preview(body)],
  ['POST', '/api/compile', ({ body }) => compile(body)],
  ['POST', '/api/import', ({ body }) => importGraph(body)],
  ['GET', '/api/runs', () => ({ runs: runStore.list() })],
  ['POST', '/api/runs', ({ body }) => startRun(body)],
  ['GET', '/api/runs/:id', ({ params }) => required(runStore.detail(params.id), 'run')],
  ['POST', '/api/runs/:id/gate', ({ params, body }) => runStore.answerGate(params.id, body.node, body.approved, body.note)],
  ['POST', '/api/runs/:id/cancel', ({ params }) => runStore.cancel(params.id)],
];

function meta() {
  return {
    storeDir,
    graphsDir: graphsDir(storeDir),
    cwd: process.cwd(),
    nodeTypes: NODE_TYPES,
    edgeTypes: EDGE_TYPES,
    harnesses: HARNESSES,
    tools: CANONICAL_TOOLS,
    targets: targetList(),
    templates: templateList(),
    // Only offer to run through a harness this machine could plausibly reach.
    runners: ['dry', ...Object.keys(COMMANDS)],
  };
}

async function loadGraph(id) {
  const { graph, file } = await readGraph(storeDir, id);
  return { graph, file, validation: validateGraph(graph), yaml: toYaml(graph) };
}

async function createGraph(body) {
  const source = body.template ? templateGraph(body.template) : emptyGraph();
  if (!source) throw badRequest(`Unknown template "${body.template}".`);
  const id = await uniqueGraphId(storeDir, body.id || body.name || source.id);
  const graph = normalizeGraph({ ...source, id, name: body.name || (body.template ? source.name : 'Untitled graph') });
  const saved = await writeGraph(storeDir, graph);
  return { ...saved, validation: validateGraph(saved.graph), yaml: toYaml(saved.graph) };
}

async function saveGraph(id, body) {
  const graph = normalizeGraph(body.graph);
  const saved = await writeGraph(storeDir, graph, { previousId: id });
  return { ...saved, validation: validateGraph(saved.graph), yaml: toYaml(saved.graph) };
}

// Live feedback for the editor: never touches disk, so it can run on every keystroke.
function preview({ graph, target }) {
  const normalized = normalizeGraph(graph);
  const validation = validateGraph(normalized);
  const response = { validation, yaml: toYaml(normalized), markdown: toMarkdown(normalized) };
  if (!target || !validation.ok) return response;
  const bundle = compileGraph(normalized, target);
  return { ...response, bundle: { target: bundle.target, label: bundle.label, notes: bundle.notes, files: bundle.files } };
}

async function compile({ graph, target, outDir }) {
  const normalized = normalizeGraph(graph);
  const bundle = compileGraph(normalized, target);
  const destination = outDir?.trim() ? path.resolve(outDir) : path.join(buildsDir(storeDir), normalized.id, target);
  const written = await writeBundle(bundle, destination);
  return { target, label: bundle.label, notes: bundle.notes, ...written, files: bundle.files.map(entry => entry.path) };
}

async function importGraph({ source, filename }) {
  const parsed = parseGraphFile(source, filename ?? '');
  const id = await uniqueGraphId(storeDir, parsed.id);
  const saved = await writeGraph(storeDir, { ...parsed, id });
  return { ...saved, validation: validateGraph(saved.graph) };
}

async function startRun({ id, graph, harness, inputs, cwd }) {
  const source = graph ? normalizeGraph(graph) : (await readGraph(storeDir, id)).graph;
  const validation = validateGraph(source);
  if (!validation.ok) throw badRequest(`"${source.name}" has ${validation.errors.length} validation error(s) and cannot run.`, { validation });
  const runner = harness || 'dry';
  if (runner !== 'dry' && !COMMANDS[runner]) throw badRequest(`Unknown harness "${runner}".`);
  return runStore.start(source, { inputs: inputs ?? {}, harness: runner, cwd: cwd?.trim() ? path.resolve(cwd) : process.cwd() });
}

/* -------------------------------------------------------------------------- */

function badRequest(message, extra = {}) {
  const error = new Error(message);
  error.status = 400;
  Object.assign(error, extra);
  return error;
}

function required(value, what) {
  if (value) return value;
  const error = new Error(`No such ${what}.`);
  error.status = 404;
  throw error;
}

function match(method, pathname) {
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw badRequest('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload ?? null);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function serveStatic(pathname, response) {
  const root = publicDir();
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(root, relative);
  // A traversal out of public/ would hand out arbitrary files from the machine.
  if (!target.startsWith(path.resolve(root))) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  try {
    const body = await fs.readFile(target);
    response.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: `Not found: ${pathname}` });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? host}`);
  const route = match(request.method, url.pathname);

  if (!route) {
    if (url.pathname.startsWith('/api/')) sendJson(response, 404, { error: `No such endpoint: ${request.method} ${url.pathname}` });
    else await serveStatic(url.pathname, response);
    return;
  }

  try {
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readBody(request);
    const result = await route.handler({ params: route.params, body, query: url.searchParams });
    sendJson(response, 200, result ?? { ok: true });
  } catch (error) {
    const status = error.status ?? 500;
    if (status >= 500) console.error(`[graph factory] ${request.method} ${url.pathname}`, error);
    sendJson(response, status, {
      error: String(error.message ?? error),
      validation: error.validation ?? undefined,
    });
  }
});

server.listen(port, host, () => {
  console.log(`[graph factory] Editor on http://${host}:${port}`);
  console.log(`[graph factory] Graphs in ${graphsDir(storeDir)}`);
});

export { server };
