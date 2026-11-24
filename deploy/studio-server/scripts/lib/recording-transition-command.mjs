import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const invalid = () => {
  throw Error('Recording transition configuration is invalid.');
};
const text = (value, max = 8192) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
const validCredential = (value) =>
  typeof value === 'string' && value.length <= 8192 && value.trim().length > 0 && !value.includes('\0');
// Copied Windows environments lose case-insensitive lookup. Match Node's first
// sorted key for reads, and remove every alias when filtering private inputs.
function matchingEnvironmentKeys(environment, name) {
  return process.platform === 'win32'
    ? Object.keys(environment)
        .filter((key) => key.toUpperCase() === name.toUpperCase())
        .sort()
    : [name];
}
function environmentValue(environment, name) {
  const key = matchingEnvironmentKeys(environment, name)[0];
  return key === undefined ? undefined : environment[key];
}
function keys(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}
function secret(value) {
  if (!value || Object.keys(value).length !== 1) invalid();
  if (Object.hasOwn(value, 'value')) {
    keys(value, ['value']);
    if (!validCredential(value.value)) invalid();
  } else if (Object.hasOwn(value, 'environment')) {
    keys(value, ['environment']);
    if (!text(value.environment, 128) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.environment)) invalid();
  } else {
    keys(value, ['kubernetesSecret']);
    keys(value.kubernetesSecret, ['name', 'key']);
    if (
      !text(value.kubernetesSecret.name, 253) ||
      !text(value.kubernetesSecret.key, 253) ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(value.kubernetesSecret.name) ||
      !/^[A-Za-z0-9._-]{1,253}$/.test(value.kubernetesSecret.key)
    )
      invalid();
  }
}

/** Closed installation data, never a command or an arbitrary environment map. */
export function validateRecordingTransitionConfiguration(value, identity) {
  keys(value, ['protocol', 'identity', 'storageIdentity', 'settings'], ['proxy', 'installationReference']);
  keys(value.identity, ['context', 'namespace', 'release', 'namespaceUid']);
  if (value.protocol !== 1 || !text(value.storageIdentity, 64) || !/^[a-f0-9]{64}$/.test(value.storageIdentity))
    invalid();
  if (
    value.installationReference !== undefined &&
    (!text(value.installationReference, 1024) ||
      !/^gs:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_-]+\.json#[1-9][0-9]*$/.test(value.installationReference))
  )
    invalid();
  for (const key of ['context', 'namespace', 'release', 'namespaceUid']) {
    if (!text(value.identity[key], 256) || (identity && value.identity[key] !== identity[key])) invalid();
  }
  keys(value.settings, ['databaseUrl', 'encryptionKey', 'sslMode'], ['previousEncryptionKey']);
  secret(value.settings.databaseUrl);
  secret(value.settings.encryptionKey);
  if (Object.hasOwn(value.settings, 'previousEncryptionKey')) secret(value.settings.previousEncryptionKey);
  if (!['disable', 'require', 'verify-full'].includes(value.settings.sslMode)) invalid();
  if (value.proxy !== undefined) {
    keys(
      value.proxy,
      ['sha256', 'instance', 'port', 'databaseHost', 'databasePort', 'sslMode'],
      ['executable', 'source'],
    );
    if (
      (!value.proxy.executable && !value.proxy.source) ||
      (value.proxy.executable !== undefined &&
        (!text(value.proxy.executable, 1024) || !path.isAbsolute(value.proxy.executable))) ||
      (value.proxy.source !== undefined &&
        (!text(value.proxy.source, 1024) ||
          !/^gs:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_.-]+#[1-9][0-9]*$/.test(value.proxy.source))) ||
      !text(value.proxy.sha256, 71) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.proxy.sha256) ||
      !text(value.proxy.instance, 256) ||
      !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(value.proxy.instance) ||
      !text(value.proxy.databaseHost, 253) ||
      !['disable', 'require', 'verify-full'].includes(value.proxy.sslMode) ||
      ![value.proxy.port, value.proxy.databasePort].every((n) => Number.isInteger(n) && n > 0 && n <= 65535)
    )
      invalid();
  }
  return structuredClone(value);
}

