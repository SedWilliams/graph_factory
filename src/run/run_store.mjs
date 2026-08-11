/*
 * RUN STORE — live runs and their journals.
 *
 * A run outlives the request that started it, so it cannot be a promise the HTTP
 * handler awaits: the browser polls for progress and a gate is answered by a second
 * request arriving mid-flight. Runs therefore live in memory keyed by id, and each
 * one carries a deferred gate the approve endpoint resolves.
 *
 * Journals are also appended to disk as JSONL, because the thing you want after an
 * agent pipeline behaves oddly is the exact prompt each step was sent.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runsDir } from '../app_paths.mjs';
import { runGraph } from './executor.mjs';
import { createAdapter } from './adapters.mjs';

const runs = new Map();
const MAX_RETAINED = 50;

export function createRunStore(storeDir) {
  return {
    start: (graph, options) => startRun(storeDir, graph, options),
    get: id => summarize(runs.get(id)),
    detail: id => detail(runs.get(id)),
    list: () =>
      [...runs.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, MAX_RETAINED)
        .map(summarize),
    answerGate: (id, nodeId, approved, note) => answerGate(runs.get(id), nodeId, approved, note),
    cancel: id => cancel(runs.get(id)),
  };
}

function startRun(storeDir, graph, { inputs = {}, harness = 'dry', cwd = process.cwd() } = {}) {
  const id = randomUUID().slice(0, 8);
  const controller = new AbortController();
  const record = {
    id,
    graphId: graph.id,
    graphName: graph.name,
    harness,
    cwd,
    inputs,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    journal: [],
    steps: [],
    outputs: {},
    error: null,
    gate: null,
    controller,
    file: path.join(runsDir(storeDir), `${new Date().toISOString().replace(/[:.]/g, '-')}-${graph.id}-${id}.jsonl`),
  };
  runs.set(id, record);
  prune();

  const append = event => {
    record.journal.push(event);
    // Best effort: losing a journal line must never fail the run.
    fs.mkdir(path.dirname(record.file), { recursive: true })
      .then(() => fs.appendFile(record.file, `${JSON.stringify(event)}\n`, 'utf8'))
      .catch(() => {});
  };

  const adapter = createAdapter(harness, { cwd, graphId: graph.id });

  runGraph(graph, {
    inputs,
    adapter,
    cwd,
    signal: controller.signal,
    onEvent: append,
    onGate: request =>
      new Promise(resolve => {
        record.gate = { ...request, askedAt: new Date().toISOString(), resolve };
      }),
  })
    .then(result => {
      record.status = result.status;
      record.steps = result.steps;
      record.outputs = result.outputs;
      record.error = result.error;
    })
    .catch(error => {
      record.status = 'failed';
      record.error = String(error.message ?? error);
      append({ at: new Date().toISOString(), kind: 'run.error', message: record.error });
    })
    .finally(() => {
      record.finishedAt = new Date().toISOString();
      record.gate = null;
    });

  return summarize(record);
}

function answerGate(record, nodeId, approved, note) {
  if (!record) throw new Error('That run no longer exists.');
  if (!record.gate) throw new Error('That run is not waiting at a gate.');
  if (nodeId && record.gate.id !== nodeId) throw new Error(`The run is waiting at "${record.gate.id}", not "${nodeId}".`);
  const resolve = record.gate.resolve;
  record.gate = null;
  resolve({ approved: Boolean(approved), note: String(note ?? '') });
  return { ok: true };
}

function cancel(record) {
  if (!record) throw new Error('That run no longer exists.');
  record.controller.abort();
  // A run parked at a gate is not inside the executor loop, so aborting alone would
  // leave it hanging. Reject the gate to unblock it.
  if (record.gate) {
    const resolve = record.gate.resolve;
    record.gate = null;
    resolve({ approved: false, note: 'cancelled' });
  }
  return { ok: true };
}

function summarize(record) {
  if (!record) return null;
  const { controller, journal, gate, ...rest } = record;
  return {
    ...rest,
    events: journal.length,
    gate: gate ? { id: gate.id, name: gate.name, message: gate.message, askedAt: gate.askedAt } : null,
  };
}

function detail(record) {
  if (!record) return null;
  return { ...summarize(record), journal: record.journal };
}

function prune() {
  if (runs.size <= MAX_RETAINED) return;
  const oldest = [...runs.values()]
    .filter(record => record.status !== 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(0, runs.size - MAX_RETAINED);
  for (const record of oldest) runs.delete(record.id);
}
