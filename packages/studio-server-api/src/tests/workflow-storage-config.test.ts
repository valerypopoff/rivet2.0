import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withScopedEnv } from './helpers/runtime-library-harness.js';
import { repoRoot } from './helpers/repo-contract-helpers.js';

// test-style: fixture-read: Inspect only the temporary bootstrap/settings JSON produced by this test.

const storageConfig = await import('../routes/workflows/storage-config.js');
const blobStore = await import('../routes/workflows/managed/blob-store.js');
const envParsing = await import('../utils/env-parsing.js');
const deploymentStorageSettings = await import('../deployment-storage-settings.js');
const objectStorageLocation = await import('../object-storage-location.js');

test('in-memory blob text stays exact and byte reads are isolated and cancellable', async () => {
  const store = new blobStore.InMemoryManagedWorkflowBlobStore();
  const text = 'Unicode: 🍌; unpaired surrogate: \ud800';
  await store.putText('recording', text);
  assert.equal(await store.getText('recording'), text);
  const first = await store.getBytes('recording');
  const second = await store.getBytes('recording');
  assert.deepEqual(first, Buffer.from(text, 'utf8'));
  first.fill(0);
  assert.deepEqual(second, Buffer.from(text, 'utf8'));
  assert.equal(await store.getText('recording'), text);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.getText('recording', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(store.getBytes('recording', { signal: controller.signal }), { name: 'AbortError' });
});

const managedEnvKeys = [
  'RIVET_APP_DATA_ROOT',
  'RIVET_STORAGE_MODE',
  'RIVET_DATABASE_MODE',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_STORAGE_URL',
  'RIVET_STORAGE_BUCKET',
  'RIVET_STORAGE_REGION',
  'RIVET_STORAGE_ENDPOINT',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_STORAGE_PREFIX',
  'RIVET_STORAGE_FORCE_PATH_STYLE',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
  'RIVET_DATABASE_URL',
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_OBJECT_STORAGE_PREFIX',
  'RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_REGION',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
] as const;

async function withManagedEnv(
  overrides: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  await withScopedEnv(managedEnvKeys, overrides, run);
}

async function withDeploymentStorageSettings(
  settings: Parameters<typeof deploymentStorageSettings.writeDeploymentStorageSettings>[0],
  run: () => Promise<void> | void,
) {
  const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-workflow-storage-config-'));
  const previousAppDataRoot = process.env.RIVET_APP_DATA_ROOT;
  process.env.RIVET_APP_DATA_ROOT = appDataRoot;

  try {
    await deploymentStorageSettings.writeDeploymentStorageSettings(settings);
    await run();
  } finally {
    if (previousAppDataRoot == null) {
      delete process.env.RIVET_APP_DATA_ROOT;
    } else {
      process.env.RIVET_APP_DATA_ROOT = previousAppDataRoot;
    }
    fs.rmSync(appDataRoot, { recursive: true, force: true });
  }
}

async function withEmptyDeploymentStorageEnv(
  overrides: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  const appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-workflow-storage-empty-'));

  try {
    await withManagedEnv({ ...overrides, RIVET_APP_DATA_ROOT: appDataRoot }, run);
  } finally {
    fs.rmSync(appDataRoot, { recursive: true, force: true });
  }
}

test('managed storage config accepts saved DigitalOcean-style storage URLs', async () => {
  await withDeploymentStorageSettings(
    {
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://db-user:db-pass@example-db:25060/defaultdb?sslmode=disable',
      storageUrl: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'spaces-access-key-id',
      storageAccessKey: 'spaces-secret-access-key',
    },
    () => {
      const config = storageConfig.getManagedWorkflowStorageConfig();

      assert.equal(config.databaseMode, 'managed');
      assert.equal(config.databaseUrl, 'postgresql://db-user:db-pass@example-db:25060/defaultdb');
      assert.equal(config.databaseSslMode, 'require');
      assert.equal(config.objectStorageBucket, 'test-bucket-111');
      assert.equal(config.objectStorageRegion, 'sfo3');
      assert.equal(config.objectStorageEndpoint, 'https://sfo3.digitaloceanspaces.com');
      assert.equal(config.objectStorageAccessKeyId, 'spaces-access-key-id');
      assert.equal(config.objectStorageSecretAccessKey, 'spaces-secret-access-key');
      assert.equal(config.objectStoragePrefix, 'workflows/');
      assert.equal(config.objectStorageForcePathStyle, false);
    },
  );
});

test('a pre-upgrade version-1 settings file keeps its original workflow object location', async () => {
  await withEmptyDeploymentStorageEnv({}, () => {
    const settingsPath = deploymentStorageSettings.getDeploymentStorageSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'require',
        databaseConnectionString: 'postgresql://user:pass@db.example.test/rivet',
        storageUrl: 'https://legacy-bucket.sfo3.digitaloceanspaces.com',
        storageAccessKeyId: 'access',
        storageAccessKey: 'secret',
      }),
    );
    const config = storageConfig.getManagedWorkflowStorageConfig();
    assert.equal(config.objectStorageBucket, 'legacy-bucket');
    assert.equal(config.objectStorageRegion, 'sfo3');
    assert.equal(config.objectStoragePrefix, 'workflows/');
    assert.equal(config.objectStorageEndpoint, 'https://sfo3.digitaloceanspaces.com');
  });
});

