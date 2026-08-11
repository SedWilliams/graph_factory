/*
 * Graph Factory — the editor.
 *
 * Three things share one graph object and must never disagree about it: the canvas,
 * the inspector, and the file on disk. So there is exactly one mutable `graph`, every
 * change goes through `mutate()`, and `mutate()` is the only thing that marks the
 * document dirty, repaints, and schedules the save. Nothing else writes to `graph`.
 *
 * The canvas is deliberately not a DOM tree. Node positions are authored data — they
 * are saved into the file so a graph reopens exactly as it was left — and a canvas
 * lets position stay a number rather than becoming a style. The force simulation
 * inherited from the startup_kit graph view still runs, but only over nodes the
 * author has not placed: dragging a node pins it, and a pinned node is never moved
 * by physics again.
 */

/* ------------------------------------------------------------------ state -- */

let meta = null;
let graph = null;
let graphId = null;
let library = [];
let validation = { ok: true, errors: [], warnings: [], issues: [] };
let selection = null; // { kind: 'node' | 'edge', id }
let placing = null; // a node type waiting for a canvas click
let dirty = false;
let saveTimer = null;
let view = null;
let drawer = null;
let run = null;
let runPoll = null;

const THEMES = ['', 'midnight', 'light'];
let themeIndex = 0;

const $ = selector => document.querySelector(selector);
const esc = value =>
  String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const uniqueBy = (list, key) => [...new Map(list.map(item => [key(item), item])).values()];

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.validation = body.validation;
    throw error;
  }
  return body;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2600);
}

const fail = error => toast(String(error?.message ?? error));

/* ------------------------------------------------------------------- boot -- */

async function boot() {
  meta = await api('/api/meta');
  bindChrome();
  drawPalette();
  await refreshLibrary();
  const first = library.find(entry => !entry.broken);
  if (first) await openGraph(first.id);
  else await createGraph({});
}

async function refreshLibrary() {
  library = await api('/api/graphs');
  drawLibrary();
}

function drawLibrary() {
  $('#graph-list').innerHTML = `<div class="rail-group">Graphs</div>${
    library
      .map(entry => {
        const badge = entry.broken
          ? '<b class="graph-badge err">!</b>'
          : entry.errors
            ? `<b class="graph-badge err">${entry.errors}</b>`
            : entry.warnings
              ? `<b class="graph-badge warn">${entry.warnings}</b>`
              : '';
        return `<div class="graph-row ${entry.id === graphId ? 'active' : ''}"><button class="graph-open" data-open="${esc(entry.id)}" title="${esc(entry.file ?? '')}"><span>${esc(entry.name ?? entry.id)}</span><small>${entry.broken ? 'will not parse' : `${entry.nodes} nodes · ${entry.edges} edges`}</small></button>${badge}</div>`;
      })
      .join('') || '<div class="inspector-empty">No graphs yet.</div>'
  }`;
  document.querySelectorAll('[data-open]').forEach(button => {
    button.onclick = () => openGraph(button.dataset.open);
  });
}

async function openGraph(id) {
  await flushSave();
  const loaded = await api(`/api/graphs/${encodeURIComponent(id)}`).catch(fail);
  if (!loaded) return;
  graph = loaded.graph;
  graphId = graph.id;
  validation = loaded.validation;
  selection = null;
  placing = null;
  dirty = false;
  buildView({ fit: true });
  drawAll();
  drawLibrary();
}

async function createGraph(body) {
  const created = await api('/api/graphs', { method: 'POST', body: JSON.stringify(body) }).catch(fail);
  if (!created) return;
  await refreshLibrary();
  await openGraph(created.graph.id);
  toast(`Created ${created.graph.name}`);
}

/* --------------------------------------------------------------- mutation -- */

/*
 * The single write path. Everything that changes the graph calls this, which is what
 * keeps the canvas, the inspector, the validation strip, and the file in step — and
 * why there is no separate "refresh" anyone can forget to call.
 */
