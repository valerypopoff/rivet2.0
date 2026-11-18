import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

const images = {
  postgres: 'postgres:16.8-alpine',
  minio:
    'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
};

/** Disposable services only: never accepts a deployment address or existing ID. */
export async function startManagedHistoryStorage() {
  const owned: string[] = [];
  const docker = (...args: string[]) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    }).trim();
  const close = async () => {
    const failures: unknown[] = [];
    for (const id of owned.reverse()) {
      try {
        docker('rm', '-f', '-v', id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Could not remove all history test containers.');
  };
  const launch = (port: number, ...args: string[]) => {
    const id = docker(
      'run',
      '--pull=never',
      '-d',
      '--name',
      `rivet-history-${randomUUID()}`,
      '-p',
      `127.0.0.1::${port}`,
      ...args,
    );
    owned.push(id);
    return Number(
      docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
    );
  };
  let pool: Pool | undefined;
  try {
    const { pullImageWithRetry } = await import(
      new URL('../../../../../deploy/studio-server/scripts/lib/docker-image-pull.mjs', import.meta.url).href
    );
    for (const image of Object.values(images)) {
      try {
        docker('image', 'inspect', image);
      } catch (error) {
        if (!/No such (image|object)/i.test(String(error))) throw error;
        await pullImageWithRetry(image, (reference: string) => docker('pull', reference));
      }
    }
    const dbPort = launch(
      5432,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=rivet_history',
      images.postgres,
    );
    const s3Port = launch(
      9000,
      '-e',
      'MINIO_ROOT_USER=rivet-history',
      '-e',
      'MINIO_ROOT_PASSWORD=local-verification-only',
      '-e',
      'MINIO_REGION_NAME=us-east-1',
      images.minio,
      'server',
      '/tmp/minio',
    );
    const databaseConnectionString = `postgres://postgres@127.0.0.1:${dbPort}/rivet_history`;
    pool = new Pool({ connectionString: databaseConnectionString, connectionTimeoutMillis: 1000 });
    const endpoint = `http://127.0.0.1:${s3Port}`;
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await pool.query('SELECT 1');
        if (!(await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).ok)
          throw new Error('MinIO not ready');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    return { databaseUrl: databaseConnectionString, objectStorageUrl: endpoint, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    await pool?.end();
  }
}
