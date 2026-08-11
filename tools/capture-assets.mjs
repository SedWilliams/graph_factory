// Regenerates every image in docs/assets from the real editor.
//
// Nothing here is needed to use Graph Factory. It exists so the screenshots in the
// README can never drift from the app: run it and they are rebuilt from a live
// server, a real Chrome, and the graphs the templates actually produce.
//
//   node tools/capture-assets.mjs
//
// Requires Chrome (CHROME=/path/to/chrome to override) and ffmpeg on PATH.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT || 4180);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9222;
const OUT = path.resolve('docs/assets');
const FRAME_MS = 80;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => console.log(`[capture] ${message}`);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find(candidate => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/* ------------------------------------------------------------------ chrome -- */

async function launchChrome(width, height, scale) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME=/path/to/chrome');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-capture-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--force-device-scale-factor=${scale}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      BASE,
    ],
    { stdio: 'ignore' },
  );

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return { child, profile, wsUrl: page.webSocketDebuggerUrl };
    } catch {
      /* still starting */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return { socket, send };
}

/* -------------------------------------------------------------- page verbs -- */

function pageDriver(send) {
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return result.result.value;
  };

  const waitFor = async (expression, label, attempts = 120) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(`!!(${expression})`)) return;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  const click = async selector => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };

  const shot = async () => (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data;

  const viewport = (width, height, deviceScaleFactor) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });

  // The canvas is a canvas: there is no element to click. Rather than trust one
  // hard-coded point, try the known node centres and stop at the first that
  // actually moves the inspector off its empty state.
  const clickCanvas = async point => {
    const [x, y] = point;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(250);
  };

  const selectAnyNode = async candidates => {
    for (const point of candidates) {
      await clickCanvas(point);
      const kind = await evaluate("document.querySelector('#inspector-kind').textContent.trim()");
      if (kind && !/nothing selected/i.test(kind)) return kind;
    }
    console.warn('[capture] no node selected — the inspector stays on its empty state');
    return null;
  };

  // "Saving…" is a real state, but it is not the one to publish a screenshot of.
  const settle = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const pill = await evaluate("document.querySelector('#status-pill').textContent.trim()");
      if (pill && !/saving|loading|…/i.test(pill)) return pill;
      await sleep(200);
    }
    return null;
  };

  return { evaluate, waitFor, click, shot, viewport, clickCanvas, selectAnyNode, settle };
}

/* ------------------------------------------------------------------ frames -- */

async function recorder(page) {
  const frames = [];
  let running = true;
  const pump = (async () => {
    while (running) {
      const started = Date.now();
      try {
        frames.push(await page.shot());
      } catch {
        /* a frame lost to a navigation is not worth failing over */
      }
      const elapsed = Date.now() - started;
      if (elapsed < FRAME_MS) await sleep(FRAME_MS - elapsed);
    }
  })();
  return {
    frames,
    stop: async () => {
      running = false;
      await pump;
      return frames;
    },
  };
}

async function writeGif(frames, name, width) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-frames-'));
  await Promise.all(frames.map((data, i) => fs.writeFile(path.join(dir, `f${String(i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'))));

  const fps = Math.round(1000 / FRAME_MS);
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const palette = path.join(dir, 'palette.png');
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-i',
    path.join(dir, 'f%05d.png'),
    '-vf',
    `${filters},palettegen=stats_mode=diff`,
    palette,
  ]);
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-i',
    path.join(dir, 'f%05d.png'),
    '-i',
    palette,
    '-lavfi',
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    '-loop',
    '0',
    path.join(OUT, name),
  ]);
  await fs.rm(dir, { recursive: true, force: true });
  const { size } = await fs.stat(path.join(OUT, name));
  log(`${name} — ${frames.length} frames, ${(size / 1e6).toFixed(2)} MB`);
}

async function writePng(data, name, width) {
  const raw = path.join(os.tmpdir(), `gf-${Date.now()}.png`);
  await fs.writeFile(raw, Buffer.from(data, 'base64'));
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${width}:-1:flags=lanczos`, path.join(OUT, name)]);
  await fs.rm(raw, { force: true });
  const { size } = await fs.stat(path.join(OUT, name));
  log(`${name} — ${(size / 1e3).toFixed(0)} KB`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))));
  });
}

/* -------------------------------------------------------------- storyboard -- */

// The editor writes a local absolute path into the topbar subtitle. Screenshots are
// published, so it is replaced with the repo-relative form the reader would have.
const MASK_PATH = `
  (() => {
    const subtitle = document.querySelector('#graph-subtitle');
    if (subtitle && subtitle.textContent.trim()) {
      subtitle.textContent = subtitle.textContent.replace(/^.*[\\\\/](?=GraphFactoryData)/, '~/');
    }
    return true;
  })()`;