function mutate(change, { rebuild = false, fit = false } = {}) {
  change(graph);
  dirty = true;
  if (rebuild) buildView({ fit, keepCamera: !fit });
  else syncView();
  drawAll();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  drawStatus('saving');
  saveTimer = setTimeout(save, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (dirty) await save();
}

async function save() {
  if (!graph) return;
  const previousId = graphId;
  try {
    const saved = await api(`/api/graphs/${encodeURIComponent(previousId)}`, { method: 'PUT', body: JSON.stringify({ graph }) });
    // The server normalises: ids get slugged, empty fields dropped. Take its answer
    // as the truth, or the editor slowly drifts from the file it is writing.
    graph = saved.graph;
    graphId = graph.id;
    validation = saved.validation;
    dirty = false;
    syncView();
    drawStatus();
    drawIssues();
    drawTitle();
    if (previousId !== graphId) await refreshLibrary();
    else updateLibraryEntry();
  } catch (error) {
    dirty = true;
    drawStatus('error');
    fail(error);
  }
}

function updateLibraryEntry() {
  const entry = library.find(item => item.id === graphId);
  if (!entry) return;
  Object.assign(entry, {
    name: graph.name,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
  });
  drawLibrary();
}

/* ------------------------------------------------------------------- draw -- */

function drawAll() {
  drawTitle();
  drawStatus();
  drawIssues();
  drawInspector();
  paint();
}

function drawTitle() {
  $('#graph-title').textContent = graph?.name ?? '—';
  $('#graph-subtitle').textContent = graph ? `${graph.id} · ${graph.nodes.length} nodes · ${graph.edges.length} edges` : '';
}

function drawStatus(override) {
  const pill = $('#status-pill');
  if (override === 'saving') {
    pill.className = 'status-pill saving';
    pill.textContent = 'Saving…';
    return;
  }
  if (override === 'error') {
    pill.className = 'status-pill err';
    pill.textContent = 'Save failed';
    return;
  }
  const errors = validation.errors.length;
  const warnings = validation.warnings.length;
  pill.className = `status-pill ${errors ? 'err' : warnings ? 'warn' : 'ok'}`;
  pill.textContent = errors ? `${errors} error${errors === 1 ? '' : 's'}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'Valid';
}

function drawIssues() {
  $('#issues').innerHTML = validation.issues
    .map(
      issue =>
        `<button class="issue ${issue.severity}" data-node="${esc(issue.node ?? '')}" data-edge="${esc(issue.edge ?? '')}"><b>${issue.severity === 'error' ? 'ERR' : 'WARN'}</b><span>${esc(issue.message)}</span><code>${esc(issue.code)}</code></button>`,
    )
    .join('');
  document.querySelectorAll('.issue').forEach(button => {
    button.onclick = () => {
      const nodeId = button.dataset.node;
      const edgeId = button.dataset.edge;
      if (nodeId) select('node', nodeId, { focus: true });
      else if (edgeId) select('edge', edgeId);
    };
  });
}

function drawPalette() {
  const entries = Object.entries(meta.nodeTypes);
  $('#palette').innerHTML = `<div class="palette-label">Add</div>${entries
    .map(
      ([type, info]) =>
        `<button data-type="${type}" title="${esc(info.hint)}"><i class="dot" style="background: var(--node-${type})"></i>${esc(info.label)}</button>`,
    )
    .join('')}<div class="divider"></div><div class="palette-label">Edge</div>${Object.entries(meta.edgeTypes)
    .map(
      ([type, info]) =>
        `<button data-edge-type="${type}" title="${esc(info.hint)}"><i class="dot" style="background: var(--edge-${type})"></i>${esc(info.label)}</button>`,
    )
    .join('')}`;

  document.querySelectorAll('[data-type]').forEach(button => {
    button.onclick = () => setPlacing(placing === button.dataset.type ? null : button.dataset.type);
  });
  document.querySelectorAll('[data-edge-type]').forEach(button => {
    button.onclick = () => setEdgeType(button.dataset.edgeType);
  });
  setEdgeType('flow');
  drawHint();
}

let edgeType = 'flow';

function setPlacing(type) {
  placing = type;
  document.querySelectorAll('[data-type]').forEach(button => button.classList.toggle('active', button.dataset.type === placing));
  if (view) view.canvas.style.cursor = placing ? 'copy' : 'grab';
  drawHint();
}

function setEdgeType(type) {
  edgeType = type;
  document.querySelectorAll('[data-edge-type]').forEach(button => button.classList.toggle('active', button.dataset.edgeType === edgeType));
  drawHint();
}

function drawHint() {
  $('#stage-hint').innerHTML = placing
    ? `Click the canvas to place a <b>${esc(meta.nodeTypes[placing].label)}</b> · Esc to cancel`
    : `<b>Shift</b>+drag a node to connect (${esc(meta.edgeTypes[edgeType].label.toLowerCase())}) · drag to move · <b>Del</b> to remove`;
}

/* ----------------------------------------------------------------- canvas -- */

// The canvas cannot inherit colour from the stylesheet, so it reads the --node-* and
// --edge-* tokens off the root element. Cached because paint() runs every frame; a
// theme change swaps data-theme, which invalidates the cache below.
const palette = new Map();
function themeColor(token) {
  let value = palette.get(token);
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    palette.set(token, value);
  }
  return value;
}
new MutationObserver(() => {
  palette.clear();
  paint();
}).observe(document.documentElement, { attributeFilter: ['style', 'data-theme'] });

const NODE_HEIGHT = 46;
const MIN_WIDTH = 130;
const MAX_WIDTH = 260;
const PAD_X = 14;
let bound = false;

/*
 * Node text lives in graph units, exactly like the box that contains it.
 *
 * It used to be sized at `13 / view.scale`, which cancels the canvas transform and
 * pins the label to a constant 13 screen pixels. The box does not do that — it is
 * measured in graph units and shrinks as you zoom out — so the two drifted apart and
 * the text climbed out of the node. Same units for both, and they scale together.
 */
const TITLE_FONT = '600 13px Inter, "Segoe UI", sans-serif';
const EYEBROW_FONT = '600 9.5px Inter, "Segoe UI", sans-serif';
const EDGE_FONT = '11px ui-monospace, Consolas, monospace';

/*
 * Widths come from measuring the glyphs, never from counting characters: the old
 * `label.length * 7.6` under-measured every capital and over-measured every `i`, so
 * a node was sized for the wrong string. Measurement is cached because paint() runs
 * once a frame over every node.
 */
const measurer = document.createElement('canvas').getContext('2d');
const textCache = new Map();

function textWidth(text, font) {
  const key = `${font} ${text}`;
  let width = textCache.get(key);
  if (width === undefined) {
    if (textCache.size > 800) textCache.clear();
    measurer.font = font;
    width = measurer.measureText(text).width;
    textCache.set(key, width);
  }
  return width;
}

// Longest prefix that fits, plus an ellipsis. Binary search rather than a character
// estimate, for the same reason widths are measured rather than guessed.
function fitText(text, maxWidth, font) {
  const source = String(text ?? '');
  if (!source || textWidth(source, font) <= maxWidth) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(`${source.slice(0, mid)}…`, font) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${source.slice(0, low)}…` : '';
}

/*
 * A canvas has no intrinsic size, so it has to be told its pixel dimensions every
 * time its container changes. A window resize listener is not enough: the stage also
 * changes size when the library rail collapses, when a scrollbar appears, and — the
 * case that actually bites — on first paint, before fonts and CSS have settled. The
 * observer covers all of them, and covers them without a timeout.
 */
function observeStage() {
  new ResizeObserver(() => resize()).observe($('#stage'));
}

function buildView({ fit = false, keepCamera = false } = {}) {
  const canvas = $('#canvas');
  const camera = keepCamera && view ? { scale: view.scale, tx: view.tx, ty: view.ty } : { scale: 1, tx: 0, ty: 0 };
  const positions = layoutPositions(graph);

  view = {
    canvas,
    ctx: canvas.getContext('2d'),
    nodes: graph.nodes.map(node => ({
      id: node.id,
      ...positions.get(node.id),
      vx: 0,
      vy: 0,
      pinned: Boolean(graph.layout?.[node.id]),
    })),
    dpr: 1,
    width: 800,
    height: 600,
    ...camera,
    alpha: graph.nodes.some(node => !graph.layout?.[node.id]) ? 1 : 0,
    hover: null,
    drag: null,
    pan: null,
    link: null,
    moved: 0,
    frame: 0,
  };
  view.index = new Map(view.nodes.map(node => [node.id, node]));
  if (!bound) {
    bindCanvas();
    observeStage();
    bound = true;
  }
  resize();
  if (fit) fitView();
  cancelAnimationFrame(window.__gfFrame);
  tick();
}

// Nodes the editor has seen keep their coordinates; anything new is ranked into a
// left-to-right pipeline, which is the shape a reader expects a pipeline to have.
function layoutPositions(source) {
  const positions = new Map();
  const missing = [];
  for (const node of source.nodes) {
    const saved = source.layout?.[node.id];
    if (saved) positions.set(node.id, { x: saved.x, y: saved.y });
    else missing.push(node);
  }
  if (!missing.length) return positions;

  const ranks = rankNodes(source);
  const byRank = new Map();
  for (const node of missing) {
    const rank = ranks.get(node.id) ?? 0;
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(node);
  }
  for (const [rank, nodes] of byRank) {
    nodes.forEach((node, i) => {
      positions.set(node.id, { x: rank * 250, y: (i - (nodes.length - 1) / 2) * 110 });
    });
  }
  return positions;
}

// A local re-implementation of the server's ranking: the editor must be able to lay
// out a graph while offline between saves, and the rule is small enough to restate.
function rankNodes(source) {
  const out = new Map(source.nodes.map(node => [node.id, []]));
  const inbound = new Map(source.nodes.map(node => [node.id, 0]));
  for (const edge of source.edges) {
    if (edge.type === 'uses' || edge.type === 'feedback') continue;
    if (!out.has(edge.from) || !out.has(edge.to)) continue;
    out.get(edge.from).push(edge.to);
    inbound.set(edge.to, inbound.get(edge.to) + 1);
  }
  const rank = new Map();
  const queue = source.nodes.filter(node => !inbound.get(node.id)).map(node => node.id);
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const next of out.get(id) ?? []) {
      const depth = (rank.get(id) ?? 0) + 1;
      if ((rank.get(next) ?? -1) < depth) {
        rank.set(next, depth);
        queue.push(next);
      }
    }
  }
  let floor = 0;
  for (const value of rank.values()) floor = Math.max(floor, value);
  for (const node of source.nodes) if (!rank.has(node.id)) rank.set(node.id, floor + 1);
  return rank;
}

// Keeps view nodes in step with the graph without discarding camera or physics —
// used after every edit that does not add or remove a node.
function syncView() {
  if (!view) return;
  const wanted = new Set(graph.nodes.map(node => node.id));
  if (view.nodes.length !== graph.nodes.length || view.nodes.some(node => !wanted.has(node.id))) {
    buildView({ keepCamera: true });
    return;
  }
  for (const node of view.nodes) {
    const saved = graph.layout?.[node.id];
    if (saved && !view.drag) {
      node.x = saved.x;
      node.y = saved.y;
      node.pinned = true;
    }
  }
}

function nodeOf(id) {
  return graph.nodes.find(node => node.id === id);
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}#${edge.type}`;
}

