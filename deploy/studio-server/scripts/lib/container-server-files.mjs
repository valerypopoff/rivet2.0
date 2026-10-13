import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Private deployment state must not follow links into another installation. */
export function ensureContainerStateDirectory(root, project) {
  let current = root;
  for (const name of ['.data', 'container-server', project]) {
    current = path.join(current, name);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const entry = fs.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Container state must use ordinary directories.');
    // Also flush on retry: a predecessor may have created the directory but
    // failed before acknowledging its parent-directory sync.
    syncDirectory(path.dirname(current));
    if (name !== '.data' && process.platform !== 'win32') fs.chmodSync(current, 0o700);
  }
  return current;
}

/** Missing state is distinct from a linked, corrupt or unreadable receipt. */
export function readContainerState(file) {
  let entry;
  try {
    entry = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Container state must use ordinary files.');
  return fs.readFileSync(file, 'utf8');
}

/** Publish a complete, private receipt/configuration, never a truncated overwrite. */
export function writeContainerState(file, contents) {
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Container state must use ordinary files.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, contents, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function containerProcessEnvironment(source) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => {
        const normalized = key.toUpperCase();
        return normalized !== 'NODE_OPTIONS' && !normalized.startsWith('RIVET_') && !normalized.startsWith('COMPOSE_');
      }),
    ),
    COMPOSE_DISABLE_ENV_FILE: 'true',
  };
}
