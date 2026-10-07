import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
      throw new Error('Private UI configuration is unreadable. Restore the original record; do not replace it.');
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(root)) return { root, file, volume, value: null };
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid UI configuration.');
  const legacy =
    value.version === 1 &&
    /^[a-f0-9]{64}$/.test(value.key) &&
    Object.keys(value).sort().join(',') === 'key,phase,version';
  const plaintext =
    value.version === 2 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.installationId) &&
    Object.keys(value).sort().join(',') === 'installationId,phase,version';
  if ((!legacy && !plaintext) || !['preparing', 'ready', ...(plaintext ? ['initializing'] : [])].includes(value.phase))
    throw new Error('Invalid UI configuration.');
  return { root, file, volume, value };
}
function configuredEnvironment(env, config) {
  if (env.RIVET_LOCAL_METADATA_CONTROL_ROOT && path.resolve(env.RIVET_LOCAL_METADATA_CONTROL_ROOT) !== config.root)
    throw new Error('Deployment control root differs from UI-managed storage.');
  if (
    config.value.version === 1 &&
    env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY &&
    env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY !== config.value.key
  )
    throw new Error('Deployment key differs from UI-managed storage.');
  return {
    ...env,
    RIVET_LOCAL_METADATA_CONTROL_ROOT: config.root,
    // Retain old generated keys only for decoding existing encrypted databases.
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: config.value.version === 1 ? config.value.key : '',
    RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1',
  };
}
function sentinel(env, config, { create = false, bindingRoot = config.root } = {}) {
  realDirectory(env.RIVET_APP_DATA_ROOT);
  const file = path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-ui-control.json');
  const expected = config.value
    ? JSON.stringify({
        version: config.value.version,
        root: bindingRoot,
        ...(config.value.version === 1
          ? { keyId: createHash('sha256').update(config.value.key).digest('hex') }
          : { installationId: config.value.installationId }),
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
  if (config && !config.value) {
    const binding = readManualBinding(config.volume);
    const retainedRoot =
      binding?.root ||
      env.RIVET_LOCAL_METADATA_CONTROL_ROOT ||
      (fs.existsSync(path.join(config.volume, 'transition.sqlite')) ||
      fs.existsSync(path.join(config.volume, 'upgrade.sqlite'))
        ? config.volume
        : undefined);
    manualSentinel(env, retainedRoot, { required: !!binding });
    sentinel(env, config);
    if (
      binding &&
      env.RIVET_LOCAL_METADATA_CONTROL_ROOT &&
      path.resolve(env.RIVET_LOCAL_METADATA_CONTROL_ROOT) !== binding.root
    )
      throw new Error('Deployment root differs from the retained manual control binding.');
    // Missing/damaged journals remain startup errors, never fresh provisioning.
    return {
      ...env,
      ...(retainedRoot ? { RIVET_LOCAL_METADATA_CONTROL_ROOT: retainedRoot } : {}),
      RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1',
    };
  }
  if (config) sentinel(env, config);
  if (!config?.value) return { ...env, RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1' };
  // Validate retained ownership even before publication. An incomplete record
  // must not permit a conflicting deployment root/key to launch another backend.
  const configured = configuredEnvironment(env, config);
  // No serving process can have used this journal before ready publication.
  // Legacy preparation permits an explicit retry; fresh initialization is
  // intercepted by initializeNewLocalStorage and must finish before serving.
  if (config.value.phase !== 'ready') return env;
  return configured;
}

function manualSentinel(
  env,
  root,
  { create = false, required = false, bindingRoot = root ? path.resolve(root) : null } = {},
) {
  realDirectory(env.RIVET_APP_DATA_ROOT);
  const file = path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-manual-control.json');
  const expected = bindingRoot ? JSON.stringify({ version: 1, root: bindingRoot }) : null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || fs.readFileSync(file, 'utf8') !== expected)
      throw new Error('Manual control storage is missing or differs from the retained installation.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) {
      if (required) throw new Error('Manual control storage has lost its independent App Data binding.');
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

function readManualBinding(volume, { checkDirectory = true } = {}) {
  const file = path.join(volume, 'manual-control.json');
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw new Error('Manual control binding is invalid.');
    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('Manual control binding is unreadable.');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.version !== 1 ||
      Object.keys(value).sort().join(',') !== 'root,version' ||
      typeof value.root !== 'string' ||
      !path.isAbsolute(value.root)
    )
      throw new Error('Manual control binding is invalid.');
    if (checkDirectory) realDirectory(value.root);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(file)) return null;
    throw error;
  }
}

/** Record an already validated manual root while the supervisor owns its lease.
 * Never provision or move the journal. The App Data binding is control metadata,
 * excluded from the frozen business-data fingerprint, just like the UI binding. */
export function rememberManualControlRoot(env) {
  const config = configuration(env);
  if (!config || config.value || !env.RIVET_LOCAL_METADATA_CONTROL_ROOT) return;
  assertOutsideSource(env, config.volume);
  const root = path.resolve(env.RIVET_LOCAL_METADATA_CONTROL_ROOT);
  const existing = readManualBinding(config.volume);
  if (existing) {
    if (existing.root !== root) throw new Error('Manual control root changed.');
    manualSentinel(env, root, { required: true });
    return;
  }
  // The independent binding is durable first: a crash must never publish a
  // pointer whose missing App Data identity can later be silently recreated.
  manualSentinel(env, root, { create: true });
  const file = path.join(config.volume, 'manual-control.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, root }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  sync(config.volume);
}
/** Read-only host backup discovery retains the whole volume while validating
 * its nested journal and the original container-path installation binding. */
export function uiUpgradeBackupLayout(volume, appDataRoot) {
  const env = { RIVET_LOCAL_METADATA_UI_ROOT: volume, RIVET_APP_DATA_ROOT: appDataRoot };
  const config = configuration(env);
  if (!config.value) {
    const binding = readManualBinding(volume, { checkDirectory: false });
    if (!appDataRoot) {
      if (binding) throw new Error('Manual control backup requires its independent App Data binding.');
      return { root: volume };
    }
    sentinel(env, config);
    // These offline copies are outside the original container. Validate the
    // retained logical identity without opening an unrelated live host path.
    if (binding && binding.root !== '/data/local-metadata')
      throw new Error('Custom control backup requires an explicit administrator restore layout.');
    manualSentinel(env, null, { required: !!binding, bindingRoot: binding?.root || null });
    return { root: volume };
  }
  sentinel(env, config, { bindingRoot: '/data/local-metadata/ui-managed' });
  if (config.value.phase !== 'ready') throw new Error('UI control preparation has not completed.');
  return {
    root: config.root,
    ...(config.value.version === 1
      ? { encryptionKeyId: createHash('sha256').update(JSON.stringify(config.value.key)).digest('hex') }
      : {}),
  };
}
export function uiPreparationAvailable(env) {
  if (
    env.RIVET_LOCAL_METADATA_CONTROL_ROOT ||
    !env.RIVET_LOCAL_METADATA_UI_ROOT ||
    env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated'
  )
    return false;
  const config = configuration(env);
  // Never bypass an established/manual journal merely by selecting a new child.
  if (!config.value && fs.existsSync(path.join(env.RIVET_APP_DATA_ROOT, 'local-metadata-manual-control.json')))
    return false;
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
/** Called only while both serving children are stopped, including first start. */
export async function prepareUiUpgrade(env, command, { fresh = false, signal, shutdownTimeoutMs = 130_000 } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000)
    throw new Error('Offline setup shutdown timeout must be a positive duration.');
  if (!uiPreparationAvailable(env)) throw new Error('UI preparation requires a fresh or owned control volume.');
  let config = configuration(env);
  assertOutsideSource(env, config.volume);
  if (config.value?.phase === 'ready') return configuredEnvironment(env, config);
  if (config.value && (config.value.phase === 'initializing') !== fresh)
    throw new Error('Fresh initialization and legacy provisioning cannot replace each other.');
  if (!config.value) {
    sentinel(env, config);
    fs.mkdirSync(config.root, { mode: 0o700 });
    sync(config.volume);
    const value = { version: 2, phase: fresh ? 'initializing' : 'preparing', installationId: randomUUID() };
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
    let error;
    let shutdownTimer;
    const cancel = () => {
      child.kill('SIGTERM');
      shutdownTimer = setTimeout(() => child.kill('SIGKILL'), shutdownTimeoutMs);
      shutdownTimer.unref();
    };
    // Wait for close even on cancellation/error: callers hold the storage
    // lease and must not release it while an offline writer is still alive.
    child.once('error', (failure) => {
      error = failure;
    });
    child.once('close', (code) => {
      clearTimeout(shutdownTimer);
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else if (code === 0) resolve();
      else reject(new Error('UI control provisioning failed.'));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  signal?.throwIfAborted();
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
      !published.startsWith(fs.readFileSync(next, 'utf8'))
    )
      throw new Error('Interrupted UI publication differs from its original configuration.');
    fd = fs.openSync(next, 'r+');
  }
  try {
    // Only a matching prefix of this identity's ready record can be resumed.
    // Exclusive creation or a short write may leave an empty/partial file.
    if (fs.fstatSync(fd).size < Buffer.byteLength(published)) fs.writeFileSync(fd, published);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(next, config.file);
  sync(config.root);
  return loadUiUpgradeEnvironment(env);
}

/** Run before either serving child starts, under the reserved-volume lease.
 * Any retained source entry means legacy, including empty folders and settings.
 * An interrupted fresh initialization is retried, never served as legacy. */
export async function initializeNewLocalStorage(env, command, options = {}) {
  options.signal?.throwIfAborted();
  const loaded = loadUiUpgradeEnvironment(env);
  const config = configuration(env);
  // Once initialization begins, unavailable preparation is a startup error,
  // not permission to serve the source as legacy. Preserve the owned identity.
  if (config?.value?.phase === 'initializing') return prepareUiUpgrade(env, command, { ...options, fresh: true });
  if (!uiPreparationAvailable(loaded)) return loaded;
  if (config.value) return loaded;
  if (
    (env.RIVET_WORKFLOW_STORAGE_BACKEND && env.RIVET_WORKFLOW_STORAGE_BACKEND !== 'filesystem') ||
    (env.RIVET_DEPLOYMENT_STORAGE_MODE && env.RIVET_DEPLOYMENT_STORAGE_MODE !== 'filesystem')
  )
    return loaded;
  assertOutsideSource(env, config.volume);
  for (const name of [
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
  ]) {
    realDirectory(env[name]);
    if (fs.readdirSync(env[name]).length) return loaded;
  }
  console.log('[backend-supervisor] Initializing empty local installation with SQLite metadata and file artifacts.');
  return prepareUiUpgrade(env, command, { ...options, fresh: true });
}