// Wide enough for whichever of the two lines is longer. Beyond MAX_WIDTH the label
// is ellipsised instead, so one very long name cannot stretch the whole layout.
function nodeWidth(node) {
  const model = nodeOf(node.id);
  if (!model) return MIN_WIDTH;
  const title = textWidth(model.name || model.id, TITLE_FONT);
  const eyebrow = textWidth(nodeTypeLabel(model), EYEBROW_FONT);
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.max(title, eyebrow) + PAD_X * 2));
}

function nodeTypeLabel(model) {
  return (meta.nodeTypes[model.type]?.label ?? model.type).toUpperCase();
}

function resize() {
  if (!view) return;
  const box = $('#stage').getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  view.width = Math.max(240, Math.round(box.width));
  view.height = Math.max(240, Math.round(box.height));
  view.canvas.width = Math.round(view.width * view.dpr);
  view.canvas.height = Math.round(view.height * view.dpr);
  view.canvas.style.width = `${view.width}px`;
  view.canvas.style.height = `${view.height}px`;
  paint();
}

function fitView() {
  if (!view?.nodes.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of view.nodes) {
    const half = nodeWidth(node) / 2;
    minX = Math.min(minX, node.x - half);
    maxX = Math.max(maxX, node.x + half);
    minY = Math.min(minY, node.y - NODE_HEIGHT / 2);
    maxY = Math.max(maxY, node.y + NODE_HEIGHT / 2);
  }
  const pad = 70;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  view.scale = Math.min(1.6, Math.max(0.2, Math.min(view.width / width, view.height / height)));
  view.tx = view.width / 2 - ((minX + maxX) / 2) * view.scale;
  view.ty = view.height / 2 - ((minY + maxY) / 2) * view.scale;
  paint();
}

/*
 * Physics, inherited from the startup_kit graph view but bounded by authorship: a
 * pinned node contributes repulsion and spring force to its neighbours and is never
 * moved by them. That is what lets a mostly-hand-placed graph absorb a new node
 * without the whole picture rearranging itself.
 */
function step() {
  const nodes = view.nodes;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (i % 7) - 3.5;
        dy = (j % 5) - 2.5;
        d2 = dx * dx + dy * dy || 1;
      }
      if (d2 > 360000) continue;
      const d = Math.sqrt(d2);
      const push = Math.min(40, 26000 / d2) * view.alpha;
      a.vx -= (dx / d) * push;
      a.vy -= (dy / d) * push;
      b.vx += (dx / d) * push;
      b.vy += (dy / d) * push;
    }
  }
  for (const edge of graph.edges) {
    const a = view.index.get(edge.from);
    const b = view.index.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const pull = (d - 210) * 0.03 * view.alpha;
    a.vx += (dx / d) * pull;
    a.vy += (dy / d) * pull;
    b.vx -= (dx / d) * pull;
    b.vy -= (dy / d) * pull;
  }
  for (const node of nodes) {
    if (node.pinned || node === view.drag?.node) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 0.84;
    node.vy *= 0.84;
    node.x += Math.max(-26, Math.min(26, node.vx));
    node.y += Math.max(-26, Math.min(26, node.vy));
  }
}

function tick() {
  if (!view) return;
  if (view.alpha > 0.01) {
    step();
    view.alpha *= 0.972;
    // When the simulation settles, the positions it found become authored data —
    // otherwise a reload would re-simulate and produce a different picture.
    if (view.alpha <= 0.01) commitLayout();
  }
  paint();
  window.__gfFrame = requestAnimationFrame(tick);
}

function commitLayout() {
  const layout = {};
  for (const node of view.nodes) layout[node.id] = { x: Math.round(node.x * 100) / 100, y: Math.round(node.y * 100) / 100 };
  for (const node of view.nodes) node.pinned = true;
  mutate(current => {
    current.layout = layout;
  });
}

