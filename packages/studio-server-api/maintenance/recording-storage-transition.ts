import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serveRecordingTransitionGuard } from '../../../deploy/studio-server/scripts/lib/recording-transition-guard.mjs';
import { runManagedGateCommand } from '../../../deploy/studio-server/scripts/lib/managed-gate-command.mjs';
import { settleOwnedCommandTree } from '../../../deploy/studio-server/scripts/lib/owned-command-tree.mjs';
import {
  readRecordingTransitionConfiguration,
  parseRecordingTransitionDatabaseUrl,
  resolveRecordingTransitionBootstrap,
  type RecordingTransitionConfiguration,
  type RecordingProxy,
  type TransitionIdentity,
  type TransitionRun,
} from '../../../deploy/studio-server/scripts/lib/recording-transition-command.mjs';
import { readRecordingRestoreIdentity } from './recording-recompression.js';
import {
  readRecordingStorageConfig,
  recordingStorageIdentity,
  recordingStorageRequiredEncodings,
  withRecordingOperatorLease,
} from './recording-storage-operator.js';
import type { ManagedWorkflowStorageConfig } from '../src/routes/workflows/storage-config.js';

/** Only the journaled release CLI can recover lost storage-transition ownership. */
export function resolveGuardedReleaseCommand(program: string, args: string[]) {
  const entry = fileURLToPath(
    new URL('../../../deploy/studio-server/scripts/deploy-kubernetes-release.mjs', import.meta.url),
  );
  const requested = args[0] && path.resolve(args[0]);
  const samePath =
    process.platform === 'win32' ? requested?.toLowerCase() === entry.toLowerCase() : requested === entry;
  if (!['node', 'node.exe'].includes(path.basename(program).toLowerCase()) || !samePath)
    throw new Error(
      "The recording transition wrapper only supports Node running this checkout's deploy-kubernetes-release.mjs.",
    );
  return { program: process.execPath, args: [entry, ...args.slice(1)] };
}

function proxyConnection(proxy: RecordingProxy, databaseUrl: string) {
  const url = parseRecordingTransitionDatabaseUrl(databaseUrl);
  if (url.hostname !== proxy.databaseHost || Number(url.port || 5432) !== proxy.databasePort)
    throw new Error('The recording proxy does not belong to the configured database.');
  url.hostname = '127.0.0.1';
  url.port = String(proxy.port);
  return { databaseUrl: url.toString(), databaseSslMode: proxy.sslMode };
}

/** Own the pinned proxy until the settings reader, lease and command have closed. */
async function startProxy(proxy: RecordingProxy, signal: AbortSignal, environment: NodeJS.ProcessEnv) {
  if (!proxy.executable)
    throw new Error('Recording database proxy must be materialized before acquiring coordination.');
  const stat = await fs.lstat(proxy.executable);
  if (
    !stat.isFile() ||
    stat.size > 256 * 1024 * 1024 ||
    `sha256:${createHash('sha256')
      .update(await fs.readFile(proxy.executable))
      .digest('hex')}` !== proxy.sha256
  )
    throw new Error('Recording database proxy executable does not match its reviewed checksum.');
  signal.throwIfAborted();
  const child = spawn(
    proxy.executable,
    ['--address=127.0.0.1', `--port=${proxy.port}`, '--structured-logs', proxy.instance],
    {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let ready = false,
    ended = false,
    text = '';
  const lost = new AbortController();
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      lost.abort(new Error('Recording database proxy failed.'));
    });
    child.once('close', () => {
      ended = true;
      lost.abort(new Error('Recording database proxy stopped.'));
      resolve();
    });
  });
  const observe = (data: Buffer) => {
    text = (text + data.toString()).slice(-8192);
    if (text.includes('ready for new connections')) ready = true;
  };
  child.stdout!.on('data', observe);
  child.stderr!.on('data', observe);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (ended || !child.pid) {
        await closed;
        return;
      }
      const confirmed = await settleOwnedCommandTree(child);
      if (!confirmed) throw new Error('Recording database proxy shutdown is unconfirmed.');
      await closed;
    })());
  try {
    const deadline = Date.now() + 30000;
    while (!ready) {
      signal.throwIfAborted();
      if (lost.signal.aborted || Date.now() >= deadline)
        throw new Error('Recording database proxy did not become ready.');
      await delay(20);
    }
    signal.throwIfAborted();
    lost.signal.throwIfAborted();
    return { signal: lost.signal, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Recording proxy preparation and cleanup failed.');
    }
    throw error;
  }
}

