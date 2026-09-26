import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { migrateManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import { startAsyncWorkflowProcess } from './helpers/workflow-async-process.js';
import { listenTestServer } from './helpers/http-server-harness.js';

// This command creates its own services. It never accepts a deployment URL.
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const owned: string[] = [];
let pool: Pool | undefined;
let s3: S3Client | undefined;
let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>> | undefined;
let secondApi: Awaited<ReturnType<typeof startAsyncWorkflowProcess>> | undefined;
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
    '-e',
    'MINIO_REGION_NAME=eu-west-7',
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
    region: 'eu-west-7',
    forcePathStyle: true,
    credentials: { accessKeyId: 'asyncfixture', secretAccessKey: 'asyncfixturesecret' },
  });
  // The mock runtime-config server below precedes the real API; provision its
  // bucket explicitly because it does not enforce the real API's readiness.
  await s3.send(new CreateBucketCommand({ Bucket: 'async-recordings' }));
  const storageSettings = {
    version: 1,
    storageMode: 'managed',
    databaseMode: 'managed',
    databaseSslMode: 'disable',
    databaseConnectionString,
    storageUrl: `http://127.0.0.1:${s3Port}/async-recordings`,
    objectStorageBucket: 'async-recordings',
    objectStorageEndpoint: `http://127.0.0.1:${s3Port}`,
    objectStorageRegion: 'eu-west-7',
    objectStoragePrefix: 'tenant/async-workflows/',
    objectStorageForcePathStyle: true,
    storageAccessKeyId: 'asyncfixture',
    storageAccessKey: 'asyncfixturesecret',
  };
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-settings-'));
  const settingEnv = {
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_DEPLOYMENT_STORAGE_SEED_MISSING: '1',
    RIVET_APP_DATA_ROOT: settingsRoot,
    RIVET_KEY: 'async-fixture-settings-key',
    RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: databaseConnectionString,
    RIVET_DEPLOYMENT_DATABASE_SSL_MODE: 'disable',
    RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
    RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
    RIVET_DEPLOYMENT_STORAGE_BUCKET: storageSettings.objectStorageBucket,
    RIVET_DEPLOYMENT_STORAGE_ENDPOINT: storageSettings.objectStorageEndpoint,
    RIVET_DEPLOYMENT_STORAGE_REGION: storageSettings.objectStorageRegion,
    RIVET_DEPLOYMENT_STORAGE_PREFIX: storageSettings.objectStoragePrefix,
    RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: 'true',
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: storageSettings.storageAccessKeyId,
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: storageSettings.storageAccessKey,
  };
  const originalSettingEnv = Object.fromEntries(Object.keys(settingEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settingEnv);
  const settingsRepository = await import('../app-settings/settings-repository.js');
  const managedSettings = await import('../app-settings/managed-settings-store.js');
  const deploymentSettings = await import('../deployment-storage-settings.js');
  try {
    await settingsRepository.configureAppSettingsBackendForTests(managedSettings.createPostgresAppSettingsBackendFromEnv());
    const seeded = await deploymentSettings.deploymentStorageSettingsRepository.initialize();
    assert.equal(seeded.value.objectStoragePrefix, 'tenant/async-workflows/');
    assert.equal(seeded.value.storageAccessKey, 'asyncfixturesecret');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_settings WHERE setting_key = 'deployment storage'")).rows[0].count, 1);
    process.env.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY = 'changed-helm-credential';
    delete process.env.RIVET_DEPLOYMENT_STORAGE_SEED_MISSING;
    await settingsRepository.configureAppSettingsBackendForTests(managedSettings.createPostgresAppSettingsBackendFromEnv());
    const existing = await deploymentSettings.deploymentStorageSettingsRepository.initialize();
    assert.equal(existing.value.storageAccessKey, 'asyncfixturesecret');
    assert.equal(await fs.readdir(settingsRoot).then((files) => files.length), 0);
  } finally {
    await settingsRepository.disposeAppSettingsRepositories();
    for (const [key, value] of Object.entries(originalSettingEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(settingsRoot, { recursive: true, force: true });
  }
  let runtimeConfigAvailable = false;
  let unavailableRuntimeConfigRequests = 0;
  let runtimeProxy = '';
  const runtimeConfig = await listenTestServer(http.createServer((req, res) => {
    const expected = (scope: string) =>
      createHash('sha256').update(`async-fixture-key:${scope}`).digest('hex');
    if (req.url !== '/internal/executor-runtime-config' ||
      req.headers['x-rivet-proxy-auth'] !== expected('proxy-auth') ||
      req.headers['x-rivet-executor-auth'] !== expected('executor-internal')) {
      res.writeHead(403).end();
      return;
    }
    if (!runtimeConfigAvailable) {
      unavailableRuntimeConfigRequests += 1;
      res.writeHead(503).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      protocolVersion: 1,
      storage: storageSettings,
      proxy: { httpProxy: '', httpsProxy: runtimeProxy, noProxy: '127.0.0.1' },
    }));
  }));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-settings-'));
  const executorAppDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-executor-settings-'));
  try {
    const bootstrapUrl = new URL('../../../studio-server-bootstrap/bootstrap.mjs', import.meta.url).href;
    const executorProbe = `
      const proxy = () => process.env.HTTPS_PROXY || 'none';
      console.log('EXECUTOR_READY', proxy());
      let lastProxy = proxy();
      const observer = setInterval(() => {
        if (proxy() === lastProxy) return;
        lastProxy = proxy();
        console.log('EXECUTOR_REFRESHED', lastProxy);
      }, 50);
      process.stdin.on('data', (data) => {
        if (String(data).includes('CHECK')) console.log('EXECUTOR_RETAINED', proxy());
        if (String(data).includes('EXIT')) {
          clearInterval(observer);
          process.exit(0);
        }
      });
    `;
    const child = spawn(process.execPath, [
      '--import', bootstrapUrl,
      '-e',
      executorProbe,
      'executor-bundle',
    ], {
      env: {
        ...process.env,
        RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
        RIVET_RUNTIME_PROCESS_ROLE: 'executor',
        RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `${runtimeConfig.baseUrl}/internal/executor-runtime-config`,
        RIVET_KEY: 'async-fixture-key',
        RIVET_APP_DATA_ROOT: executorAppDataRoot,
        RIVET_RUNTIME_LIBRARIES_ROOT: runtimeRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    try {
      const unavailableDeadline = Date.now() + 15_000;
      while (unavailableRuntimeConfigRequests === 0 && Date.now() < unavailableDeadline) await delay(50);
      assert.ok(unavailableRuntimeConfigRequests > 0, output);
      assert.doesNotMatch(output, /EXECUTOR_READY/, 'the executor must not start while the API is unavailable');
      runtimeConfigAvailable = true;
      const readyDeadline = Date.now() + 15_000;
      while (!output.includes('EXECUTOR_READY') && Date.now() < readyDeadline) await delay(50);
      assert.match(output, /EXECUTOR_READY none/);
      runtimeProxy = 'http://proxy-updated.invalid:3128';
      const refreshDeadline = Date.now() + 15_000;
      while (!output.includes('EXECUTOR_REFRESHED http://proxy-updated.invalid:3128') && Date.now() < refreshDeadline) await delay(50);
      assert.match(output, /EXECUTOR_REFRESHED http:\/\/proxy-updated\.invalid:3128/);
      const requestsBeforeInterruption = unavailableRuntimeConfigRequests;
      runtimeConfigAvailable = false;
      const interruptionDeadline = Date.now() + 15_000;
      while (unavailableRuntimeConfigRequests === requestsBeforeInterruption && Date.now() < interruptionDeadline) await delay(50);
      assert.ok(unavailableRuntimeConfigRequests > requestsBeforeInterruption, output);
      child.stdin.write('CHECK\n');
      const retainedDeadline = Date.now() + 5_000;
      while (!output.includes('EXECUTOR_RETAINED') && Date.now() < retainedDeadline) await delay(50);
      assert.match(output, /EXECUTOR_RETAINED http:\/\/proxy-updated\.invalid:3128/);
      child.stdin.write('EXIT\n');
      const exitCode = child.exitCode ?? await new Promise<number | null>((resolve) => child.once('exit', resolve));
      assert.equal(exitCode, 0, output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  } finally {
    await runtimeConfig.close();
    const executorAppDataFiles = await fs.readdir(executorAppDataRoot);
    await fs.rm(executorAppDataRoot, { recursive: true, force: true });
    await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(executorAppDataFiles.length, 0, 'managed executor must not create settings files');
  }
  // Exercise the real API's first-install path with an absent bucket after
  // the isolated executor bootstrap check has finished.
  await s3.send(new DeleteBucketCommand({ Bucket: 'async-recordings' }));
  api = await startAsyncWorkflowProcess({ storage: storageSettings });
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
  const storedObjects = await s3.send(new ListObjectsV2Command({ Bucket: 'async-recordings' }));
  const keys = storedObjects.Contents?.map((object) => object.Key ?? '') ?? [];
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => key.startsWith('tenant/async-workflows/')));
  assert.ok(
    keys.some((key) => key.endsWith('/project.rivet-project')),
    'saved and published revisions use the prefix',
  );
  assert.ok(
    keys.some((key) => key.endsWith('/recording.rivet-recording')),
    'recordings use the prefix',
  );
  assert.ok(
    keys.some((key) => key.endsWith('/replay.rivet-project')),
    'replay projects use the prefix',
  );

  // A second API process must resolve the first process's published project
  // from PostgreSQL and object storage, including after the first exits.
  secondApi = await startAsyncWorkflowProcess({
    endpointName: 'async-acceptance-secondary',
    projectName: 'Async acceptance secondary',
    storage: storageSettings,
  });
  const firstApi = api;
  const originalProjectId = api.projectId;
  for (let index = 0; index < 2; index++) {
    if (index === 1) {
      await firstApi.close();
      api = undefined;
    }
    const value = `${tail.baseUrl}/cross-process-${index}`;
    const response: Response = await fetch(`${secondApi.baseUrl}/workflows/async-acceptance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.json(), value);
    const end = Date.now() + 10_000;
    while (!pending.has(`/cross-process-${index}`) && Date.now() < end) await delay(10);
    assert.ok(pending.has(`/cross-process-${index}`));
    pending.get(`/cross-process-${index}`)!.writeHead(200).end('finished');
    for (;;) {
      const count = Number(
        (
          await pool.query('SELECT count(*)::int AS count FROM workflow_recordings WHERE workflow_id = $1', [
            originalProjectId,
          ])
        ).rows[0].count,
      );
      if (count === 4 + index) break;
      if (Date.now() >= end) throw new Error('Cross-process recording did not persist under the original project');
      await delay(10);
    }
  }
  console.log(
    'Managed async endpoints: three routes, early replies, retained ownership and persisted success/failure passed.',
  );
} finally {
  for (const response of pending.values()) response.end();
  await tail.close();
  await api?.close();
  await secondApi?.close();
  await pool?.end();
  s3?.destroy();
  for (const id of owned.reverse()) docker('rm', '-f', '-v', id);
}
