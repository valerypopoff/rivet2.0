import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresAppSettingsBackend } from '../app-settings/managed-settings-store.js';
import {
  configureAppSettingsBackendForTests,
  initializeAppSettingsRepositories,
  disposeAppSettingsRepositories,
} from '../app-settings/settings-repository.js';
import { createPublishedExecutionAdmission } from '../published-execution-admission.js';
import {
  bindPublishedExecutionSettings,
  publishedExecutionSettingsRepository,
  writePublishedExecutionSettings,
} from '../published-execution-settings.js';
import { migrateManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import { allocateDistinctTestPorts } from './helpers/http-server-harness.js';

async function worker() {
  const backend = new PostgresAppSettingsBackend({
    poolConfig: {
      connectionString: process.env.RIVET_EXECUTION_TEST_DB,
      application_name: process.env.RIVET_EXECUTION_TEST_NAME,
      connectionTimeoutMillis: 1000,
    },
    encryptionSecret: 'local-execution-policy-fixture',
    pollIntervalMs: 1000,
    logger: { log() {}, warn() {}, error() {} },
  });
  let muted = false;
  let notificationFailures = 0;
  const query = Pool.prototype.query;
  Object.defineProperty(Pool.prototype, 'query', {
    configurable: true,
    writable: true,
    value: function (this: Pool, ...args: unknown[]) {
      if (muted && typeof args[0] === 'string' && args[0].includes('pg_notify')) {
        notificationFailures++;
        return Promise.reject(Error('Injected notification loss'));
      }
      return Reflect.apply(query, this, args);
    },
  });
  await configureAppSettingsBackendForTests(backend);
  await initializeAppSettingsRepositories();
  const admission = createPublishedExecutionAdmission({
    mode: 'enforce',
    maxActiveRuns: Number(process.env.RIVET_EXECUTION_TEST_DEFAULT),
    retryAfterSeconds: 1,
  });
  const binding = bindPublishedExecutionSettings(admission);
  const permits: Array<{ release(): void }> = [];
  process.on('message', async (m: { id: number; name: string; value?: number | null }) => {
    try {
      let result: unknown;
      switch (m.name) {
        case 'policy':
          result = binding.snapshot();
          break;
        case 'activity':
          result = admission.getSnapshot();
          break;
        case 'acquire': {
          const entry = admission.acquire('workflow-endpoint');
          if (entry.kind === 'accepted') permits.push(entry.permit);
          result = entry.kind;
          break;
        }
        case 'release':
          permits.pop()?.release();
          result = admission.getSnapshot();
          break;
        case 'mute-notify':
          muted = true;
          result = true;
          break;
        case 'notification-failures':
          result = notificationFailures;
          break;
        case 'save': {
          const current = await publishedExecutionSettingsRepository.read();
          result = await writePublishedExecutionSettings({ maxActiveRunsPerPod: m.value }, current.revision);
          break;
        }
        case 'drain':
          admission.beginDrain();
          result = true;
          break;
        case 'close':
          binding.dispose();
          await disposeAppSettingsRepositories();
          process.send?.({ id: m.id, result: true });
          process.disconnect();
          return;
        default:
          throw Error('Unknown fixture command');
      }
      process.send?.({ id: m.id, result });
    } catch (e) {
      process.send?.({ id: m.id, error: (e as Error).message });
    }
  });
  process.send?.({ ready: true });
}

async function main() {
  const docker = (...args: string[]) =>
    execFileSync('docker', [...(process.platform === 'win32' ? ['--context', 'desktop-linux'] : []), ...args], {
      encoding: 'utf8',
      timeout: 120000,
    }).trim();
  const [port] = await allocateDistinctTestPorts(1);
  const container = 'rivet-concurrency-' + randomUUID();
  const root = await mkdtemp(path.join(os.tmpdir(), 'rivet-concurrency-'));
  const handles: Array<{ command: (name: string, value?: number | null) => Promise<any>; close: () => Promise<void> }> =
    [];
  let pool: Pool | undefined,
    sequence = 0;
  const until = async (check: () => Promise<boolean>, seconds = 15) => {
    const deadline = Date.now() + seconds * 1000;
    let lastError: unknown;
    for (;;) {
      try {
        if (await check()) return;
      } catch (error) {
        lastError = error;
        if ((error as Error).message.startsWith('Worker exited:')) throw error;
      }
      if (Date.now() >= deadline) throw Error('Local execution policy observation timed out', { cause: lastError });
      await delay(100);
    }
  };
  try {
    // Match the preceding managed CI suite's image so this step reuses its pull.
    // The generated name also permits exact cleanup after an uncertain run ack.
    const id = docker(
      'run',
      '-d',
      '--name',
      container,
      '--label',
      'rivet.dev/test=published-execution',
      '-p',
      `127.0.0.1:${port}:5432`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=rivet_concurrency',
      'postgres:16-alpine',
    );
    assert.match(id, /^[a-f0-9]{64}$/);
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/rivet_concurrency`;
    pool = new Pool({ connectionString, connectionTimeoutMillis: 1000 });
    // This test deliberately stops its database with idle fixture connections.
    pool.on('error', () => {});
    await until(async () => (await pool!.query('SELECT 1')).rowCount === 1);
    await migrateManagedWorkflowSchema(pool);
    const start = async (scope = 'rivet/rivet', max = 32) => {
      const application = `rivet-policy-${sequence++}`;
      const child = fork(new URL(import.meta.url), ['--worker'], {
        silent: true,
        execArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RIVET_'))),
          RIVET_EXECUTION_TEST_DB: connectionString,
          RIVET_EXECUTION_TEST_NAME: application,
          RIVET_APP_DATA_ROOT: path.join(root, application),
          RIVET_EXECUTION_TEST_DEFAULT: String(max),
          RIVET_LEGACY_RESTORE_INSTALLATION: scope,
          RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_DEFAULTS: JSON.stringify({ mode: 'enforce', maxActiveRunsPerPod: max }),
        },
      });
      let logs = '',
        serial = 0,
        ready = false;
      child.stdout!.on('data', (c) => {
        logs = (logs + c).slice(-16000);
      });
      child.stderr!.on('data', (c) => {
        logs = (logs + c).slice(-16000);
      });
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
      child.on('message', (m: { ready?: boolean; id: number; result?: unknown; error?: string }) => {
        if (m.ready) {
          ready = true;
          return;
        }
        const request = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) request?.reject(Error(m.error));
        else request?.resolve(m.result);
      });
      child.once('exit', () => {
        for (const p of pending.values()) p.reject(Error('Worker exited: ' + logs));
        pending.clear();
      });
      const command = (name: string, value?: number | null) =>
        new Promise<any>((resolve, reject) => {
          if (!child.connected) {
            reject(Error('Worker exited: ' + logs));
            return;
          }
          const id = serial++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error(`Command timed out: ${name}\n${logs}`));
          }, 10000);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          child.send({ id, name, value }, (error) => {
            if (error) {
              pending.delete(id);
              clearTimeout(timer);
              reject(error);
            }
          });
        });
      const close = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          await command('close');
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            await new Promise<void>((r) => child.once('exit', () => r()));
          clearTimeout(timer);
        }
      };
      const handle = { command, close };
      handles.push(handle);
      child.once('error', (error) => {
        for (const p of pending.values()) p.reject(error);
        pending.clear();
      });
      await until(async () => {
        if (child.exitCode !== null) throw Error(logs);
        return ready;
      }, 30);
      return { ...handle, application };
    };
    const writer = await start(),
      reader = await start();
    assert.equal((await reader.command('policy')).limit, 32);
    assert.equal(await reader.command('acquire'), 'accepted');
    await writer.command('save', 1);
    await until(async () => (await reader.command('policy')).limit === 1);
    assert.equal(await reader.command('acquire'), 'capacity-exceeded');
    await reader.command('release');
    assert.equal(await reader.command('acquire'), 'accepted');
    await writer.command('mute-notify');
    await writer.command('save', 48);
    assert.ok((await writer.command('notification-failures')) > 0, 'The notification loss must actually be injected');
    await until(async () => (await reader.command('policy')).limit === 48, 5);
    const restarted = await start();
    assert.equal((await restarted.command('policy')).limit, 48);
    const staging = await start('rivet-staging-persistent/rivet-qualification', 4);
    assert.equal((await staging.command('policy')).limit, 4);
    const listener = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE 'LISTEN%'",
      [reader.application],
    );
    assert.equal(listener.rowCount, 1);
    const oldPid = listener.rows[0].pid;
    const terminated = await pool.query('SELECT pg_terminate_backend($1) AS terminated', [oldPid]);
    assert.equal(terminated.rowCount, 1);
    assert.equal(terminated.rows[0].terminated, true);
    await until(async () => {
      const current = await pool!.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE 'LISTEN%'",
        [reader.application],
      );
      return current.rowCount === 1 && current.rows[0].pid !== oldPid;
    });
    await writer.command('save', 16);
    await until(async () => (await reader.command('policy')).limit === 16, 5);
    docker('stop', '--time', '1', container);
    await until(async () => {
      try {
        await reader.command('policy');
        return false;
      } catch {
        return true;
      }
    }, 20);
    assert.equal((await reader.command('activity')).activeRuns, 1);
    assert.equal((await reader.command('activity')).maxActiveRuns, 16);
    await reader.command('release');
    assert.equal((await reader.command('activity')).activeRuns, 0);
    docker('start', container);
    assert.equal(
      Number(
        docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container),
      ),
      port,
      'Test database address changed across restart',
    );
    await until(async () => (await reader.command('policy')).limit === 16, 20);
    await writer.command('save', null);
    await until(async () => (await reader.command('policy')).limit === 32);
    await reader.command('drain');
    await writer.command('save', 64);
    await until(async () => (await reader.command('policy')).limit === 64);
    assert.equal(await reader.command('acquire'), 'draining');
    console.log(
      JSON.stringify({
        success: true,
        independentProcesses: 4,
        notification: true,
        pollingAfterNotificationLoss: true,
        listenerReconnect: true,
        restart: true,
        foreignInstallation: true,
        databaseOutagePreservedAcceptedWork: true,
        reset: true,
        drainingPreserved: true,
      }),
    );
  } finally {
    await Promise.allSettled(handles.map((h) => h.close()));
    try {
      await pool?.end();
    } finally {
      try {
        docker('rm', '-f', '-v', container);
      } catch (error) {
        if (!/No such (container|object)/i.test(String((error as { stderr?: unknown }).stderr))) throw error;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv.includes('--worker')) await worker();
else await main();