/** The caller supervises the action; this owner never releases a still-owned action. */
export async function withRecordingStorageTransition<T>(
  input: {
    identity: TransitionIdentity;
    configuration?: RecordingTransitionConfiguration;
    environment?: NodeJS.ProcessEnv;
    run?: TransitionRun;
    signal?: AbortSignal;
    interrupts?: Pick<EventEmitter, 'on' | 'removeListener'>;
  },
  action: (guard: { guardUrl: string; signal: AbortSignal; requiredEncodings: string[] }) => Promise<T>,
): Promise<T> {
  const interrupts = input.interrupts ?? process;
  const interrupted = new AbortController();
  const stop = () => interrupted.abort(new Error('Recording storage transition was interrupted.'));
  interrupts.on('SIGINT', stop);
  interrupts.on('SIGTERM', stop);
  const signal = input.signal ? AbortSignal.any([input.signal, interrupted.signal]) : interrupted.signal;
  const failures: unknown[] = [];
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  let result!: T;
  try {
    signal.throwIfAborted();
    const bootstrap = input.configuration
      ? await resolveRecordingTransitionBootstrap(input.configuration, {
          run: input.run ?? runManagedGateCommand,
          environment: input.environment,
          signal,
          identity: input.identity,
        })
      : undefined;
    const identity = bootstrap?.identity ?? input.identity;
    signal.throwIfAborted();
    const env = { ...(bootstrap?.environment ?? input.environment ?? process.env) };
    if (bootstrap?.proxy) {
      const connection = proxyConnection(bootstrap.proxy, env.RIVET_APP_SETTINGS_DATABASE_URL!);
      proxy = await startProxy(bootstrap.proxy, signal, input.environment ?? process.env);
      env.RIVET_APP_SETTINGS_DATABASE_URL = connection.databaseUrl;
      env.RIVET_DEPLOYMENT_DATABASE_SSL_MODE = connection.databaseSslMode;
    }
    const active = proxy ? AbortSignal.any([signal, proxy.signal]) : signal;
    active.throwIfAborted();
    const config = await readRecordingStorageConfig(env);
    active.throwIfAborted();
    if (bootstrap && recordingStorageIdentity(config) !== bootstrap.storageIdentity)
      throw new Error('Configured recording storage differs from the reviewed installation.');
    const connection: Pick<ManagedWorkflowStorageConfig, 'databaseUrl' | 'databaseSslMode'> | undefined = bootstrap
      ? bootstrap.proxy
        ? proxyConnection(bootstrap.proxy, config.databaseUrl)
        : {
            databaseUrl: parseRecordingTransitionDatabaseUrl(config.databaseUrl).toString(),
            databaseSslMode: config.databaseSslMode,
          }
      : undefined;
    result = await withRecordingOperatorLease(
      config,
      'transition',
      async (pool, leaseSignal, check, client) => {
        const commandSignal = AbortSignal.any([active, leaseSignal]);
        commandSignal.throwIfAborted();
        if (
          JSON.parse(await readRecordingRestoreIdentity(client)).deployment !==
          `${identity.namespace}/${identity.release}`
        )
          throw new Error('The configured database belongs to another deployment.');
        const requiredEncodings = await recordingStorageRequiredEncodings(pool);
        let finished = false;
        const checked = async () => {
          if (finished) throw new Error('Recording transition is closed.');
          commandSignal.throwIfAborted();
          await check();
          commandSignal.throwIfAborted();
        };
        const guard = await serveRecordingTransitionGuard(checked, {
          protocol: 1,
          ...identity,
          requiredEncodings,
        });
        let pending: Promise<void> | undefined;
        const heartbeat = setInterval(() => {
          pending ??= checked()
            .catch(stop)
            .finally(() => {
              pending = undefined;
            });
        }, 5000);
        heartbeat.unref();
        const errors: unknown[] = [];
        let value!: T;
        try {
          await checked();
          value = await action({ guardUrl: guard.url, signal: commandSignal, requiredEncodings });
          commandSignal.throwIfAborted();
        } catch (error) {
          errors.push(error);
        } finally {
          finished = true;
          clearInterval(heartbeat);
          for (const dispose of [() => pending, () => guard.close()]) {
            try {
              await dispose();
            } catch (error) {
              errors.push(error);
            }
          }
        }
        if (!errors.length) commandSignal.throwIfAborted();
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Recording transition action and cleanup failed.');
        return value;
      },
      connection,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await proxy?.close();
    } catch (error) {
      failures.push(error);
    }
    interrupts.removeListener('SIGINT', stop);
    interrupts.removeListener('SIGTERM', stop);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Recording storage transition and cleanup failed.');
  signal.throwIfAborted();
  return result;
}

async function main() {
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(
      'Hold recording coordination: --context <context> --namespace <namespace> --release <release> [--configuration <private file>] -- node deploy/studio-server/scripts/deploy-kubernetes-release.mjs <arguments>.',
    );
    return;
  }
  const divider = process.argv.indexOf('--');
  if (divider < 0) throw new Error('Explicit identity and a journaled deployment command are required.');
  const { values } = parseArgs({
    args: process.argv.slice(2, divider),
    options: {
      context: { type: 'string' },
      namespace: { type: 'string' },
      release: { type: 'string' },
      configuration: { type: 'string' },
    },
  });
  const { context, namespace, release } = values;
  if (!context || !namespace || !release) throw new Error('An explicit deployment identity is required.');
  const invocation = resolveGuardedReleaseCommand(process.argv[divider + 1]!, process.argv.slice(divider + 2));
  const configuration = values.configuration
    ? await readRecordingTransitionConfiguration(path.resolve(values.configuration))
    : undefined;
  const identity = {
    context,
    namespace,
    release,
    ...(configuration ? { namespaceUid: configuration.identity.namespaceUid } : {}),
  };
  await withRecordingStorageTransition({ identity, configuration }, ({ guardUrl, signal }) =>
    runManagedGateCommand(invocation.program, invocation.args, {
      cwd: process.cwd(),
      signal,
      settleTree: true,
      retainOnFailure: true,
      env: { ...process.env, RIVET_RECORDING_TRANSITION_GUARD: guardUrl },
    }),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main().catch(() => {
    console.error(
      'Guarded transition failed. Inspect private deployment receipts before recovery; no uncertain write was retried.',
    );
    process.exitCode = 1;
  });
