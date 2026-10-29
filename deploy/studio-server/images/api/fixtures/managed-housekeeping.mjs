import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHousekeepingSupervisor } from '../housekeeping-supervisor.mjs';
const require = createRequire('/app/packages/studio-server-api/package.json');
const { Pool } = require('pg');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const prefix = '/app/packages/studio-server-api/dist/studio-server-api/src';
const root = await fs.mkdtemp('/tmp/rivet-managed-handover-');
let prepareOverlapBundle;
if (process.env.RIVET_HOUSEKEEPING_PROVIDER_FIXTURE === '1') {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert.ok(size < 4 * 1024 * 1024);
    chunks.push(chunk);
  }
  // Generated code stays inside this disposable container. A real module path
  // also keeps error stacks bounded, unlike embedding the whole module in a URI.
  const helper = `${root}/provider-fixture.mjs`;
  await fs.writeFile(helper, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  ({ prepareOverlapBundle } = await import(helper));
}
const target = {
  databaseMode: 'managed',
  databaseUrl: 'postgres://postgres@db:5432/overlap',
  databaseSslMode: 'disable',
  objectStorageBucket: 'overlap',
  objectStorageRegion: 'us-east-1',
  objectStorageEndpoint: 'http://objects:9000',
  objectStorageAccessKeyId: 'overlap',
  objectStorageSecretAccessKey: 'overlap-local-secret',
  objectStoragePrefix: 'owned/',
  objectStorageForcePathStyle: true,
};
const pool = new Pool({ connectionString: target.databaseUrl });
const s3 = new S3Client({
  endpoint: target.objectStorageEndpoint,
  region: target.objectStorageRegion,
  forcePathStyle: true,
  credentials: { accessKeyId: target.objectStorageAccessKeyId, secretAccessKey: target.objectStorageSecretAccessKey },
});
const wait = async (check) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Managed handover fixture timed out.');
};
const env = {
  ...process.env,
  RIVET_KEY: 'local-overlap-fixture',
  RIVET_SERVER_UI_AUTH_MODE: 'key',
  RIVET_REQUIRE_UI_GATE_KEY: 'true',
  RIVET_API_PROFILE: 'control',
  RIVET_RUNTIME_PROCESS_ROLE: 'api',
  RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
  RIVET_HA_DEPLOYMENT: '1',
  RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap',
  RIVET_HA_PROTOCOL: '0',
  RIVET_APP_SETTINGS_BACKEND: 'postgres',
  RIVET_APP_SETTINGS_DATABASE_URL: target.databaseUrl,
  RIVET_APP_SETTINGS_ENCRYPTION_KEY: 'local-fixture',
  RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
  RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: target.databaseUrl,
  RIVET_DEPLOYMENT_DATABASE_SSL_MODE: 'disable',
  // The provider-fixture option validates the documented seven-owner target;
  // the separate Helm regression still rejects ten pooled connections.
  RIVET_DEPLOYMENT_DATABASE_POOL_MAX: prepareOverlapBundle ? '9' : '10',
  RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
  RIVET_DEPLOYMENT_STORAGE_BUCKET: target.objectStorageBucket,
  RIVET_DEPLOYMENT_STORAGE_ENDPOINT: target.objectStorageEndpoint,
  RIVET_DEPLOYMENT_STORAGE_REGION: target.objectStorageRegion,
  RIVET_DEPLOYMENT_STORAGE_PREFIX: target.objectStoragePrefix,
  RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: 'true',
  RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: target.objectStorageAccessKeyId,
  RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: target.objectStorageSecretAccessKey,
  RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify',
  RIVET_ROLLING_RETIREMENT_PROTOCOL: '1',
  RIVET_LEGACY_RESTORE_ENABLED: '1',
  RIVET_LEGACY_RESTORE_ROOT: root,
  RIVET_LEGACY_RESTORE_INSTALLATION: 'docker/overlap',
  RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN: 'fixture',
  RIVET_POD_IP: '127.0.0.1',
  RIVET_NAMESPACE_UID: randomUUID(),
  RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: 'none',
  RIVET_HOSTED_EVALUATIONS_ENABLED: 'false',
};
let first, second, backend;
try {
  await wait(async () => {
    await pool.query('SELECT 1');
    return (await fetch('http://objects:9000/minio/health/ready')).ok;
  });
  await s3.send(new CreateBucketCommand({ Bucket: target.objectStorageBucket }));
  const migration = spawnSync(process.execPath, [`${prefix}/scripts/migrate-managed-workflow-schema.js`, 'migrate'], {
    env,
    stdio: 'inherit',
  });
  assert.equal(migration.status, 0);
  const { ManagedWorkflowBackend } = await import(`${prefix}/routes/workflows/managed/backend.js`);
  backend = new ManagedWorkflowBackend(target, undefined, { migrationMode: 'verify' });
  const bundle = await backend.bundles.create(`Handover ${randomUUID()}`, '');
  const savedProject = await backend.createWorkflowProjectItem(bundle.relativePath, 'Preserved project');
  const make = (port) =>
    createHousekeepingSupervisor({
      env: {
        ...env,
        RIVET_DEPLOYMENT_STORAGE_SEED_MISSING: port === 18081 ? '1' : '0',
        RIVET_POD_UID: randomUUID(),
        RIVET_HOUSEKEEPING_PORT: String(port),
      },
      incarnation: randomUUID(),
      token: randomUUID(),
      command: ['/opt/rivet/api-entrypoint.sh'],
      timeoutMs: 30000,
    });
  first = make(18081);
  second = make(18082);
  const id = randomUUID();
  assert.equal((await first.command('acquire', id)).state, 'owner');
  assert.equal((await second.command('acquire', id)).state, 'standby');
  const request = async (suffix, body, binary = false) => {
    const owner = JSON.parse(await fs.readFile(`${root}/housekeeping-owner.json`, 'utf8'));
    const headers = {
      'x-rivet-proxy-auth': createHash('sha256').update(`${env.RIVET_KEY}:proxy-auth`).digest('hex'),
      cookie: `rivet_ui_token=${createHash('sha256').update(`${env.RIVET_KEY}:ui-session`).digest('hex')}`,
      'x-rivet-housekeeping-incarnation': owner.incarnation,
      'x-rivet-housekeeping-capability': owner.capability,
      'x-rivet-bundle-intent': '1',
      'x-rivet-namespace-intent': '1',
      'x-rivet-migration-intent': '1',
      'content-type': 'application/json',
    };
    const response = await fetch(`http://127.0.0.1:${owner.port}${suffix}`, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  if (prepareOverlapBundle) {
    const template = (
      await request(
        '/api/workflows/projects/download',
        { relativePath: savedProject.relativePath, version: 'live' },
        true,
      )
    ).toString('utf8');
    const fixture = await prepareOverlapBundle(
      {
        config: { baseUrl: 'http://isolated-fixture' },
        requestWorkflow: async (_base, route, options = {}) =>
          request(route, options.body ? JSON.parse(options.body) : undefined),
      },
      template,
    );
    assert.equal(fixture.projectIds.length, 2);
    // Use the actual catalog and object-storage export path, not fake project
    // DTOs: member ownership/reference errors must be found before paid setup.
    const exported = await request('/api/workflows/project-bundles/container', {
      bundleId: fixture.bundleId,
      version: 'latest',
      requestId: randomUUID(),
    });
    await wait(async () => (await request(`/api/workflows/project-bundles/${exported.id}`)).phase === 'ready');
    assert.ok((await request(`/api/workflows/project-bundles/${exported.id}/download`, undefined, true)).length > 0);
    console.log(
      'Provider bundle fixture: real guarded folder/upload/conversion/publication and saved two-project export passed.',
    );
  }
  const job = await request('/api/workflows/project-bundles/container', {
    bundleId: bundle.bundleId,
    version: 'latest',
    requestId: randomUUID(),
  });
  await wait(async () => (await request(`/api/workflows/project-bundles/${job.id}`)).phase === 'ready');
  const original = await request(`/api/workflows/project-bundles/${job.id}/download`, undefined, true);
  assert.equal((await request('/internal/ha/runtime-contract')).maintenanceIdle, true);
  assert.equal((await request('/api/legacy-restore')).available, true);
  const owner = JSON.parse(await fs.readFile(`${root}/housekeeping-owner.json`, 'utf8'));
  const upload = () =>
    fetch(`http://127.0.0.1:${owner.port}/api/legacy-restore/upload`, {
      method: 'POST',
      headers: {
        'x-rivet-proxy-auth': createHash('sha256').update(`${env.RIVET_KEY}:proxy-auth`).digest('hex'),
        cookie: `rivet_ui_token=${createHash('sha256').update(`${env.RIVET_KEY}:ui-session`).digest('hex')}`,
        'x-rivet-housekeeping-incarnation': owner.incarnation,
        'x-rivet-housekeeping-capability': owner.capability,
        'x-rivet-migration-intent': '1',
        'content-type': 'application/gzip',
      },
      body: gzipSync(Buffer.from('invalid archive: a nondestructive accepted-upload fixture')),
      signal: AbortSignal.timeout(15000),
    });
  const accepted = await upload();
  assert.equal(accepted.status, 202);
  const restore = (await accepted.json()).operation;
  await wait(async () => (await request('/api/legacy-restore')).operation?.phase === 'failed');
  assert.equal((await request('/internal/ha/runtime-contract')).maintenanceIdle, false);
  const releasing = first.command('release', id);
  await wait(() => first.snapshot().state === 'waiting');
  assert.equal((await upload()).status, 503, 'new upload is fenced while the existing restore remains inspectable');
  assert.equal((await request('/api/legacy-restore')).operation.id, restore.id);
  await request('/api/legacy-restore/cancel', { id: restore.id });
  await releasing;
  await second.command('acquire', id);
  const after = await request(`/api/workflows/project-bundles/${job.id}/download`, undefined, true);
  assert.deepEqual(after, original);
  assert.equal((await request('/api/legacy-restore')).available, true);
  assert.equal((await request('/api/legacy-restore')).operation.id, restore.id);
  assert.equal((await request('/api/legacy-restore')).operation.phase, 'cancelled');
  await second.command('release', id);
  console.log(
    'Real managed housekeeping handover: bundle ZIP bytes, PostgreSQL catalog and accepted restore journal preserved; new uploads fenced without replay.',
  );
} finally {
  await Promise.allSettled([first?.stop(), second?.stop()]);
  await backend?.dispose();
  await pool.end();
  s3.destroy();
  await fs.rm(root, { recursive: true, force: true });
}
