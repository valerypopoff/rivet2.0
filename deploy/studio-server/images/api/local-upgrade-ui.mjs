import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

function realDirectory(root) {
  if (!path.isAbsolute(root)) throw new Error('UI control volume must be absolute.');
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UI control volume must be a real directory.');
    if (path.dirname(cursor) === cursor) break;
  }
}
function sync(root) {
  const fd = fs.openSync(root, 'r');
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code))
      throw error;
  } finally {
    fs.closeSync(fd);
  }
}
function configuration(env) {
  if (env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated' || !env.RIVET_LOCAL_METADATA_UI_ROOT) return null;
  if (!path.isAbsolute(env.RIVET_LOCAL_METADATA_UI_ROOT)) throw new Error('UI control volume must be absolute.');
  const volume = path.resolve(env.RIVET_LOCAL_METADATA_UI_ROOT);
  realDirectory(volume);
  const root = path.join(volume, 'ui-managed');
  const file = path.join(root, 'ui-configuration.json');
  let value;
  try {
    realDirectory(root);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw new Error('Invalid private UI configuration.');
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('Private UI configuration is unreadable. Restore it; do not replace its key.');
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(root)) return { root, file, volume, value: null };
    throw error;
  }
  if (
    value.version !== 1 ||
    !['preparing', 'ready'].includes(value.phase) ||
    !/^[a-f0-9]{64}$/.test(value.key) ||
    Object.keys(value).sort().join(',') !== 'key,phase,version'
  )
    throw new Error('Invalid UI configuration.');
  return { root, file, volume, value };
}
function configuredEnvironment(env, config) {
  if (env.RIVET_LOCAL_METADATA_CONTROL_ROOT && path.resolve(env.RIVET_LOCAL_METADATA_CONTROL_ROOT) !== config.root)
    throw new Error('Deployment control root differs from UI-managed storage.');
  if (env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY && env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY !== config.value.key)
    throw new Error('Deployment key differs from UI-managed storage.');
  return {
    ...env,
    RIVET_LOCAL_METADATA_CONTROL_ROOT: config.root,
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: config.value.key,
    RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1',
  };
}
function sentinel(env, config, { create = false, bindingRoot = config.root } = {}) {
  realDirectory(env.RIVET_APP_DATA_ROOT);
  const file = path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-ui-control.json');
  const expected = config.value
    ? JSON.stringify({
        version: 1,
        root: bindingRoot,
        keyId: createHash('sha256').update(config.value.key).digest('hex'),
      })
    : null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || fs.readFileSync(file, 'utf8') !== expected)
      throw new Error('UI control storage is missing or differs from the retained installation.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) {
      if (config.value) throw new Error('UI control storage has lost its independent installation binding.');
      return;
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, expected);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    sync(env.RIVET_APP_DATA_ROOT);
  }
}
export function loadUiUpgradeEnvironment(env) {
  const config = configuration(env);
  if (config) sentinel(env, config);
  if (!config?.value) return env;
  // No serving process can have used this journal before the ready publication.
  // Keep legacy available for an explicit retry using the same retained key.
  if (config.value.phase !== 'ready') return env;
  return configuredEnvironment(env, config);
}
/** Read-only host backup discovery retains the whole volume while validating
 * its nested journal and the original container-path installation binding. */
export function uiUpgradeBackupLayout(volume, appDataRoot) {
  const env = { RIVET_LOCAL_METADATA_UI_ROOT: volume, RIVET_APP_DATA_ROOT: appDataRoot };
  const config = configuration(env);
  if (!config.value && !appDataRoot) return { root: volume };
  sentinel(env, config, { bindingRoot: '/data/local-metadata/ui-managed' });
  if (!config.value) return { root: volume };
  if (config.value.phase !== 'ready') throw new Error('UI control preparation has not completed.');
  return {
    root: config.root,
    encryptionKeyId: createHash('sha256').update(JSON.stringify(config.value.key)).digest('hex'),
  };
}
export function uiPreparationAvailable(env) {
  if (
    env.RIVET_LOCAL_METADATA_CONTROL_ROOT ||
    env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY ||
    !env.RIVET_LOCAL_METADATA_UI_ROOT ||
    env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated'
  )
    return false;
  const config = configuration(env);
  // Never bypass an established/manual journal merely by selecting a new child.
  return fs.readdirSync(config.volume).every((name) => name === 'ui-managed' || name === 'owner-lock.sqlite');
}
function assertOutsideSource(env, volume) {
  const ancestors = (directory) => {
    realDirectory(directory);
    const identities = [];
    for (let cursor = directory; ; cursor = path.dirname(cursor)) {
      const stat = fs.statSync(cursor);
      identities.push(`${stat.dev}:${stat.ino}`);
      if (path.dirname(cursor) === cursor) return identities;
    }
  };
  const control = ancestors(volume);
  for (const name of [
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
  ]) {
    const source = ancestors(env[name]);
    if (control.includes(source[0]) || source.includes(control[0]))
      throw new Error('UI control volume must be outside all retained source roots.');
  }
}
/** Called after both serving children have exited, never by serving startup. */
export async function prepareUiUpgrade(env, command) {
  if (!uiPreparationAvailable(env)) throw new Error('UI preparation requires a fresh or owned control volume.');
  let config = configuration(env);
  assertOutsideSource(env, config.volume);
  if (config.value?.phase === 'ready') return configuredEnvironment(env, config);
  if (!config.value) {
    sentinel(env, config);
    fs.mkdirSync(config.root, { mode: 0o700 });
    sync(config.volume);
    const value = { version: 1, phase: 'preparing', key: randomBytes(32).toString('hex') };
    const fd = fs.openSync(config.file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    sync(config.root);
    config = { ...config, value };
  }
  sentinel(env, config, { create: true });
  const preparedEnv = configuredEnvironment(env, config);
  await new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    const child = spawn(executable, args, { env: preparedEnv, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('UI control provisioning failed.'))));
  });
  const next = `${config.file}.next`;
  const published = JSON.stringify({ ...config.value, phase: 'ready' });
  let fd;
  try {
    fd = fs.openSync(next, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(next);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && stat.mode & 0o077) ||
      fs.readFileSync(next, 'utf8') !== published
    )
      throw new Error('Interrupted UI publication differs from its original configuration.');
    fd = fs.openSync(next, 'r+');
  }
  try {
    if (fs.fstatSync(fd).size === 0) fs.writeFileSync(fd, published);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(next, config.file);
  sync(config.root);
  return loadUiUpgradeEnvironment(env);
}
