import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Graphs are files a developer will want to open, diff, and commit, so the store is
// a plain directory beside the app rather than anything hidden in a user profile.
export const STORE_DIR_NAME = 'GraphFactoryData';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = value => String(value ?? '').trim();

export function resolveAppDir({ projectDir = projectRoot } = {}) {
  return path.resolve(projectDir);
}

export function resolveStoreDir({ env = process.env, ...options } = {}) {
  const override = text(env.GRAPH_FACTORY_HOME);
  return override ? path.resolve(override) : path.join(resolveAppDir(options), STORE_DIR_NAME);
}

export function graphsDir(storeDir) {
  return path.join(storeDir, 'graphs');
}

export function runsDir(storeDir) {
  return path.join(storeDir, 'runs');
}

export function buildsDir(storeDir) {
  return path.join(storeDir, 'builds');
}

export function publicDir() {
  return path.join(resolveAppDir(), 'public');
}

// A read, write, or reveal request may only reach a path the app owns.
export function isInsideDir(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