function paint() {
  if (!view || !graph) return;
  const { ctx } = view;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.translate(view.tx, view.ty);
  ctx.scale(view.scale, view.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const focus = selection?.kind === 'node' ? selection.id : null;
  const errorNodes = new Set(validation.errors.map(issue => issue.node).filter(Boolean));

  for (const edge of graph.edges) drawEdge(edge, focus);
  if (view.link) drawGhostLink();
  for (const node of view.nodes) drawNode(node, focus, errorNodes);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  $('#stage-empty').hidden = graph.nodes.length > 0;
}

// Where the line between two boxes should start and stop: the point on the source
// box's border facing the target, so an arrowhead lands on the edge of the node
// rather than under it.
function anchor(from, to) {
  const halfWidth = nodeWidth(from) / 2;
  const halfHeight = NODE_HEIGHT / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) return { x: from.x, y: from.y };
  const scale = Math.min(halfWidth / Math.abs(dx || 1e-6), halfHeight / Math.abs(dy || 1e-6));
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function drawEdge(edge, focus) {
  const { ctx } = view;
  const a = view.index.get(edge.from);
  const b = view.index.get(edge.to);
  if (!a || !b) return;
  const selected = selection?.kind === 'edge' && selection.id === edgeKey(edge);
  const lit = selected || focus === edge.from || focus === edge.to;
  const start = anchor(a, b);
  const end = anchor(b, a);

  ctx.globalAlpha = focus && !lit ? 0.22 : 1;
  ctx.strokeStyle = themeColor(`--edge-${edge.type}`) || themeColor('--edge-flow');
  ctx.lineWidth = (selected ? 3 : lit ? 2.1 : 1.5) / view.scale;
  ctx.setLineDash(edge.type === 'uses' ? [4 / view.scale, 4 / view.scale] : edge.type === 'feedback' ? [9 / view.scale, 5 / view.scale] : []);

  // Feedback edges point backwards, so a straight line would lie on top of the
  // forward path. Bowing them out keeps both readable.
  const bow = edge.type === 'feedback' ? 58 : 0;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2 - bow;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.quadraticCurveTo(midX, midY, end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const angle = Math.atan2(end.y - midY, end.x - midX);
  arrowHead(end.x, end.y, angle);

  const label = edge.when || edge.label || (edge.default ? 'default' : '');
  if (label && view.scale > 0.5) {
    // Graph units, like the node text, so the two stay in proportion at every zoom.
    const text = fitText(label, MAX_WIDTH, EDGE_FONT);
    const width = textWidth(text, EDGE_FONT) + 10;
    const y = (start.y + end.y) / 2 - bow / 2;
    ctx.font = EDGE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = themeColor('--surface-base');
    ctx.fillRect(midX - width / 2, y - 8, width, 16);
    ctx.fillStyle = themeColor(`--edge-${edge.type}`);
    ctx.fillText(text, midX, y);
  }
}

function arrowHead(x, y, angle) {
  const { ctx } = view;
  const size = 9 / view.scale;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - 0.42), y - size * Math.sin(angle - 0.42));
  ctx.lineTo(x - size * Math.cos(angle + 0.42), y - size * Math.sin(angle + 0.42));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

function drawGhostLink() {
  const { ctx } = view;
  const from = view.link.node;
  const target = view.link.over ?? view.link.point;
  const start = anchor(from, target);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = themeColor('--edge-ghost');
  ctx.lineWidth = 2 / view.scale;
  ctx.setLineDash([6 / view.scale, 4 / view.scale]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  arrowHead(target.x, target.y, Math.atan2(target.y - start.y, target.x - start.x));
}

function drawNode(node, focus, errorNodes) {
  const { ctx } = view;
  const model = nodeOf(node.id);
  if (!model) return;
  const width = nodeWidth(node);
  const x = node.x - width / 2;
  const y = node.y - NODE_HEIGHT / 2;
  const selected = selection?.kind === 'node' && selection.id === node.id;
  const accent = themeColor(`--node-${model.type}`) || themeColor('--node-agent');

  ctx.globalAlpha = focus && !selected && focus !== node.id && !isNeighbour(focus, node.id) ? 0.4 : 1;

  // Flat, not raised. The fill matches the canvas so a node reads as a shape drawn
  // on the surface rather than a card floating above it — it still has to be an
  // opaque fill, because that is what hides the edges running underneath.
  roundRect(x, y, width, NODE_HEIGHT, 10);
  ctx.fillStyle = themeColor('--surface-base');
  ctx.fill();

  // A coloured spine rather than a coloured fill: the type stays legible at any
  // zoom without the label having to fight the background for contrast.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 5, NODE_HEIGHT);
  ctx.restore();

  ctx.strokeStyle = errorNodes.has(node.id) ? themeColor('--node-error') : selected ? themeColor('--node-selected') : themeColor('--border');
  ctx.lineWidth = (selected || errorNodes.has(node.id) ? 2 : 1) / view.scale;
  roundRect(x, y, width, NODE_HEIGHT, 10);
  ctx.stroke();

  // Below this zoom the text would render as sub-pixel mush, so it is dropped
  // rather than smeared.
  if (view.scale > 0.35) {
    const inner = width - PAD_X * 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = themeColor('--node-sublabel');
    ctx.font = EYEBROW_FONT;
    ctx.fillText(fitText(nodeTypeLabel(model), inner, EYEBROW_FONT), x + PAD_X, y + 14);
    ctx.fillStyle = themeColor('--node-label');
    ctx.font = TITLE_FONT;
    ctx.fillText(fitText(model.name || model.id, inner, TITLE_FONT), x + PAD_X, y + 31);
  }

  if (node === view.hover || selected) {
    ctx.beginPath();
    ctx.arc(x + width, node.y, 5 / view.scale, 0, Math.PI * 2);
    ctx.fillStyle = themeColor('--edge-ghost');
    ctx.fill();
  }
}

function isNeighbour(focusId, nodeId) {
  return graph.edges.some(edge => (edge.from === focusId && edge.to === nodeId) || (edge.to === focusId && edge.from === nodeId));
}

function roundRect(x, y, width, height, radius) {
  const { ctx } = view;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/* ----------------------------------------------------------- interactions -- */

function pointAt(event) {
  const box = view.canvas.getBoundingClientRect();
  return { x: (event.clientX - box.left - view.tx) / view.scale, y: (event.clientY - box.top - view.ty) / view.scale };
}

function nodeAt(point) {
  // Reverse order so the node painted last — the one visually on top — wins.
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const node = view.nodes[i];
    const halfWidth = nodeWidth(node) / 2;
    if (Math.abs(point.x - node.x) <= halfWidth && Math.abs(point.y - node.y) <= NODE_HEIGHT / 2) return node;
  }
  return null;
}

// Hit testing an edge against its midpoint region: precise enough to pick one line
// out of a bundle, and far cheaper than solving the curve.
function edgeAt(point) {
  let best = null;
  let bestDistance = 14 / view.scale;
  for (const edge of graph.edges) {
    const a = view.index.get(edge.from);
    const b = view.index.get(edge.to);
    if (!a || !b) continue;
    const bow = edge.type === 'feedback' ? 29 : 0;
    const distance = distanceToSegment(point, { x: a.x, y: a.y - bow }, { x: b.x, y: b.y - bow });
    if (distance < bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  }
  return best;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function bindCanvas() {
  const canvas = $('#canvas');
  canvas.style.cursor = 'grab';

  canvas.addEventListener('pointerdown', event => {
    const point = pointAt(event);
    const node = nodeAt(point);
    // Capture keeps a drag alive when the cursor leaves the canvas. It throws if the
    // pointer is no longer active, which must not take the whole gesture down.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* the gesture still works without capture */
    }
    view.moved = 0;

    if (placing) {
      addNode(placing, point);
      setPlacing(null);
      // The matching pointerup would otherwise read as a click on empty canvas and
      // deselect the node that was just placed.
      view.consumeUp = true;
      return;
    }
    if (node && (event.shiftKey || onHandle(node, point))) {
      view.link = { node, point, over: null };
      return;
    }
    if (node) {
      view.drag = { node, dx: node.x - point.x, dy: node.y - point.y };
      view.alpha = 0;
      return;
    }
    view.pan = { x: event.clientX - view.tx, y: event.clientY - view.ty };
  });

  canvas.addEventListener('pointermove', event => {
    const point = pointAt(event);
    if (view.link) {
      view.moved++;
      view.link.point = point;
      const over = nodeAt(point);
      view.link.over = over && over !== view.link.node ? over : null;
      paint();
      return;
    }
    if (view.drag) {
      view.moved++;
      view.drag.node.x = point.x + view.drag.dx;
      view.drag.node.y = point.y + view.drag.dy;
      view.drag.node.pinned = true;
      paint();
      return;
    }
    if (view.pan) {
      view.moved++;
      view.tx = event.clientX - view.pan.x;
      view.ty = event.clientY - view.pan.y;
      paint();
      return;
    }
    const hover = nodeAt(point);
    if (hover !== view.hover) {
      view.hover = hover;
      paint();
    }
    canvas.style.cursor = placing ? 'copy' : hover ? (onHandle(hover, point) ? 'crosshair' : 'move') : 'grab';
  });

  canvas.addEventListener('pointerup', event => {
    const point = pointAt(event);
    const moved = view.moved > 2;

    if (view.consumeUp) {
      view.consumeUp = false;
      return;
    }
    if (view.link) {
      const target = nodeAt(point);
      const source = view.link.node;
      view.link = null;
      if (target && target !== source) connect(source.id, target.id);
      else paint();
      return;
    }
    if (view.drag) {
      const node = view.drag.node;
      view.drag = null;
      if (moved) pinNode(node);
      else select('node', node.id);
      return;
    }
    view.pan = null;
    if (!moved) {
      const edge = edgeAt(point);
      if (edge) select('edge', edgeKey(edge));
      else select(null);
    }
  });

  canvas.addEventListener('pointerleave', () => {
    view.hover = null;
    paint();
  });

  canvas.addEventListener('dblclick', event => {
    const node = nodeAt(pointAt(event));
    if (node) {
      select('node', node.id, { focus: true });
      return;
    }
    addNode('agent', pointAt(event));
  });

  canvas.addEventListener(
    'wheel',
    event => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      const mx = event.clientX - box.left;
      const my = event.clientY - box.top;
      const next = Math.min(2.6, Math.max(0.15, view.scale * Math.exp(-event.deltaY * 0.0015)));
      view.tx = mx - (mx - view.tx) * (next / view.scale);
      view.ty = my - (my - view.ty) * (next / view.scale);
      view.scale = next;
      paint();
    },
    { passive: false },
  );
}

// The connect handle: a small target on the node's right edge, so connecting does
// not require knowing that Shift is the modifier.
function onHandle(node, point) {
  return Math.hypot(point.x - (node.x + nodeWidth(node) / 2), point.y - node.y) < 9 / view.scale;
}

function pinNode(node) {
  mutate(current => {
    current.layout = { ...current.layout, [node.id]: { x: Math.round(node.x * 100) / 100, y: Math.round(node.y * 100) / 100 } };
  });
}

/* ------------------------------------------------------------ graph edits -- */

function freshId(base) {
  const taken = new Set(graph.nodes.map(node => node.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function addNode(type, point) {
  const id = freshId(type);
  const count = graph.nodes.filter(node => node.type === type).length + 1;
  const node = { id, type, name: `${meta.nodeTypes[type].label} ${count}` };
  if (type === 'agent') {
    node.prompt = '';
    node.tools = ['read'];
    node.output = id;
  }
  if (type === 'tool') node.run = '';
  if (type === 'loop') node.maxIterations = 3;
  if (type === 'parallel') node.join = 'all';

  mutate(
    current => {
      current.nodes = [...current.nodes, node];
      current.layout = { ...current.layout, [id]: { x: Math.round(point.x), y: Math.round(point.y) } };
    },
    { rebuild: true },
  );
  select('node', id, { focus: true });
}

function connect(from, to) {
  const exists = graph.edges.some(edge => edge.from === from && edge.to === to && edge.type === edgeType);
  if (exists) {
    toast('Those nodes are already connected that way.');
    paint();
    return;
  }
  const edge = { from, to, type: edgeType };
  if (edgeType === 'branch') edge.when = '';
  mutate(current => {
    current.edges = [...current.edges, edge];
  });
  select('edge', edgeKey(edge));
}

function removeNode(id) {
  mutate(
    current => {
      current.nodes = current.nodes.filter(node => node.id !== id);
      current.edges = current.edges.filter(edge => edge.from !== id && edge.to !== id);
      const layout = { ...current.layout };
      delete layout[id];
      current.layout = layout;
    },
    { rebuild: true },
  );
  select(null);
}

function removeEdge(key) {
  mutate(current => {
    current.edges = current.edges.filter(edge => edgeKey(edge) !== key);
  });
  select(null);
}

function patchNode(id, patch) {
  mutate(current => {
    current.nodes = current.nodes.map(node => (node.id === id ? { ...node, ...patch } : node));
    // Renaming a node has to carry its edges and its saved position with it, or the
    // graph silently loses both.
    if (patch.id && patch.id !== id) {
      current.edges = current.edges.map(edge => ({
        ...edge,
        from: edge.from === id ? patch.id : edge.from,
        to: edge.to === id ? patch.id : edge.to,
      }));
      const layout = { ...current.layout };
      if (layout[id]) {
        layout[patch.id] = layout[id];
        delete layout[id];
      }
      current.layout = layout;
    }
  });
  if (patch.id && patch.id !== id) selection = { kind: 'node', id: patch.id };
}

function patchEdge(key, patch) {
  let next = key;
  mutate(current => {
    current.edges = current.edges.map(edge => {
      if (edgeKey(edge) !== key) return edge;
      const updated = { ...edge, ...patch };
      next = edgeKey(updated);
      return updated;
    });
  });
  selection = { kind: 'edge', id: next };
  drawInspector();
}

function select(kind, id, { focus = false } = {}) {
  selection = kind ? { kind, id } : null;
  drawInspector();
  paint();
  if (focus) setTimeout(() => $('#inspector-body input')?.focus(), 0);
}

/* -------------------------------------------------------------- inspector -- */

function drawInspector() {
  const kindLabel = $('#inspector-kind');
  const body = $('#inspector-body');
  if (!selection) {
    kindLabel.textContent = 'Nothing selected';
    body.innerHTML = `<div class="inspector-empty"><strong>Select a node or an edge</strong><span>Or pick a type from the palette and click the canvas to add one.</span></div>`;
    return;
  }
  if (selection.kind === 'node') {
    const node = nodeOf(selection.id);
    if (!node) return select(null);
    kindLabel.textContent = `${meta.nodeTypes[node.type]?.label ?? node.type} node`;
    body.innerHTML = nodeForm(node);
    bindNodeForm(node);
    return;
  }
  const edge = graph.edges.find(candidate => edgeKey(candidate) === selection.id);
  if (!edge) return select(null);
  kindLabel.textContent = `${meta.edgeTypes[edge.type]?.label ?? edge.type} edge`;
  body.innerHTML = edgeForm(edge);
  bindEdgeForm(edge);
}

const field = (label, control, hint = '') =>
  `<div class="field"><label>${esc(label)}</label>${control}</div>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}`;

const textInput = (name, value, placeholder = '') =>
  `<input data-field="${name}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">`;

const areaInput = (name, value, placeholder = '', tall = false) =>
  `<textarea data-field="${name}" class="${tall ? 'tall' : ''}" placeholder="${esc(placeholder)}" spellcheck="false">${esc(value ?? '')}</textarea>`;

const numberInput = (name, value, placeholder = '') =>
  `<input type="number" min="1" data-field="${name}" value="${value ?? ''}" placeholder="${esc(placeholder)}">`;

const selectInput = (name, value, options) =>
  `<select data-field="${name}">${options
    .map(option => `<option value="${esc(option.value)}" ${option.value === (value ?? '') ? 'selected' : ''}>${esc(option.label)}</option>`)
    .join('')}</select>`;

const checkInput = (name, value, label) =>
  `<label class="chip" style="cursor:pointer"><input type="checkbox" data-field="${name}" ${value ? 'checked' : ''} style="width:auto;margin:0">${esc(label)}</label>`;

function nodeForm(node) {
  const fields = meta.nodeTypes[node.type]?.fields ?? [];
  const parts = [
    field('Id', textInput('id', node.id), 'Used as the agent name in every compiled harness. Lowercase, dashes or underscores.'),
    field(
      'Type',
      selectInput(
        'type',
        node.type,
        Object.entries(meta.nodeTypes).map(([value, info]) => ({ value, label: info.label })),
      ),
    ),
  ];

  if (fields.includes('name')) parts.push(field('Name', textInput('name', node.name, 'What it is called')));
  if (fields.includes('role')) parts.push(field('Role', textInput('role', node.role, 'One line: what this agent is for')));
  if (fields.includes('model')) {
    parts.push(field('Model', textInput('model', node.model, graph.defaults.model), `Blank uses the graph default (${graph.defaults.model}).`));
  }
  if (fields.includes('harness')) {
    parts.push(
      field(
        'Harness',
        selectInput('harness', node.harness ?? '', [
          { value: '', label: `Graph default (${graph.defaults.harness})` },
          ...Object.entries(meta.harnesses).map(([value, info]) => ({ value, label: info.label })),
        ]),
      ),
    );
  }
  if (fields.includes('system')) parts.push(field('System prompt', areaInput('system', node.system, 'Who this agent is. Optional.')));
  if (fields.includes('prompt')) {
    parts.push(field('Prompt', areaInput('prompt', node.prompt, 'What to do. Use {{inputs.task}} and {{other_node}} to pull values in.', true)));
  }
  if (fields.includes('run')) parts.push(field('Command', areaInput('run', node.run, 'npm test')));
  if (fields.includes('mcp')) parts.push(field('MCP tool', textInput('mcp', node.mcp, 'mcp__server__tool')));
  if (fields.includes('tools')) parts.push(field('Tools', toolGrid(node)));
  if (fields.includes('expression')) {
    parts.push(field('Reads', textInput('expression', node.expression, 'review'), 'The output this router branches on.'));
  }
  if (fields.includes('until')) parts.push(field('Exit when', textInput('until', node.until, 'contains(review, "APPROVED")')));
  if (fields.includes('maxIterations')) parts.push(field('Max iterations', numberInput('maxIterations', node.maxIterations, '3')));
  if (fields.includes('join')) {
    parts.push(
      field(
        'Join',
        selectInput('join', node.join ?? 'all', [
          { value: 'all', label: 'Wait for every branch' },
          { value: 'any', label: 'Continue on the first to finish' },
        ]),
      ),
    );
  }
  if (fields.includes('concurrency')) parts.push(field('Concurrency', numberInput('concurrency', node.concurrency, 'unlimited')));
  if (fields.includes('onReject')) {
    parts.push(
      field(
        'If rejected',
        selectInput('onReject', node.onReject ?? 'stop', [
          { value: 'stop', label: 'Stop the run' },
          { value: 'continue', label: 'Skip ahead and carry on' },
        ]),
      ),
    );
  }
  if (fields.includes('maxTurns')) parts.push(field('Max turns', numberInput('maxTurns', node.maxTurns, String(graph.defaults.maxTurns))));
  if (fields.includes('output')) {
    parts.push(field('Produces', textInput('output', node.output, node.id), `Other nodes read it as {{${node.output || node.id}}}.`));
  }
  if (fields.includes('continueOnError'))
    parts.push(`<div class="chip-row">${checkInput('continueOnError', node.continueOnError, 'Keep going if this fails')}</div>`);
  if (fields.includes('description')) parts.push(field('Notes', areaInput('description', node.description, 'Why this step exists')));

  parts.push(`<div class="danger-zone"><button class="btn danger btn-sm" id="delete-node" type="button">Delete node</button></div>`);
  return parts.join('');
}

function toolGrid(node) {
  const granted = new Set(node.tools ?? []);
  const extra = [...granted].filter(tool => !meta.tools.includes(tool));
  return `<div class="tool-grid">${meta.tools
    .map(tool => `<label><input type="checkbox" data-tool="${esc(tool)}" ${granted.has(tool) ? 'checked' : ''}>${esc(tool)}</label>`)
    .join('')}</div>${
    extra.length
      ? `<div class="chip-row" style="margin-top:8px">${extra.map(tool => `<span class="chip">${esc(tool)}<button data-drop-tool="${esc(tool)}" type="button">×</button></span>`).join('')}</div>`
      : ''
  }<input data-add-tool placeholder="Add another tool name…" style="margin-top:8px">`;
}

function bindNodeForm(node) {
  const body = $('#inspector-body');
  body.querySelectorAll('[data-field]').forEach(control => {
    const commit = () => {
      const name = control.dataset.field;
      let value = control.type === 'checkbox' ? control.checked : control.value;
      if (control.type === 'number') value = value === '' ? null : Number(value);
      patchNode(node.id, { [name]: value });
      if (name === 'type' || name === 'id') drawInspector();
    };
    // Text commits on blur, everything else the moment it changes — retyping an id
    // on every keystroke would renumber the node mid-edit.
    if (control.tagName === 'SELECT' || control.type === 'checkbox') control.onchange = commit;
    else control.onchange = commit;
  });

  body.querySelectorAll('[data-tool]').forEach(box => {
    box.onchange = () => {
      const tools = new Set(nodeOf(node.id).tools ?? []);
      if (box.checked) tools.add(box.dataset.tool);
      else tools.delete(box.dataset.tool);
      patchNode(node.id, { tools: [...tools] });
    };
  });
  body.querySelectorAll('[data-drop-tool]').forEach(button => {
    button.onclick = () => {
      patchNode(node.id, { tools: (nodeOf(node.id).tools ?? []).filter(tool => tool !== button.dataset.dropTool) });
      drawInspector();
    };
  });
  const adder = body.querySelector('[data-add-tool]');
  if (adder) {
    adder.onkeydown = event => {
      if (event.key !== 'Enter' || !adder.value.trim()) return;
      event.preventDefault();
      patchNode(node.id, {
        tools: uniqueBy(
          [...(nodeOf(node.id).tools ?? []), adder.value.trim()].map(tool => ({ tool })),
          item => item.tool,
        ).map(item => item.tool),
      });
      drawInspector();
    };
  }
  body.querySelector('#delete-node').onclick = () => removeNode(node.id);
}

function edgeForm(edge) {
  return [
    `<div class="chip-row"><span class="chip">${esc(edge.from)}</span><span class="chip">→</span><span class="chip">${esc(edge.to)}</span></div>`,
    field(
      'Type',
      selectInput(
        'type',
        edge.type,
        Object.entries(meta.edgeTypes).map(([value, info]) => ({ value, label: info.label })),
      ),
    ),
    `<p class="hint">${esc(meta.edgeTypes[edge.type]?.hint ?? '')}</p>`,
    edge.type === 'branch' || edge.type === 'feedback'
      ? field(
          'Condition',
          textInput('when', edge.when, 'contains(review, "APPROVED")'),
          'contains, equals, matches, startswith, endswith, empty — combined with and / or / not.',
        )
      : '',
    edge.type === 'branch' ? `<div class="chip-row">${checkInput('default', edge.default, 'This is the default branch')}</div>` : '',
    field('Label', textInput('label', edge.label, 'Shown on the canvas')),
    `<div class="danger-zone"><button class="btn secondary btn-sm" id="swap-edge" type="button">Reverse direction</button> <button class="btn danger btn-sm" id="delete-edge" type="button">Delete edge</button></div>`,
  ].join('');
}

function bindEdgeForm(edge) {
  const body = $('#inspector-body');
  const key = edgeKey(edge);
  body.querySelectorAll('[data-field]').forEach(control => {
    control.onchange = () => {
      const value = control.type === 'checkbox' ? control.checked : control.value;
      patchEdge(key, { [control.dataset.field]: value });
    };
  });
  body.querySelector('#swap-edge').onclick = () => patchEdge(key, { from: edge.to, to: edge.from });
  body.querySelector('#delete-edge').onclick = () => removeEdge(key);
}

/* ---------------------------------------------------------------- drawers -- */

function openDrawer(title, subtitle, bodyHtml, footHtml = '') {
  drawer = title;
  $('#overlay').innerHTML =
    `<div class="scrim" id="scrim"></div><section class="drawer" role="dialog" aria-modal="true"><div class="drawer-head"><div style="flex:1;min-width:0"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-btn" id="close-drawer" type="button" aria-label="Close"><svg viewBox="0 0 256 256"><line x1="200" y1="56" x2="56" y2="200"></line><line x1="200" y1="200" x2="56" y2="56"></line></svg></button></div><div class="drawer-body" id="drawer-body">${bodyHtml}</div>${footHtml ? `<div class="drawer-foot">${footHtml}</div>` : ''}</section>`;
  $('#scrim').onclick = closeDrawer;
  $('#close-drawer').onclick = closeDrawer;
}

function closeDrawer() {
  drawer = null;
  clearInterval(runPoll);
  runPoll = null;
  $('#overlay').innerHTML = '';
}

/* ---- New graph ---- */

function openNew() {
  openDrawer(
    'New graph',
    'Start from a template that already compiles and runs, or from nothing.',
    `<div class="template-grid"><button class="template-card" data-template=""><strong>Empty graph</strong><small>A blank canvas. You place every node yourself.</small></button>${meta.templates
      .map(
        template =>
          `<button class="template-card" data-template="${esc(template.key)}"><strong>${esc(template.title)}</strong><small>${esc(template.blurb)}</small></button>`,
      )
      .join('')}</div>`,
  );
  document.querySelectorAll('[data-template]').forEach(button => {
    button.onclick = async () => {
      closeDrawer();
      await createGraph(button.dataset.template ? { template: button.dataset.template } : {});
    };
  });
}

/* ---- Graph settings ---- */

function openSettings() {
  openDrawer(
    'Graph settings',
    'Identity, defaults, and the inputs a run is given.',
    `${field('Name', `<input id="g-name" value="${esc(graph.name)}">`)}
     ${field('Id', `<input id="g-id" value="${esc(graph.id)}">`, 'The filename and the compiled command name.')}
     ${field('Description', `<textarea id="g-description">${esc(graph.description)}</textarea>`)}
     <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
       ${field('Default model', `<input id="g-model" value="${esc(graph.defaults.model)}">`)}
       ${field(
         'Default harness',
         `<select id="g-harness">${Object.entries(meta.harnesses)
           .map(([value, info]) => `<option value="${value}" ${value === graph.defaults.harness ? 'selected' : ''}>${esc(info.label)}</option>`)
           .join('')}</select>`,
       )}
     </div>
     ${field('Default max turns', `<input id="g-turns" type="number" min="1" value="${graph.defaults.maxTurns ?? 30}">`)}
     <h3 style="margin:22px 0 10px;font:800 15px var(--font-sans)">Inputs</h3>
     <div id="inputs-list">${graph.inputs.map(inputRow).join('') || '<p class="hint">No inputs. A run will have nothing to work from.</p>'}</div>
     <button class="btn secondary btn-sm" id="add-input" type="button">Add input</button>`,
    `<span class="spacer"></span><button class="btn" id="settings-done" type="button">Done</button>`,
  );

  const commit = () =>
    mutate(current => {
      current.name = $('#g-name').value;
      current.id = $('#g-id').value;
      current.description = $('#g-description').value;
      current.defaults = {
        ...current.defaults,
        model: $('#g-model').value,
        harness: $('#g-harness').value,
        maxTurns: Number($('#g-turns').value) || 30,
      };
    });
  ['#g-name', '#g-id', '#g-description', '#g-model', '#g-harness', '#g-turns'].forEach(selector => {
    $(selector).onchange = commit;
  });

  const bindInputs = () => {
    document.querySelectorAll('[data-input-index]').forEach(control => {
      control.onchange = () => {
        const index = Number(control.dataset.inputIndex);
        const key = control.dataset.inputField;
        const value = control.type === 'checkbox' ? control.checked : control.value;
        mutate(current => {
          current.inputs = current.inputs.map((input, i) => (i === index ? { ...input, [key]: value } : input));
        });
      };
    });
    document.querySelectorAll('[data-drop-input]').forEach(button => {
      button.onclick = () => {
        const index = Number(button.dataset.dropInput);
        mutate(current => {
          current.inputs = current.inputs.filter((input, i) => i !== index);
        });
        redrawInputs();
      };
    });
  };
  const redrawInputs = () => {
    $('#inputs-list').innerHTML = graph.inputs.map(inputRow).join('') || '<p class="hint">No inputs. A run will have nothing to work from.</p>';
    bindInputs();
  };
  bindInputs();

  $('#add-input').onclick = () => {
    mutate(current => {
      current.inputs = [...current.inputs, { id: `input_${current.inputs.length + 1}`, type: 'string' }];
    });
    redrawInputs();
  };
  $('#settings-done').onclick = closeDrawer;
}

function inputRow(input, index) {
  return `<div class="input-row"><div><div class="row2">
    <div class="field"><label>Id</label><input data-input-index="${index}" data-input-field="id" value="${esc(input.id)}"></div>
    <div class="field"><label>Type</label><input data-input-index="${index}" data-input-field="type" value="${esc(input.type ?? 'string')}"></div>
    </div><div class="row2">
    <div class="field"><label>Label</label><input data-input-index="${index}" data-input-field="label" value="${esc(input.label ?? '')}"></div>
    <div class="field"><label>Default</label><input data-input-index="${index}" data-input-field="default" value="${esc(input.default ?? '')}"></div>
    </div><label class="chip" style="cursor:pointer"><input type="checkbox" data-input-index="${index}" data-input-field="required" ${input.required ? 'checked' : ''} style="width:auto;margin:0">required</label>
    </div><button class="btn danger btn-sm" data-drop-input="${index}" type="button">×</button></div>`;
}

/* ---- Source ---- */

let sourceFormat = 'yaml';

async function openSource() {
  await flushSave();
  const preview = await api('/api/preview', { method: 'POST', body: JSON.stringify({ graph }) }).catch(fail);
  if (!preview) return;
  const render = () => {
    const text = sourceFormat === 'yaml' ? preview.yaml : sourceFormat === 'markdown' ? preview.markdown : `${JSON.stringify(graph, null, 2)}\n`;
    $('#drawer-body').innerHTML = `<div class="tabs">${['yaml', 'markdown', 'json']
      .map(format => `<button data-format="${format}" class="${format === sourceFormat ? 'active' : ''}">${format}</button>`)
      .join('')}</div><pre class="source">${esc(text)}</pre>`;
    document.querySelectorAll('[data-format]').forEach(button => {
      button.onclick = () => {
        sourceFormat = button.dataset.format;
        render();
      };
    });
    $('#copy-source').onclick = () => {
      navigator.clipboard.writeText(text).then(() => toast('Copied'));
    };
    $('#download-source').onclick = () => {
      const extension = sourceFormat === 'yaml' ? 'agentgraph.yaml' : sourceFormat === 'markdown' ? 'md' : 'graph.json';
      download(`${graph.id}.${extension}`, text);
    };
  };

  openDrawer(
    'Source',
    'YAML is the file on disk. Markdown is a generated document; JSON is lossless interchange.',
    '',
    `<button class="btn ghost" id="copy-source" type="button">Copy</button><button class="btn ghost" id="download-source" type="button">Download</button><span class="spacer"></span><button class="btn" onclick="void 0" id="source-done" type="button">Done</button>`,
  );
  render();
  $('#source-done').onclick = closeDrawer;
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ---- Export ---- */

let exportTarget = 'claude';

async function openExport() {
  await flushSave();
  openDrawer(
    'Export',
    'Compile this graph into files a harness can run. Nothing is written until you say so.',
    '<p class="hint">Compiling…</p>',
    `<input id="out-dir" placeholder="Output directory (blank writes into the app store)" style="flex:1"><button class="btn" id="write-files" type="button">Write files</button>`,
  );

  const render = async () => {
    $('#drawer-body').innerHTML = `<div class="tabs">${meta.targets
      .map(target => `<button data-target="${esc(target.key)}" class="${target.key === exportTarget ? 'active' : ''}">${esc(target.label)}</button>`)
      .join('')}</div><p class="hint">Compiling…</p>`;
    document.querySelectorAll('[data-target]').forEach(button => {
      button.onclick = () => {
        exportTarget = button.dataset.target;
        render();
      };
    });

    let preview;
    try {
      preview = await api('/api/preview', { method: 'POST', body: JSON.stringify({ graph, target: exportTarget }) });
    } catch (error) {
      $('#drawer-body').insertAdjacentHTML('beforeend', `<p class="hint">${esc(error.message)}</p>`);
      return;
    }
    if (drawer !== 'Export') return;

    const target = meta.targets.find(entry => entry.key === exportTarget);
    if (!preview.bundle) {
      $('#drawer-body').querySelector('.hint').outerHTML =
        `<p class="blurb">${esc(target.blurb)}</p><ul class="notes"><li>This graph has ${preview.validation.errors.length} error(s) and will not compile. Fix them first.</li></ul>`;
      return;
    }
    $('#drawer-body').querySelector('.hint').outerHTML = `<p class="blurb">${esc(target.blurb)}</p><ul class="notes">${preview.bundle.notes
      .map(note => `<li>${esc(note)}</li>`)
      .join('')}</ul><div class="file-tree">${preview.bundle.files
      .map(
        (entry, i) =>
          `<details class="file-entry" ${i === 0 ? 'open' : ''}><summary>${esc(entry.path)}</summary><pre>${esc(entry.contents)}</pre></details>`,
      )
      .join('')}</div>`;
  };

  await render();
  $('#write-files').onclick = async () => {
    try {
      const written = await api('/api/compile', {
        method: 'POST',
        body: JSON.stringify({ graph, target: exportTarget, outDir: $('#out-dir').value }),
      });
      toast(`Wrote ${written.written.length} file(s) to ${written.outDir}`);
    } catch (error) {
      fail(error);
    }
  };
}

/* ---- Run ---- */

function openRun() {
  const inputs = graph.inputs.length
    ? graph.inputs
        .map(
          input =>
            `<div class="field"><label>${esc(input.label || input.id)}${input.required ? ' *' : ''}</label><input data-run-input="${esc(input.id)}" value="${esc(input.default ?? '')}" placeholder="${esc(input.description ?? input.id)}"></div>`,
        )
        .join('')
    : '<p class="hint">This graph declares no inputs.</p>';

  openDrawer(
    'Run',
    'Dry runs render every prompt and print the exact command, without calling a model.',
    `<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
       ${field('Harness', `<select id="run-harness">${meta.runners.map(runner => `<option value="${runner}" ${runner === 'dry' ? 'selected' : ''}>${runner === 'dry' ? 'Dry run (no model call)' : (meta.harnesses[runner]?.label ?? runner)}</option>`).join('')}</select>`)}
       ${field('Working directory', `<input id="run-cwd" value="${esc(meta.cwd)}">`)}
     </div>
     ${inputs}
     <div id="run-console"></div>`,
    `<button class="btn danger btn-sm" id="cancel-run" type="button" hidden>Cancel</button><span class="spacer"></span><button class="btn" id="start-run" type="button">Start run</button>`,
  );

  $('#start-run').onclick = async () => {
    const values = {};
    document.querySelectorAll('[data-run-input]').forEach(control => {
      values[control.dataset.runInput] = control.value;
    });
    try {
      run = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ id: graph.id, graph, harness: $('#run-harness').value, inputs: values, cwd: $('#run-cwd').value }),
      });
      $('#start-run').textContent = 'Run again';
      $('#cancel-run').hidden = false;
      drawRun();
      clearInterval(runPoll);
      runPoll = setInterval(pollRun, 700);
    } catch (error) {
      fail(error);
    }
  };
  $('#cancel-run').onclick = async () => {
    if (run) await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }).catch(fail);
  };
}