test('storage backend selection ignores storage-mode environment variables', async () => {
  await withEmptyDeploymentStorageEnv(
    {
      RIVET_STORAGE_MODE: 'managed',
      RIVET_DATABASE_MODE: 'managed',
    },
    () => {
      assert.equal(storageConfig.getWorkflowStorageBackendMode(), 'filesystem');
      assert.equal(storageConfig.isManagedWorkflowStorageEnabled(), false);
    },
  );
});

test('managed storage config accepts saved path-style storage URLs for local Docker rehearsal', async () => {
  await withDeploymentStorageSettings(
    {
      storageMode: 'managed',
      databaseMode: 'local-docker',
      storageUrl: 'http://workflow-minio:9000/rivet-workflows',
      storageAccessKeyId: 'minioadmin',
      storageAccessKey: 'minioadmin',
    },
    () => {
      const config = storageConfig.getManagedWorkflowStorageConfig();

      assert.equal(config.databaseMode, 'local-docker');
      assert.equal(config.databaseUrl, 'postgres://rivet:rivet@workflow-postgres:5432/rivet');
      assert.equal(config.databaseSslMode, 'disable');
      assert.equal(config.objectStorageBucket, 'rivet-workflows');
      assert.equal(config.objectStorageRegion, 'us-east-1');
      assert.equal(config.objectStorageEndpoint, 'http://workflow-minio:9000');
      assert.equal(config.objectStorageAccessKeyId, 'minioadmin');
      assert.equal(config.objectStorageSecretAccessKey, 'minioadmin');
      assert.equal(config.objectStoragePrefix, 'workflows/');
      assert.equal(config.objectStorageForcePathStyle, true);
    },
  );
});

test('explicit object location preserves custom region, nested prefix, and path style', async () => {
  await withDeploymentStorageSettings(
    {
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://user:pass@db.example.test/rivet',
      objectStorageBucket: 'rivet',
      objectStorageEndpoint: 'https://objects.example.test:9443',
      objectStorageRegion: 'provider-region-2',
      objectStoragePrefix: 'tenant/rivet/workflows/',
      objectStorageForcePathStyle: true,
      storageAccessKeyId: 'access',
      storageAccessKey: 'secret',
    },
    async () => {
      const config = storageConfig.getManagedWorkflowStorageConfig();
      assert.equal(config.objectStorageBucket, 'rivet');
      assert.equal(config.objectStorageEndpoint, 'https://objects.example.test:9443');
      assert.equal(config.objectStorageRegion, 'provider-region-2');
      assert.equal(config.objectStoragePrefix, 'tenant/rivet/workflows/');
      assert.equal(config.objectStorageForcePathStyle, true);
      const publicSettings = await deploymentStorageSettings.readDeploymentStorageSettings();
      assert.equal(publicSettings.objectStoragePrefix, 'tenant/rivet/workflows/');
      assert.equal(
        objectStorageLocation.parseLegacyStorageUrl(publicSettings.storageUrl).objectStoragePrefix,
        'workflows/',
        'the compatibility URL cannot represent a custom prefix; pre-upgrade readers are not safe rollback targets',
      );
    },
  );
});

