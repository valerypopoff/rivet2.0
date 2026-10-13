import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const iterations = Number(process.argv[2] ?? 100);
if (process.argv.length > 3 || !Number.isInteger(iterations) || iterations < 10 || iterations > 500)
  throw new Error('Usage: benchmark-serving-managed [10..500 iterations]; deployment URLs are not accepted.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-workload-'));
for (const key of Object.keys(process.env)) if (key.startsWith('RIVET_')) delete process.env[key];
Object.assign(process.env, {
  RIVET_APP_DATA_ROOT: path.join(root, 'app'),
  RIVET_WORKFLOWS_ROOT: path.join(root, 'virtual'),
  RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
  RIVET_RECORDINGS_ENABLED: 'true',
  RIVET_METRICS_ENABLED: 'true',
  RIVET_MANAGED_MAINTENANCE_ENABLED: 'false',
  DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
});
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const owned: string[] = [];
let dispose: (() => Promise<void>) | undefined;
try {
  const launch = (port: number, ...args: string[]) => {
    const id = docker('run', '-d', '--name', `rivet-serving-${randomUUID()}`, '-p', `127.0.0.1::${port}`, ...args);
    owned.push(id);
    return Number(
      docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
    );
  };
  const dbPort = launch(
    5432,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=rivet_workload',
    'postgres:16.8-alpine',
  );
  const objectPort = launch(
    9000,
    '-e',
    'MINIO_ROOT_USER=workload',
    '-e',
    'MINIO_ROOT_PASSWORD=workload-secret',
    'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
    'server',
    '/tmp/minio',
  );
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: `postgres://postgres@127.0.0.1:${dbPort}/rivet_workload`,
    connectionTimeoutMillis: 1000,
  });
  try {
    const deadline = Date.now() + 45_000;
    while (true) {
      try {
        await pool.query('SELECT 1');
        if (
          !(await fetch(`http://127.0.0.1:${objectPort}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok
        )
          throw new Error('Object store not ready');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
  } finally {
    await pool.end();
  }
  const { ManagedWorkflowBackend } = await import('../routes/workflows/managed/backend.js');
  const { measureServingWorkload } = await import('./serving-workload.js');
  const { getStudioMetrics } = await import('../metrics.js');
  const backend = new ManagedWorkflowBackend(
    {
      databaseMode: 'managed',
      databaseSslMode: 'disable',
      databaseUrl: `postgres://postgres@127.0.0.1:${dbPort}/rivet_workload`,
      objectStorageBucket: 'workload',
      objectStorageRegion: 'us-east-1',
      objectStorageEndpoint: `http://127.0.0.1:${objectPort}`,
      objectStoragePrefix: 'workflows/',
      objectStorageAccessKeyId: 'workload',
      objectStorageSecretAccessKey: 'workload-secret',
      objectStorageForcePathStyle: true,
    },
    undefined,
    { migrationMode: 'copy' },
  );
  dispose = () => backend.dispose();
  const started = performance.now();
  await backend.initialize();
  const startupMs = performance.now() - started;
  console.log(
    JSON.stringify(
      {
        mode: 'managed',
        nodeVersion: process.version,
        startupMs,
        ...(await measureServingWorkload(backend, () => backend.checkHealth(), iterations)),
        metrics: getStudioMetrics().render(),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await dispose?.();
  } finally {
    const failures: unknown[] = [];
    for (const id of owned.reverse()) {
      try {
        docker('rm', '-f', id);
      } catch (error) {
        failures.push(error);
      }
    }
    await fs.rm(root, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'Owned workload containers could not all be removed.');
  }
}