// Node centres in CSS pixels at a 1440x900 viewport, read off a capture of each
// graph after fit-to-view. Only used as click targets, and every use is verified.
const NODE_POINTS = {
  'parallel-audit': [
    [758, 406],
    [647, 406],
    [647, 314],
    [652, 522],
    [537, 406],
  ],
  'review-until-clean': [
    [689, 418],
    [783, 418],
    [877, 418],
    [548, 418],
  ],
};

async function openTemplate(page, id) {
  await page.waitFor(`document.querySelector('[data-open=${JSON.stringify(id)}]')`, `graph ${id}`);
  await page.click(`[data-open=${JSON.stringify(id)}]`);
  await sleep(600);
  await page.click('#fit-view');
  await sleep(500);
  await page.evaluate(MASK_PATH);
  await page.settle();
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const { child, profile, wsUrl } = await launchChrome(1440, 900, 2);
  const { socket, send } = await connect(wsUrl);
  const page = pageDriver(send);

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE });
    await page.waitFor("document.querySelector('#graph-list .graph-row')", 'the editor to boot');
    await sleep(800);

    /* ---- stills ---- */
    // The hero: a fan-out/fan-in graph with a node selected, so the inspector shows
    // the thing a reader wants to see — where the prompt lives.
    await openTemplate(page, 'parallel-audit');
    const selected = await page.selectAnyNode(NODE_POINTS['parallel-audit']);
    log(`hero inspector shows: ${selected ?? 'nothing'}`);
    await sleep(500);
    await writePng(await page.shot(), 'editor.png', 1800);

    await openTemplate(page, 'review-until-clean');
    await page.click('#open-export');
    await page.waitFor("document.querySelector('.file-tree')", 'the compiled bundle');
    await sleep(700);
    await writePng(await page.shot(), 'export.png', 1800);
    await page.click('#close-drawer');
    await sleep(400);

    await page.click('#open-source');
    await page.waitFor("document.querySelector('pre.source')", 'the YAML source');
    await sleep(600);
    await writePng(await page.shot(), 'source.png', 1800);
    await page.click('#close-drawer');
    await sleep(400);

    // Light theme, on the same graph as the hero: review-until-clean draws a long
    // branch condition that collides with the node downstream of it, and a README
    // is the wrong place to exhibit that.
    await openTemplate(page, 'parallel-audit');
    await page.selectAnyNode(NODE_POINTS['parallel-audit']);
    await sleep(400);
    // The toggle cycles default -> midnight -> light.
    await page.click('#theme-toggle');
    await sleep(300);
    await page.click('#theme-toggle');
    await sleep(700);
    await writePng(await page.shot(), 'editor-light.png', 1800);
    await page.click('#theme-toggle');
    await sleep(600);
    await openTemplate(page, 'review-until-clean');

    /* ---- the demo loop ---- */
    log('recording demo…');
    const rec = await recorder(page);
    await sleep(1400);

    await page.click('#open-source');
    await page.waitFor("document.querySelector('pre.source')", 'the YAML source');
    await sleep(2200);
    await page.evaluate('document.querySelector(\'[data-format="markdown"]\').click()');
    await sleep(1600);
    await page.click('#close-drawer');
    await sleep(700);

    await page.click('#open-export');
    await page.waitFor("document.querySelector('.file-tree')", 'the compiled bundle');
    await sleep(2400);
    await page.evaluate("document.querySelectorAll('.file-tree .file-entry')[1]?.setAttribute('open','')");
    await sleep(1800);
    for (const target of ['codex', 'opencode']) {
      await page.evaluate(`document.querySelector('[data-target="${target}"]').click()`);
      await page.waitFor("document.querySelector('.file-tree')", `the ${target} bundle`);
      await sleep(2000);
    }
    await page.click('#close-drawer');
    await sleep(900);

    await writeGif(await rec.stop(), 'demo.gif', 1000);

    /* ---- social card ---- */
    // GitHub's Open Graph slot is exactly 1280x640; anything else gets letterboxed.
    await page.viewport(1280, 640, 2);
    const card = new URL(`file:///${path.resolve('tools/social-card.html').replace(/\\/g, '/')}`).href;
    await send('Page.navigate', { url: card });
    await page.waitFor("document.querySelector('footer')", 'the social card');
    await sleep(900);
    await writePng(await page.shot(), 'social-card.png', 1280);
  } finally {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    child.kill();
    await sleep(400);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
