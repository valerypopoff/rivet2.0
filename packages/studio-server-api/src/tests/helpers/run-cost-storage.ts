import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

/** Disposable services only: never accepts a deployment address or existing ID. */
export async function startRunCostStorage() {
  const owned: string[] = [];
  const docker = (...args: string[]) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    }).trim();
  const close = async () => {
    for (const id of owned.reverse()) docker('rm', '-f', '-v', id);
  };
  const launch = (port: number, ...args: string[]) => {
    const id = docker('run', '-d', '--name', `rivet-cost-${randomUUID()}`, '-p', `127.0.0.1::${port}`, ...args);
    owned.push(id);
    return Number(
      docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
    );
  };
  let pool: Pool | undefined;
  let s3: S3Client | undefined;
  try {
    const dbPort = launch(
      5432,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=rivet_cost',
      'postgres:16.8-alpine',
    );
    const s3Port = launch(
      9000,
      '-e',
      'MINIO_ROOT_USER=costfixture',
      '-e',
      'MINIO_ROOT_PASSWORD=costfixturesecret',
      '-e',
      'MINIO_REGION_NAME=eu-west-7',
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
      'server',
      '/tmp/minio',
    );
    const databaseConnectionString = `postgres://postgres@127.0.0.1:${dbPort}/rivet_cost`;
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
    s3 = new S3Client({
      endpoint,
      region: 'eu-west-7',
      forcePathStyle: true,
      credentials: { accessKeyId: 'costfixture', secretAccessKey: 'costfixturesecret' },
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'cost-recordings' }));
    return {
      settings: {
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'disable',
        databaseConnectionString,
        storageUrl: `${endpoint}/cost-recordings`,
        objectStorageBucket: 'cost-recordings',
        objectStorageEndpoint: endpoint,
        objectStorageRegion: 'eu-west-7',
        objectStoragePrefix: 'tenant/cost/',
        objectStorageForcePathStyle: true,
        storageAccessKeyId: 'costfixture',
        storageAccessKey: 'costfixturesecret',
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    await pool?.end();
    s3?.destroy();
  }
}