test('explicit virtual-host location preserves a dotted bucket and signing region', async () => {
  await withDeploymentStorageSettings(
    {
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://user:pass@db.example.test/rivet',
      objectStorageBucket: 'my.bucket',
      objectStorageEndpoint: 'https://objects.example.test:9443',
      objectStorageRegion: 'provider-region-7',
      objectStoragePrefix: 'tenant/workflows/',
      objectStorageForcePathStyle: false,
      storageAccessKeyId: 'access',
      storageAccessKey: 'secret',
    },
    () => {
      const config = storageConfig.getManagedWorkflowStorageConfig();
      assert.equal(config.objectStorageBucket, 'my.bucket');
      assert.equal(config.objectStorageEndpoint, 'https://objects.example.test:9443');
      assert.equal(config.objectStorageRegion, 'provider-region-7');
      assert.equal(config.objectStoragePrefix, 'tenant/workflows/');
      assert.equal(config.objectStorageForcePathStyle, false);
      const clientConfig = blobStore.createManagedWorkflowS3ClientConfig(config);
      assert.equal(clientConfig.region, 'provider-region-7');
      assert.equal(clientConfig.endpoint, 'https://objects.example.test:9443');
      assert.equal(clientConfig.forcePathStyle, false);
    },
  );
});

test('deployment bootstrap persists Helm S3 fields without relying on URL inference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-storage-bootstrap-'));
  try {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs')],
      {
        env: {
          ...process.env,
          RIVET_APP_DATA_ROOT: root,
          RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: 'postgresql://user:pass@db.example.test/rivet',
          RIVET_DEPLOYMENT_STORAGE_BUCKET: 'custom-bucket',
          RIVET_DEPLOYMENT_STORAGE_ENDPOINT: 'https://objects.example.test:9443',
          RIVET_DEPLOYMENT_STORAGE_REGION: 'custom-region-7',
          RIVET_DEPLOYMENT_STORAGE_PREFIX: 'tenant/workflows/',
          RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: 'true',
          RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: 'access',
          RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: 'secret',
        },
        stdio: 'pipe',
      },
    );
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'settings', 'deployment-storage.json'), 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.objectStorageBucket, 'custom-bucket');
    assert.equal(stored.objectStorageEndpoint, 'https://objects.example.test:9443');
    assert.equal(stored.objectStorageRegion, 'custom-region-7');
    assert.equal(stored.objectStoragePrefix, 'tenant/workflows/');
    assert.equal(stored.objectStorageForcePathStyle, true);
    assert.equal(stored.storageUrl, 'https://objects.example.test:9443/custom-bucket');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deployment bootstrap requires a signing region for a new explicit bucket', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-storage-bootstrap-region-'));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(repoRoot, 'deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs')],
          {
            env: {
              ...process.env,
              RIVET_APP_DATA_ROOT: root,
              RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: 'postgresql://user:pass@db.example.test/rivet',
              RIVET_DEPLOYMENT_STORAGE_BUCKET: 'custom-bucket',
              RIVET_DEPLOYMENT_STORAGE_REGION: '',
              RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: 'access',
              RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: 'secret',
            },
            stdio: 'pipe',
          },
        ),
      /RIVET_DEPLOYMENT_STORAGE_REGION is required/,
    );
    assert.equal(fs.existsSync(path.join(root, 'settings', 'deployment-storage.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deployment bootstrap rejects a legacy URL that disagrees with chart-owned S3 fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-storage-bootstrap-conflict-'));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(repoRoot, 'deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs')],
          {
            env: {
              ...process.env,
              RIVET_APP_DATA_ROOT: root,
              RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
              RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: 'postgresql://user:pass@db.example.test/rivet',
              RIVET_DEPLOYMENT_STORAGE_BUCKET: 'chart-bucket',
              RIVET_DEPLOYMENT_STORAGE_REGION: 'us-east-1',
              RIVET_DEPLOYMENT_STORAGE_URL: 'https://other-bucket.s3.example.test',
              RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: 'access',
              RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: 'secret',
            },
            stdio: 'pipe',
          },
        ),
      /conflicts with the chart-owned bucket/,
    );
    assert.equal(fs.existsSync(path.join(root, 'settings', 'deployment-storage.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kubernetes bootstrap rejects local storage modes before writing settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-storage-bootstrap-local-'));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(repoRoot, 'deploy/studio-server/images/lib/bootstrap-deployment-storage-settings.mjs')],
          {
            env: {
              ...process.env,
              RIVET_APP_DATA_ROOT: root,
              RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
              RIVET_DEPLOYMENT_STORAGE_MODE: 'filesystem',
              RIVET_DEPLOYMENT_DATABASE_MODE: 'local-docker',
            },
            stdio: 'pipe',
          },
        ),
      /requires managed workflow storage and managed PostgreSQL/,
    );
    assert.equal(fs.existsSync(path.join(root, 'settings', 'deployment-storage.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('established object storage cannot change location, even across a filesystem-mode detour', async () => {
  await withDeploymentStorageSettings(
    {
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseConnectionString: 'postgresql://user:pass@db.example.test/rivet',
      storageUrl: 'https://original.sfo3.digitaloceanspaces.com',
      storageAccessKeyId: 'access',
      storageAccessKey: 'secret',
    },
    async () => {
      await assert.rejects(
        deploymentStorageSettings.writeDeploymentStorageSettings({
          storageUrl: 'https://different.sfo3.digitaloceanspaces.com',
        }),
        /operator migration/,
      );
      const current = await deploymentStorageSettings.readDeploymentStorageSettings();
      await assert.rejects(
        deploymentStorageSettings.writeDeploymentStorageSettings({
          objectStorageBucket: current.objectStorageBucket,
          objectStorageEndpoint: current.objectStorageEndpoint,
          objectStorageRegion: 'another-region',
          objectStoragePrefix: current.objectStoragePrefix,
          objectStorageForcePathStyle: current.objectStorageForcePathStyle,
        }),
        /operator migration/,
      );
      assert.equal(storageConfig.getManagedWorkflowStorageConfig().objectStorageBucket, 'original');
      await deploymentStorageSettings.writeDeploymentStorageSettings({ storageMode: 'filesystem' });
      await assert.rejects(
        deploymentStorageSettings.writeDeploymentStorageSettings({
          storageMode: 'managed',
          objectStorageBucket: 'different',
          objectStorageEndpoint: current.objectStorageEndpoint,
          objectStorageRegion: current.objectStorageRegion,
          objectStoragePrefix: current.objectStoragePrefix,
          objectStorageForcePathStyle: current.objectStorageForcePathStyle,
        }),
        /operator migration/,
      );
      await deploymentStorageSettings.writeDeploymentStorageSettings({ storageMode: 'managed' });
      assert.equal(storageConfig.getManagedWorkflowStorageConfig().objectStorageBucket, 'original');
    },
  );
});

test('replicated deployment refuses storage writes even when invoked directly', async () => {
  await withEmptyDeploymentStorageEnv({ RIVET_APP_DATA_ROOT: undefined }, async () => {
    const previous = process.env.RIVET_DEPLOYMENT_TOPOLOGY;
    process.env.RIVET_DEPLOYMENT_TOPOLOGY = 'replicated';
    try {
      assert.equal((await deploymentStorageSettings.readDeploymentStorageSettings()).deploymentManaged, true);
      await assert.rejects(
        deploymentStorageSettings.writeDeploymentStorageSettings({ storageMode: 'filesystem' }),
        /managed by the deployment/,
      );
    } finally {
      if (previous === undefined) delete process.env.RIVET_DEPLOYMENT_TOPOLOGY;
      else process.env.RIVET_DEPLOYMENT_TOPOLOGY = previous;
    }
  });
});

test('Kubernetes projection refuses an authoritative local-storage row', () => {
  assert.throws(
    () =>
      deploymentStorageSettings.assertKubernetesStorageModes({ storageMode: 'filesystem', databaseMode: 'managed' }),
    /ephemeral local storage/,
  );
  assert.throws(
    () =>
      deploymentStorageSettings.assertKubernetesStorageModes({ storageMode: 'managed', databaseMode: 'local-docker' }),
    /ephemeral local storage/,
  );
  assert.doesNotThrow(() =>
    deploymentStorageSettings.assertKubernetesStorageModes({ storageMode: 'managed', databaseMode: 'managed' }),
  );
});

test('explicit object location rejects partial and unsafe settings', async () => {
  await withEmptyDeploymentStorageEnv({}, async () => {
    await assert.rejects(
      deploymentStorageSettings.writeDeploymentStorageSettings({ objectStorageBucket: 'rivet' }),
      /supplied together/,
    );
    await assert.rejects(
      deploymentStorageSettings.writeDeploymentStorageSettings({
        objectStorageBucket: 'rivet',
        objectStorageEndpoint: 'https://objects.example.test/path',
        objectStorageRegion: 'region-1',
        objectStoragePrefix: 'workflows/',
        objectStorageForcePathStyle: true,
      }),
      /HTTP\(S\) origin/,
    );
    await assert.rejects(
      deploymentStorageSettings.writeDeploymentStorageSettings({
        objectStorageBucket: 'rivet',
        objectStorageEndpoint: 'https://objects.example.test',
        objectStorageRegion: 'region-1',
        objectStoragePrefix: '../workflows/',
        objectStorageForcePathStyle: true,
      }),
      /relative path/,
    );
  });
});

test('managed storage config ignores retired alias env names', async () => {
  await withEmptyDeploymentStorageEnv(
    {
      RIVET_WORKFLOWS_STORAGE_BACKEND: 'managed',
    },
    () => {
      assert.equal(storageConfig.getWorkflowStorageBackendMode(), 'filesystem');
    },
  );
});

test('managed storage config ignores retired legacy workflow-prefixed env names when settings are saved', async () => {
  await withManagedEnv(
    {
      RIVET_WORKFLOWS_DATABASE_MODE: 'managed',
      RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: 'postgresql://legacy-user:legacy-pass@example-db:25060/defaultdb',
      RIVET_WORKFLOWS_STORAGE_URL: 'https://legacy-bucket.lon1.digitaloceanspaces.com',
      RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: 'legacy-access-key-id',
      RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: 'legacy-secret-access-key',
    },
    async () => {
      await withDeploymentStorageSettings(
        {
          storageMode: 'managed',
          databaseMode: 'managed',
          databaseConnectionString: 'postgresql://saved-user:saved-pass@example-db:25060/defaultdb',
          storageUrl: 'https://saved-bucket.lon1.digitaloceanspaces.com',
          storageAccessKeyId: 'saved-access-key-id',
          storageAccessKey: 'saved-secret-access-key',
        },
        () => {
          const config = storageConfig.getManagedWorkflowStorageConfig();
          assert.equal(config.databaseUrl, 'postgresql://saved-user:saved-pass@example-db:25060/defaultdb');
          assert.equal(config.objectStorageBucket, 'saved-bucket');
          assert.equal(config.objectStorageAccessKeyId, 'saved-access-key-id');
        },
      );
    },
  );
});

test('managed revision blob keys do not duplicate the workflows namespace segment', () => {
  assert.equal(
    blobStore.createRevisionBlobKey('workflow-123', 'revision-456', 'project'),
    'workflow-123/revisions/revision-456/project.rivet-project',
  );
  assert.equal(
    blobStore.createRevisionBlobKey('workflow-123', 'revision-456', 'dataset'),
    'workflow-123/revisions/revision-456/dataset.rivet-data',
  );
});

test('managed recording blob keys do not duplicate the workflows namespace segment', () => {
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'recording'),
    'workflow-123/recordings/recording-456/recording.rivet-recording',
  );
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'replay-project'),
    'workflow-123/recordings/recording-456/replay.rivet-project',
  );
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'replay-dataset'),
    'workflow-123/recordings/recording-456/replay.rivet-data',
  );
});

test('shared env integer parsers preserve fallback and clamp semantics', () => {
  assert.equal(envParsing.parsePositiveInt(undefined, 7), 7);
  assert.equal(envParsing.parsePositiveInt('0', 7), 7);
  assert.equal(envParsing.parsePositiveInt('-5', 7), 7);
  assert.equal(envParsing.parsePositiveInt('9', 7), 9);

  assert.equal(envParsing.parseIntWithMinimum(undefined, 7, 0), 7);
  assert.equal(envParsing.parseIntWithMinimum('-5', 7, 0), 0);
  assert.equal(envParsing.parseIntWithMinimum('0', 7, 0), 0);
  assert.equal(envParsing.parseIntWithMinimum('9', 7, 0), 9);
});
