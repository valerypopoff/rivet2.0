import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

type AsyncWorkflowOptions = {
  liveExecutionPolicy?: boolean;
  resourceMonitoring?: boolean;
  maxActiveRuns?: number;
  httpEchoUrl?: string;
  recordingDurability?: boolean;
  holdRecordingWork?: boolean;
  endpointName?: string;
  projectName?: string;
  graceSeconds?: number;
  storage?: Record<string, unknown>;
  failure?: 'foreground' | 'serialization';
  requireUiAuth?: boolean;
  costProviderUrl?: string;
  projectPayloadBytes?: number;
  workflowMaintenance?: boolean;
};
type AsyncWorkflowProcess = {
  baseUrl: string;
  projectId: string;
  projectPath: string;
  root: string;
  command<T = unknown>(name: string): Promise<T>;
  exited: Promise<number | null>;
  logs: string;
  restart(): Promise<AsyncWorkflowProcess>;
  persistedMetadata(): Promise<Record<string, any>[]>;
  close(): Promise<void>;
};
export async function startAsyncWorkflowProcess(options: AsyncWorkflowOptions = {}) {
  const maxActiveRuns = options.maxActiveRuns ?? 4;
  if (!Number.isInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 32)
    throw Error('Invalid fixture concurrency');
  const projectBytes = options.projectPayloadBytes ?? 0;
  if (!Number.isInteger(projectBytes) || projectBytes < 0 || projectBytes > 1024 * 1024)
    throw Error('Invalid fixture project size');
  if (options.httpEchoUrl) {
    const target = new URL(options.httpEchoUrl);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw Error('The echo fixture must be local');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-async-acceptance-'));
  return startOwnedProcess(root, options, false);
}

/** Restart only a root created by this harness; never accept arbitrary host paths. */
async function startOwnedProcess(
  root: string,
  options: AsyncWorkflowOptions,
  resume: boolean,
): Promise<AsyncWorkflowProcess> {
  const maxActiveRuns = options.maxActiveRuns ?? 4;
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_')));
  Object.assign(env, {
    PORT: String(port),
    DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
    RIVET_ASYNC_TEST_ROOT: root,
    ...(resume ? { RIVET_ASYNC_TEST_RESUME: '1' } : {}),
    RIVET_APP_DATA_ROOT: path.join(root, 'app'),
    RIVET_WORKSPACE_ROOT: root,
    RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
    RIVET_PROJECT_BUNDLE_SCRATCH_ROOT: path.join(root, 'exports'),
    RIVET_KEY: 'async-fixture-key',
    RIVET_REQUIRE_UI_GATE_KEY: options.requireUiAuth ? 'true' : 'false',
    RIVET_SERVER_UI_AUTH_MODE: options.requireUiAuth ? 'key' : 'none',
    RIVET_ENABLE_DEVELOPMENT_AUTH: 'false',
    RIVET_API_PROFILE: 'combined',
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDING_DURABILITY_ENABLED: options.recordingDurability ? 'true' : 'false',
    ...(options.workflowMaintenance === false ? { RIVET_MANAGED_MAINTENANCE_ENABLED: 'false' } : {}),
    ...(options.holdRecordingWork ? { RIVET_ASYNC_TEST_HOLD_RECORDING_WORK: 'true' } : {}),
    RIVET_SHUTDOWN_GRACE_SECONDS: String(options.graceSeconds ?? 2),
    RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'enforce',
    RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS: String(maxActiveRuns),
    ...(options.liveExecutionPolicy || options.resourceMonitoring
      ? {
          RIVET_LEGACY_RESTORE_INSTALLATION: 'fixture/async',
          RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_DEFAULTS: JSON.stringify({
            mode: 'enforce',
            maxActiveRunsPerPod: maxActiveRuns,
          }),
        }
      : {}),
    ...(options.resourceMonitoring
      ? {
          RIVET_DEPLOYMENT_RESOURCE_MONITORING: JSON.stringify({
            enabled: true,
            containerized: false,
            name: 'fixture',
            reportUrl: `http://127.0.0.1:${port}/internal/resource-monitoring`,
          }),
        }
      : {}),
    ...(options.httpEchoUrl ? { RIVET_ASYNC_TEST_HTTP_ECHO_URL: options.httpEchoUrl } : {}),
    ...(options.storage ? { RIVET_ASYNC_TEST_STORAGE: JSON.stringify(options.storage) } : {}),
    ...(options.endpointName ? { RIVET_ASYNC_TEST_ENDPOINT_NAME: options.endpointName } : {}),
    ...(options.projectName ? { RIVET_ASYNC_TEST_PROJECT_NAME: options.projectName } : {}),
    ...(options.failure ? { RIVET_ASYNC_TEST_FAILURE: options.failure } : {}),
    ...(options.costProviderUrl ? { RIVET_ASYNC_TEST_COST_PROVIDER_URL: options.costProviderUrl } : {}),
    ...(options.projectPayloadBytes !== undefined
      ? { RIVET_ASYNC_TEST_PROJECT_BYTES: String(options.projectPayloadBytes) }
      : {}),
  });
  const child = fork(new URL('./workflow-async-server.mts', import.meta.url), [], {
    env,
    execArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
    silent: true,
  });
  let logs = '';
  child.stdout!.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    logs += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  child.on('message', (message: { id: number; error?: string; result?: unknown }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  child.once('exit', () => {
    for (const request of pending.values()) request.reject(new Error(`API exited\n${logs}`));
    pending.clear();
  });
  const command = async <T = unknown>(name: string): Promise<T> => {
    const id = nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${name}\n${logs}`));
      }, 10_000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
      const fail = (error: Error | null) => {
        if (error) {
          const request = pending.get(id);
          pending.delete(id);
          request?.reject(error);
        }
      };
      try {
        child.send({ id, command: name }, fail);
      } catch (error) {
        fail(error as Error);
      }
    });
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await command('shutdown').catch(() => undefined);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
  try {
    const info = await new Promise<{ baseUrl: string; projectId: string; projectPath: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`API startup timeout\n${logs}`)), 45_000);
      child.on('message', (message: { ready?: { baseUrl: string; projectId: string; projectPath: string } }) => {
        if (message.ready) {
          clearTimeout(timeout);
          resolve(message.ready);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (exitCode, signalCode) => {
        clearTimeout(timeout);
        reject(Object.assign(new Error(`API exited during startup\n${logs}`), { exitCode, signalCode }));
      });
    });
    return {
      ...info,
      root,
      command,
      exited,
      async restart() {
        await stop();
        return startOwnedProcess(root, options, true);
      },
      get logs() {
        return logs;
      },
      async persistedMetadata() {
        const recordingsRoot = path.join(root, 'recordings');
        const files = await fs.readdir(recordingsRoot, { recursive: true });
        const metadata = [];
        for (const file of files.filter((file) => file.endsWith('.json'))) {
          const value = JSON.parse(await fs.readFile(path.join(recordingsRoot, file), 'utf8'));
          if (value.endpointNameAtExecution === 'async-acceptance') metadata.push(value);
        }
        return metadata;
      },
      async close() {
        await stop();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
}

export async function withAsyncDeadline<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