async function pollRun() {
  if (!run || drawer !== 'Run') return;
  try {
    run = await api(`/api/runs/${run.id}`);
  } catch {
    clearInterval(runPoll);
    return;
  }
  drawRun();
  if (run.status !== 'running') {
    clearInterval(runPoll);
    runPoll = null;
    $('#cancel-run').hidden = true;
  }
}

function drawRun() {
  const host = $('#run-console');
  if (!host || !run) return;
  const gate = run.gate
    ? `<div class="gate-card"><strong>${esc(run.gate.name)}</strong><p>${esc(run.gate.message || 'Approve to continue.')}</p><div class="actions"><button class="btn light btn-sm" id="gate-approve" type="button">Approve</button><button class="btn danger btn-sm" id="gate-reject" type="button">Reject</button></div></div>`
    : '';
  host.innerHTML = `<div class="run-status"><b class="${esc(run.status)}">${esc(run.status)}</b><span>${run.steps.length} step(s) · ${run.events} event(s) · ${esc(run.harness)}</span></div>${gate}${
    run.error ? `<ul class="notes"><li>${esc(run.error)}</li></ul>` : ''
  }<div class="journal" id="journal">${(run.journal ?? [])
    .map(
      event =>
        `<div class="${esc(event.kind.replace('.', '-'))}"><span class="k">${esc(event.kind)}</span><span class="v">${esc(journalText(event))}</span></div>`,
    )
    .join('')}</div>`;

  const journal = $('#journal');
  if (journal) journal.scrollTop = journal.scrollHeight;

  if (run.gate) {
    const answer = approved => () => {
      api(`/api/runs/${run.id}/gate`, { method: 'POST', body: JSON.stringify({ node: run.gate.id, approved }) })
        .then(pollRun)
        .catch(fail);
    };
    $('#gate-approve').onclick = answer(true);
    $('#gate-reject').onclick = answer(false);
  }
}

