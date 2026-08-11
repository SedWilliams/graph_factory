import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveStoreDir, graphsDir } from './app_paths.mjs';

// `npm start`: make sure the store exists, bring the server up in this process, and
// put the editor on screen. Nothing here is required for the CLI or the server —
// it only exists so opening the app is one command.

const storeDir = resolveStoreDir();
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const url = `http://${host}:${port}`;
const log = message => console.log(`[graph factory] ${message}`);

function openBrowserCommand(target, platform = process.platform) {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] };
  if (platform === 'darwin') return { command: 'open', args: [target] };
  return { command: 'xdg-open', args: [target] };
}

async function waitForServer(target, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if ((await fetch(`${target}/api/meta`)).ok) return true;
    } catch {
      /* still starting */
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

await fs.mkdir(graphsDir(storeDir), { recursive: true });
log(`Graphs in ${graphsDir(storeDir)}`);

await import('./server.mjs');

if (process.env.GRAPH_FACTORY_NO_BROWSER === '1') {
  log(`Open ${url} in your browser.`);
} else if (await waitForServer(url)) {
  const { command, args } = openBrowserCommand(url);
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log(`Opened ${url}`);
  } catch (error) {
    log(`Could not open a browser (${error.message}). Open ${url} yourself.`);
  }
} else {
  log(`The server did not come up in time. Try ${url} anyway.`);
}