export async function readRecordingTransitionConfiguration(file, identity, expectedDigest) {
  if (!path.isAbsolute(file) || (await fs.realpath(path.dirname(file))) !== path.dirname(file)) invalid();
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.size > 65536n) invalid();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.size > 65536n ||
      (process.platform !== 'win32' && ((opened.mode & 0o077n) !== 0n || opened.uid !== BigInt(process.getuid())))
    )
      invalid();
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (
      bytes.length > 65536 ||
      (expectedDigest !== undefined && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expectedDigest)
    )
      invalid();
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    return validateRecordingTransitionConfiguration(value, identity);
  } finally {
    await handle.close();
  }
}

/** pg gives host/port query parameters precedence over the URL authority. */
export function parseRecordingTransitionDatabaseUrl(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw Error('Recording transition database address is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw Error('Recording transition database address is invalid.');
  if (!url.hostname || [...url.searchParams.keys()].some((key) => ['host', 'port'].includes(key.toLowerCase())))
    throw Error('Recording transition database address must use its URL host and port.');
  if (!url.pathname || url.pathname === '/')
    throw Error('Recording transition database address must name its database in the URL path.');
  url.port ||= '5432'; // Never inherit a different target from the operator's PGPORT.
  return url;
}

export async function resolveRecordingTransitionBootstrap(
  configuration,
  { run, environment = process.env, signal, identity } = {},
) {
  const config = validateRecordingTransitionConfiguration(configuration, identity);
  const cache = new Map();
  async function resolve(reference) {
    signal?.throwIfAborted();
    let value;
    if (Object.hasOwn(reference, 'value')) value = reference.value;
    else if (Object.hasOwn(reference, 'environment')) value = environmentValue(environment, reference.environment);
    else {
      const { name, key } = reference.kubernetesSecret;
      if (!cache.has(name)) {
        const result = await run(
          environmentValue(environment, 'RIVET_K8S_KUBECTL_BIN') || 'kubectl',
          [
            '--context',
            config.identity.context,
            '--namespace',
            config.identity.namespace,
            '--request-timeout=30s',
            'get',
            'secret',
            name,
            '-o',
            'json',
          ],
          { capture: true, signal, env: environment, settleTree: true },
        );
        try {
          cache.set(name, JSON.parse(result.stdout));
        } catch {
          throw Error('Recording transition credential response is invalid.');
        }
      }
      const encoded = cache.get(name)?.data?.[key];
      if (typeof encoded !== 'string' || encoded.length > 32768 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw Error('Recording transition credential is unavailable.');
      value = Buffer.from(encoded, 'base64').toString('utf8');
    }
    if (!validCredential(value)) throw Error('Recording transition credential is unavailable or invalid.');
    return value.trim();
  }
  const databaseUrl = parseRecordingTransitionDatabaseUrl(await resolve(config.settings.databaseUrl)).toString();
  return {
    identity: config.identity,
    storageIdentity: config.storageIdentity,
    proxy: config.proxy,
    environment: {
      RIVET_APP_SETTINGS_BACKEND: 'postgres',
      RIVET_APP_SETTINGS_DATABASE_URL: databaseUrl,
      RIVET_DEPLOYMENT_DATABASE_SSL_MODE: config.settings.sslMode,
      RIVET_APP_SETTINGS_ENCRYPTION_KEY: await resolve(config.settings.encryptionKey),
      ...(config.settings.previousEncryptionKey
        ? { RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS: await resolve(config.settings.previousEncryptionKey) }
        : {}),
    },
  };
}

async function loadTransition(root) {
  const requireApi = createRequire(path.join(root, 'packages/studio-server-api/package.json'));
  const { tsImport } = await import(pathToFileURL(requireApi.resolve('tsx/esm/api')).href);
  return tsImport(
    pathToFileURL(path.join(root, 'packages/studio-server-api/maintenance/recording-storage-transition.ts')).href,
    import.meta.url,
  );
}

/** The qualified CLI remains the compatibility authority. No failed guard falls back. */
export async function runRecordingTransitionCommand({
  root,
  program,
  args,
  options = {},
  identity,
  required = false,
  configurationFile = environmentValue(options.env ?? process.env, 'RIVET_RECORDING_TRANSITION_CONFIGURATION'),
  run,
  load = loadTransition,
}) {
  root = path.resolve(root);
  const entry = path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs');
  const physical = await fs.realpath(root);
  const sameRoot = process.platform === 'win32' ? physical.toLowerCase() === root.toLowerCase() : physical === root;
  if (program !== process.execPath || args[0] !== entry || !sameRoot)
    throw Error('Recording transition command must use the exact qualified checkout.');
  for (const [flag, key] of [
    ['--context', 'context'],
    ['--namespace', 'namespace'],
    ['--release', 'release'],
  ]) {
    if (args.filter((arg) => arg === flag).length !== 1 || args[args.indexOf(flag) + 1] !== identity[key])
      throw Error('Recording transition command installation does not match.');
  }
  const env = { ...(options.env ?? process.env) };
  for (const name of ['RIVET_RECORDING_TRANSITION_GUARD', 'RIVET_RECORDING_TRANSITION_CONFIGURATION'])
    for (const key of matchingEnvironmentKeys(env, name)) delete env[key];
  if (!configurationFile) {
    if (required)
      throw Error('This release requires protected recording transition configuration. No deployment was started.');
    return run(program, args, { ...options, cwd: root, env });
  }
  if (
    args.filter((arg) => arg === '--artifacts').length !== 1 ||
    !text(args[args.indexOf('--artifacts') + 1]) ||
    args[args.indexOf('--artifacts') + 1].startsWith('--')
  )
    throw Error('Recording transition command requires one evidence directory.');
  const artifacts = path.resolve(root, args[args.indexOf('--artifacts') + 1]);
  const within = path.relative(root, artifacts);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
    throw Error('Recording transition evidence must remain in the qualified checkout.');
  const relative = path.relative(artifacts, configurationFile);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw Error('Recording transition credentials cannot be archived with deployment receipts.');
  const configuration = await readRecordingTransitionConfiguration(
    configurationFile,
    identity,
    environmentValue(options.env ?? process.env, 'RIVET_RECORDING_TRANSITION_CONFIGURATION_SHA256'),
  );
  for (const reference of Object.values(configuration.settings)) {
    if (reference && typeof reference === 'object' && reference.environment)
      for (const key of matchingEnvironmentKeys(env, reference.environment)) delete env[key];
  }
  const { withRecordingStorageTransition } = await load(root);
  if (typeof withRecordingStorageTransition !== 'function')
    throw Error('The qualified tooling predates hosted recording coordination. Select repaired qualified tooling.');
  // Only non-secret binding data is retained. Never persist the guard or resolved credentials.
  const binding = createHash('sha256')
    .update(
      JSON.stringify({ identity, storageIdentity: configuration.storageIdentity, proxy: configuration.proxy ?? null }),
    )
    .digest('hex');
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const actualArtifacts = await fs.realpath(artifacts);
  if (
    process.platform === 'win32'
      ? actualArtifacts.toLowerCase() !== artifacts.toLowerCase()
      : actualArtifacts !== artifacts
  )
    throw Error('Recording transition evidence directory was redirected.');
  const audit = await fs.open(path.join(artifacts, 'recording-transition.json'), 'wx', 0o600);
  const receipt = {
    protocol: 1,
    identity,
    configurationBinding: binding,
    installationReference: configuration.installationReference,
    startedAt: new Date().toISOString(),
    guardPrepared: false,
    commandInvoked: false,
    completed: false,
    requiredEncodings: [],
  };
  const failures = [];
  let result;
  try {
    result = await withRecordingStorageTransition(
      { identity, configuration, run, environment: options.env ?? process.env, signal: options.signal },
      async ({ guardUrl, signal, requiredEncodings }) => {
        receipt.guardPrepared = true;
        receipt.requiredEncodings = requiredEncodings;
        // The CLI archives its attempt before mutation. Preserve this reviewed
        // binding there even if the controller dies before writing the outcome.
        await fs.writeFile(path.join(artifacts, 'recording-transition-intent.json'), JSON.stringify(receipt), {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        receipt.commandInvoked = true;
        const command = await run(program, args, {
          ...options,
          cwd: root,
          env: { ...env, RIVET_RECORDING_TRANSITION_GUARD: guardUrl },
          signal,
          settleTree: true,
          retainOnFailure: true,
        });
        if (command.exitCode !== 0) throw Error('Guarded release command did not complete successfully.');
        return command;
      },
    );
    receipt.completed = true;
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await audit.writeFile(JSON.stringify({ ...receipt, settledAt: new Date().toISOString() }));
    } catch (error) {
      failures.push(error);
    }
    try {
      await audit.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Recording transition failed and private evidence could not be completed.');
  return { ...result, recordingTransitionBinding: binding };
}