function journalText(event) {
  if (event.kind === 'node.start') return `${event.name} (${event.type})`;
  if (event.kind === 'node.done') return event.preview || '(no output)';
  if (event.kind === 'route.taken') return `${event.node} → ${event.to}${event.when ? ` when ${event.when}` : ''}`;
  if (event.kind === 'route.test') return `${event.when} → ${event.result}`;
  if (event.kind === 'loop.rewind') return `back to ${event.to}, round ${event.iteration} of ${event.limit}`;
  if (event.kind === 'loop.exhausted') return `gave up after ${event.iterations} round(s)`;
  if (event.kind === 'gate.waiting') return event.message || event.name;
  if (event.kind === 'template.missing') return `${event.node}.${event.field} wanted {{${event.reference}}}`;
  if (event.kind === 'run.error') return event.message;
  if (event.kind === 'node.skipped') return event.node;
  if (event.kind === 'run.start') return `${event.graph} on ${event.harness}`;
  if (event.kind === 'run.end') return event.status;
  return JSON.stringify(event);
}

/* ---- Import ---- */

function openImport() {
  openDrawer(
    'Import a graph',
    'Paste an .agentgraph.yaml or .graph.json file, or pick one from disk.',
    `${field('File', '<input type="file" id="import-file" accept=".yaml,.yml,.json,.md">')}${field('Or paste it here', '<textarea id="import-text" class="tall" style="min-height:280px;font:12.5px/1.6 var(--font-mono)"></textarea>')}`,
    `<span class="spacer"></span><button class="btn" id="do-import" type="button">Import</button>`,
  );
  $('#import-file').onchange = async event => {
    const file = event.target.files?.[0];
    if (file) $('#import-text').value = await file.text();
  };
  $('#do-import').onclick = async () => {
    const source = $('#import-text').value.trim();
    if (!source) return toast('Nothing to import.');
    try {
      const imported = await api('/api/import', { method: 'POST', body: JSON.stringify({ source }) });
      closeDrawer();
      await refreshLibrary();
      await openGraph(imported.graph.id);
      toast(`Imported ${imported.graph.name}`);
    } catch (error) {
      fail(error);
    }
  };
}

