import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { migrateManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import { startAsyncWorkflowProcess } from './helpers/workflow-async-process.js';
import { listenTestServer } from './helpers/http-server-harness.js';

// This command creates its own services. It never accepts a deployment URL.
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const owned: string[] = [];
let pool: Pool | undefined;
let s3: S3Client | undefined;
let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>> | undefined;
const pending = new Map<string, http.ServerResponse>();
const tail = await listenTestServer(
  http.createServer((req, res) => {
    pending.set(req.url!, res);
  }),
);
try {
  const launch = (port: number, ...args: string[]) => {
    const id = docker('run', '-d', '--name', `rivet-async-${randomUUID()}`, '-p', `127.0.0.1::${port}`, ...args);
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
    'POSTGRES_DB=rivet_async',
    'postgres:16.8-alpine',
  );
  const s3Port = launch(
    9000,
    '-e',
    'MINIO_ROOT_USER=asyncfixture',
    '-e',
    'MINIO_ROOT_PASSWORD=asyncfixturesecret',
    process.env.RIVET_ASYNC_TEST_MINIO_IMAGE ||
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
    'server',
    '/tmp/minio',
  );
  const databaseConnectionString = `postgres://postgres@127.0.0.1:${dbPort}/rivet_async`;
  pool = new Pool({ connectionString: databaseConnectionString, connectionTimeoutMillis: 1_000 });
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      if (!(await fetch(`http://127.0.0.1:${s3Port}/minio/health/ready`, { signal: AbortSignal.timeout(1_000) })).ok)
        throw new Error('MinIO is not ready');
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
  await migrateManagedWorkflowSchema(pool);
  s3 = new S3Client({
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'asyncfixture', secretAccessKey: 'asyncfixturesecret' },
  });
  await s3.send(new CreateBucketCommand({ Bucket: 'async-recordings' }));
  api = await startAsyncWorkflowProcess({
    storage: {
      version: 1,
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseSslMode: 'disable',
      databaseConnectionString,
      storageUrl: `http://127.0.0.1:${s3Port}/async-recordings`,
      storageAccessKeyId: 'asyncfixture',
      storageAccessKey: 'asyncfixturesecret',
    },
  });
  for (const [index, route] of ['/workflows', '/internal/workflows', '/workflows-latest'].entries()) {
    const value = `${tail.baseUrl}/${index}`;
    const response: Response = await fetch(`${api.baseUrl}${route}/async-acceptance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.json(), value);
    const end = Date.now() + 10_000;
    while (!pending.has(`/${index}`) && Date.now() < end) await delay(10);
    assert.ok(pending.has(`/${index}`));
    assert.equal((await api.command<{ active: number }>('snapshot')).active, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM workflow_recordings')).rows[0].count, index);
    pending
      .get(`/${index}`)!
      .writeHead(index === 1 ? 500 : 200)
      .end('managed async finished');
    let page: { runs: Array<{ id: string; status: string }> };
    do {
      page = await api.command('recordings');
      if (Date.now() >= end) throw new Error('Managed recording did not persist');
      if (page.runs.length <= index) await delay(10);
    } while (page.runs.length <= index);
    assert.equal(page.runs[0]!.status, index === 1 ? 'failed' : 'succeeded');
    assert.equal((await api.command<{ active: number }>('snapshot')).active, 0);
    const replays: Array<{ tails: unknown[] }> = await api.command('replay');
    assert.equal(replays.length, index + 1);
    for (const replay of replays)
      assert.equal(replay.tails.length, 1, 'stored object artifacts replay the async outcome');
  }
  console.log(
    'Managed async endpoints: three routes, early replies, retained ownership and persisted success/failure passed.',
  );
} finally {
  for (const response of pending.values()) response.end();
  await tail.close();
  await api?.close();
  await pool?.end();
  s3?.destroy();
  for (const id of owned.reverse()) docker('rm', '-f', '-v', id);
}
