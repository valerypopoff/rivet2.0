import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export async function startAsyncWorkflowProcess(
  options: {
    endpointName?: string;
    projectName?: string;
    graceSeconds?: number;
    storage?: Record<string, unknown>;
    failure?: 'foreground' | 'serialization';
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-async-acceptance-'));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_')));
  Object.assign(env, {
    PORT: String(port),
    DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
    RIVET_ASYNC_TEST_ROOT: root,
    RIVET_APP_DATA_ROOT: path.join(root, 'app'),
    RIVET_WORKSPACE_ROOT: root,
    RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
    RIVET_KEY: 'async-fixture-key',
    RIVET_REQUIRE_UI_GATE_KEY: 'false',
    RIVET_API_PROFILE: 'combined',
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_SHUTDOWN_GRACE_SECONDS: String(options.graceSeconds ?? 2),
    RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'enforce',
    RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS: '4',
    ...(options.storage ? { RIVET_ASYNC_TEST_STORAGE: JSON.stringify(options.storage) } : {}),
    ...(options.endpointName ? { RIVET_ASYNC_TEST_ENDPOINT_NAME: options.endpointName } : {}),
    ...(options.projectName ? { RIVET_ASYNC_TEST_PROJECT_NAME: options.projectName } : {}),
    ...(options.failure ? { RIVET_ASYNC_TEST_FAILURE: options.failure } : {}),
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
      child.send({ id, command: name });
    });
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
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`API exited during startup\n${logs}`));
      });
    });
    return {
      ...info,
      root,
      command,
      exited,
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
        if (child.exitCode === null && child.signalCode === null) {
          await command('shutdown').catch(() => undefined);
          const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
          try {
            await exited;
          } finally {
            clearTimeout(timeout);
          }
        }
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