/* ------------------------------------------------------------------ chrome -- */

function bindChrome() {
  $('#new-graph').onclick = openNew;
  $('#import-graph').onclick = openImport;
  $('#open-settings').onclick = openSettings;
  $('#open-source').onclick = openSource;
  $('#open-export').onclick = openExport;
  $('#open-run').onclick = openRun;
  $('#status-pill').onclick = () => $('#issues .issue')?.click();
  $('#fit-view').onclick = fitView;
  $('#auto-layout').onclick = relayout;

  $('#rail-toggle').onclick = () => $('.shell').classList.toggle('rail-collapsed');
  $('#theme-toggle').onclick = () => {
    themeIndex = (themeIndex + 1) % THEMES.length;
    if (THEMES[themeIndex]) document.documentElement.dataset.theme = THEMES[themeIndex];
    else delete document.documentElement.dataset.theme;
  };

  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (drawer) return closeDrawer();
      if (placing) return setPlacing(null);
      return select(null);
    }
    // Never steal a keystroke from a field the user is typing in.
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
      event.preventDefault();
      if (selection.kind === 'node') removeNode(selection.id);
      else removeEdge(selection.id);
    }
    if (event.key === 'f') fitView();
    if ((event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      flushSave().then(() => toast('Saved'));
    }
  });
}

// Throw away every pinned position and re-rank. The escape hatch for a graph that
// has been dragged into an unreadable shape.
function relayout() {
  mutate(
    current => {
      current.layout = {};
    },
    { rebuild: true, fit: true },
  );
  view.alpha = 0;
  const positions = layoutPositions(graph);
  for (const node of view.nodes) Object.assign(node, positions.get(node.id), { pinned: true });
  commitLayout();
  fitView();
}

boot().catch(error => {
  document.body.innerHTML = `<pre class="source" style="margin:40px">Graph Factory could not start.\n\n${esc(error.message)}</pre>`;
});
