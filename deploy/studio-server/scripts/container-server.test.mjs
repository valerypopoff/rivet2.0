import test, { mock } from 'node:test';
// test-style: fixture-read: reads only test-owned generated receipts and dotenv artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './lib/env.mjs';
import { initializeServerEnvironment } from './lib/server-launch-mode.mjs';
import {
  ensureContainerStateDirectory,
  writeContainerState,
  containerProcessEnvironment,
  readContainerState,
} from './lib/container-server-files.mjs';
import {
  containerServerConfig,
  containerCredentialDefaults,
  createManagedCompose,
  containerStorageIdentity,
  serializeManagedCompose,
} from './lib/container-server-config.mjs';
import {
  assertContainerInstallationOwned,
  assertContainerDeploymentEvidence,
  startContainerInstallation,
  stopContainerInstallation,
} from './lib/container-server-lifecycle.mjs';
import { parseContainerArgs } from './container-server.mjs';

const images = { api: 'test/api:source', web: 'test/web:source', proxy: 'test/proxy:source' };
function environment(stage) {
  const p = `RIVET_${stage.toUpperCase()}_`;
  return {
    RIVET_KEY: 'test-key-'.repeat(8),
    [p + 'LOCAL_POSTGRES_PASSWORD']: 'private-postgres-password',
    [p + 'LOCAL_S3_ACCESS_KEY_ID']: 'rivet',
    [p + 'LOCAL_S3_SECRET_ACCESS_KEY']: 'private-minio-password',
    [p + 'DATABASE_CONNECTION_STRING']: `postgresql://user:secret@db.example/${stage}`,
    [p + 'STORAGE_BUCKET']: `${stage}-bucket`,
    [p + 'STORAGE_REGION']: 'us-east-1',
    [p + 'STORAGE_ACCESS_KEY_ID']: 'external-id',
    [p + 'STORAGE_ACCESS_KEY']: 'external-secret',
  };
}
test('all six commands share one managed application model without Kubernetes markers or Docker socket mounts', () => {
  for (const stage of ['dev', 'staging', 'prod'])
    for (const choice of ['local-storage', 'external-storage']) {
      const c = containerServerConfig(environment(stage), stage, choice);
      const m = createManagedCompose(c, images);
      assert.equal(m.name, c.project);
      assert.equal(Boolean(m.services.postgres), choice === 'local-storage');
      assert.equal(Boolean(m.services.minio), choice === 'local-storage');
      for (const [name, role] of [
        ['backend', 'control'],
        ['execution', 'execution'],
        ['evaluation', 'evaluation'],
      ]) {
        assert.equal(m.services[name].environment.RIVET_API_PROFILE, role);
        assert.equal(m.services[name].environment.RIVET_MANAGED_WORKFLOW_SCHEMA_MODE, 'verify');
        assert.equal(m.services[name].environment.RIVET_APP_SETTINGS_BACKEND, 'postgres');
        assert.equal(m.services[name].environment.KUBERNETES_SERVICE_HOST, undefined);
      }
      assert.equal(m.services.proxy.ports[0], `127.0.0.1:${c.port}:8080`);
      assert.equal(m.services.postgres?.ports, undefined);
      assert.equal(m.services.minio?.ports, undefined);
      assert.ok(!JSON.stringify(m).includes('docker.sock'));
      assert.equal(m.services.migrate.environment.RIVET_MANAGED_SCHEMA_OFFLINE, '');
      assert.equal(m.services.backend.environment.RIVET_LEGACY_RESTORE_INSTALLATION, `docker/${c.project}`);
      assert.ok(m.services.backend.volumes.includes('restore:/data/rivet-restore'));
      const commands = m.services.migrate.command[0];
      assert.ok(commands.indexOf('migrate-managed-workflow-schema') < commands.indexOf('import-managed-app-settings'));
      assert.ok(commands.indexOf('import-managed-app-settings') < commands.indexOf('project-managed-app-settings'));
      if (choice === 'local-storage') {
        assert.ok(commands.indexOf('/minio/health/ready') < commands.indexOf('HeadBucketCommand'));
        assert.ok(commands.indexOf('HeadBucketCommand') < commands.indexOf('migrate-managed-workflow-schema'));
      } else assert.ok(!commands.includes('CreateBucketCommand'));
    }
});
test('local stores ignore external values; staging/dev never fall back to production credentials', () => {
  const env = { ...environment('prod'), ...environment('dev') };
  const local = containerServerConfig(env, 'dev', 'local-storage');
  assert.ok(local.database.includes('@postgres:5432/'));
  assert.equal(local.objectStorage.endpoint, 'http://minio:9000');
  assert.equal(local.objectStorage.secretAccessKey, 'private-minio-password');
  assert.throws(
    () => containerServerConfig(environment('prod'), 'staging', 'external-storage'),
    /RIVET_STAGING_DATABASE/,
  );
  assert.throws(
    () =>
      containerServerConfig(
        {
          ...environment('dev'),
          ...environment('prod'),
          RIVET_DEV_DATABASE_CONNECTION_STRING: environment('prod').RIVET_PROD_DATABASE_CONNECTION_STRING,
        },
        'dev',
        'external-storage',
      ),
    /separate PostgreSQL/,
  );
  assert.throws(() =>
    containerServerConfig({ ...environment('dev'), RIVET_DEV_COMPOSE_PROJECT: '../bad' }, 'dev', 'local-storage'),
  );
  assert.throws(() => containerServerConfig({ ...environment('dev'), RIVET_DEV_PORT: '2.5' }, 'dev', 'local-storage'));
  assert.throws(
    () =>
      containerServerConfig(
        { ...environment('dev'), RIVET_DEV_STORAGE_ENDPOINT: 'https://secret:password@bucket.example' },
        'dev',
        'external-storage',
      ),
    (e) => !e.message.includes('password@'),
  );
  assert.equal(containerCredentialDefaults('dev', 'external-storage').length, 0);
});

test('Compose serialization preserves literal dollar signs in credentials and migration code', () => {
  const config = containerServerConfig(
    { ...environment('dev'), RIVET_KEY: 'literal-${PASSWORD}-$KEY'.repeat(3) },
    'dev',
    'local-storage',
  );
  const contents = serializeManagedCompose(createManagedCompose(config, images));
  assert.ok(contents.includes('literal-$${PASSWORD}-$$KEY'));
  assert.ok(contents.includes('e.$$metadata'));
  assert.equal(
    JSON.parse(contents).services.backend.environment.RIVET_KEY,
    config.key.replace(/\$/g, () => '$$'),
  );
});
test('foreign containers, unlabelled named volumes and foreign networks block before any mutation', async () => {
  const config = containerServerConfig(environment('dev'), 'dev', 'local-storage');
  const model = createManagedCompose(config, images);
  for (const foreign of ['container', 'volume', 'network', 'changed']) {
    const calls = [];
    const docker = async (args) => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: foreign === 'container' || foreign === 'changed' ? 'id' : '' };
      if (args[0] === 'inspect')
        return {
          stdout: JSON.stringify([
            {
              Config: {
                Labels: {
                  'com.docker.compose.service': 'backend',
                  'rivet.dev/container-installation': foreign === 'container' ? 'other' : config.project,
                  'rivet.dev/storage-identity': 'wrong',
                },
              },
            },
          ]),
        };
      if (args[0] === 'volume' && args[1] === 'ls')
        return { stdout: foreign === 'volume' ? `${config.project}_restore` : '' };
      if (args[0] === 'network' && args[1] === 'ls')
        return { stdout: foreign === 'network' ? `${config.project}_default` : '' };
      return { stdout: JSON.stringify([{ Labels: {} }]) };
    };
    await assert.rejects(assertContainerInstallationOwned(config, docker, model));
    assert.ok(calls.every((args) => ['ps', 'inspect', 'ls'].includes(args[0]) || ['ls', 'inspect'].includes(args[1])));
  }
});
test('ambient Compose controls and host preloads cannot override normalized deployment selection', () => {
  const env = containerProcessEnvironment({
    PATH: 'path',
    DOCKER_HOST: 'selected-engine',
    NODE_OPTIONS: 'preload',
    RIVET_KEY: 'secret',
    COMPOSE_DISABLE_ENV_FILE: 'false',
    COMPOSE_ENV_FILES: 'foreign.env',
    Compose_Profiles: 'foreign',
  });
  assert.deepEqual(env, { PATH: 'path', DOCKER_HOST: 'selected-engine', COMPOSE_DISABLE_ENV_FILE: 'true' });
});
test('private state is atomic and refuses directories linked outside the installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-container-state-'));
  try {
    const directory = ensureContainerStateDirectory(root, 'owned');
    const receipt = path.join(directory, 'pending.json');
    writeContainerState(receipt, JSON.stringify({ version: 1 }));
    assert.equal(readContainerState(receipt), JSON.stringify({ version: 1 }));
    assert.equal(readContainerState(path.join(directory, 'absent.json')), null);
    assert.throws(() => readContainerState(directory), /ordinary files/);
    const linked = mock.method(fs, 'lstatSync', () => ({ isFile: () => true, isSymbolicLink: () => true }));
    try {
      assert.throws(() => readContainerState(receipt), /ordinary files/);
    } finally {
      linked.mock.restore();
    }
    const rename = mock.method(fs, 'renameSync', () => {
      throw Error('interrupted publication');
    });
    try {
      assert.throws(() => writeContainerState(receipt, JSON.stringify({ version: 2 })), /interrupted/);
    } finally {
      rename.mock.restore();
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { version: 1 });
    assert.deepEqual(fs.readdirSync(directory), ['pending.json']);
    writeContainerState(receipt, JSON.stringify({ version: 2 }));
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { version: 2 });
    if (process.platform !== 'win32') assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(root, '.data', 'container-server', 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureContainerStateDirectory(root, 'linked'), /ordinary directories/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(link);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('credential initialization preserves the complete dotenv after an interrupted atomic publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-env-atomic-'));
  const original = '# Keep this comment\r\nRIVET_KEY=existing-private-key\r\nOTHER_SETTING=value';
  try {
    const file = path.join(root, '.env');
    fs.writeFileSync(file, original);
    const rename = mock.method(fs, 'renameSync', () => {
      throw Error('interrupted publication');
    });
    try {
      assert.throws(
        () => initializeServerEnvironment(root, undefined, () => ({ NEW_CREDENTIAL: 'new-secret' })),
        /interrupted/,
      );
    } finally {
      rename.mock.restore();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(root), ['.env']);
    const initialized = initializeServerEnvironment(root, undefined, () => ({ NEW_CREDENTIAL: 'new-secret' }));
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(original + '\n'));
    assert.equal(initialized.source.NEW_CREDENTIAL, 'new-secret');
    assert.equal(initialized.source.RIVET_KEY, 'existing-private-key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('unexpected services and cross-stage resources block before stopping or migrating', async () => {
  const config = containerServerConfig(environment('dev'), 'dev', 'local-storage');
  const model = createManagedCompose(config, images);
  for (const [service, stage, running, failure] of [
    ['backend', 'dev', true, false],
    ['removed-worker', 'dev', true, true],
    ['backend', 'prod', true, true],
    ['migrate', 'dev', true, true],
    ['prepare-volumes', 'dev', true, true],
    ['migrate', 'dev', false, false],
  ]) {
    const docker = async (args) => {
      if (args[0] === 'ps') return { stdout: 'owned' };
      if (args[0] === 'inspect')
        return {
          stdout: JSON.stringify([
            {
              Config: {
                Labels: {
                  'com.docker.compose.service': service,
                  'rivet.dev/deployment-stage': stage,
                  'rivet.dev/container-installation': config.project,
                  'rivet.dev/storage-identity': containerStorageIdentity(config),
                },
              },
              State: { Running: running },
            },
          ]),
        };
      return { stdout: '' };
    };
    if (failure) await assert.rejects(assertContainerInstallationOwned(config, docker, model));
    else assert.equal((await assertContainerInstallationOwned(config, docker, model)).length, 1);
  }
  assert.throws(
    () =>
      containerServerConfig(
        { ...environment('dev'), RIVET_DEV_COMPOSE_PROJECT: 'shared', RIVET_PROD_COMPOSE_PROJECT: 'shared' },
        'dev',
        'local-storage',
      ),
    /separate Compose/,
  );
  assert.throws(
    () => assertContainerDeploymentEvidence(config, [], { installedDigest: 'immutable' }),
    /development launcher/,
  );
  assert.throws(
    () =>
      assertContainerDeploymentEvidence(
        config,
        [{ Config: { Labels: { 'rivet.dev/release-manifest-digest': 'immutable' } } }],
        {},
      ),
    /development launcher/,
  );
});
test('start drains application before migrations and never resumes automatically after a failed/unknown migration', async () => {
  for (const local of [true, false])
    for (const failure of [false, true]) {
      const calls = [];
      const compose = async (args) => {
        calls.push(args);
        if (failure && args.at(-1) === 'migrate') throw Error('outcome unknown');
      };
      const checkPort = async () => {
        calls.push(['check-port']);
      };
      if (failure) await assert.rejects(startContainerInstallation({ local }, compose, checkPort), /unknown/);
      else await startContainerInstallation({ local }, compose, checkPort);
      assert.equal(calls[0][0], 'stop');
      assert.equal(calls[1][0], 'check-port');
      assert.equal(calls.filter((args) => args.at(-1) === 'migrate').length, 1);
      const last = calls.at(-1);
      assert.equal(last[0], failure ? 'run' : 'up');
      assert.equal(
        calls.some((args) => args.includes('postgres')),
        local,
      );
      assert.ok(calls.every((args) => !args.includes('--volumes') && !args.includes('down')));
    }
});
test('an occupied browser port blocks before storage initialization or migration', async () => {
  const calls = [];
  await assert.rejects(
    startContainerInstallation(
      { local: true },
      async (args) => {
        calls.push(args);
      },
      async () => {
        throw Error('occupied');
      },
    ),
    /occupied/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'stop');
});
test('real port collisions identify the selected tier setting before migration', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const calls = [];
    await assert.rejects(
      startContainerInstallation({ stage: 'staging', port: server.address().port, local: false }, async (args) => {
        calls.push(args);
      }),
      /RIVET_STAGING_PORT/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'stop');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
test('partial startup failure drains the new application generation without replaying migrations or stopping storage', async () => {
  for (const drainFails of [false, true]) {
    const calls = [];
    const startupFailure = Error('readiness failed');
    const drainFailure = Error('drain failed');
    const compose = async (args) => {
      calls.push(args);
      if (args[0] === 'up' && args.includes('backend')) throw startupFailure;
      if (drainFails && args[0] === 'stop' && calls.length > 1) throw drainFailure;
    };
    await assert.rejects(
      startContainerInstallation({ local: true }, compose, async () => {}),
      (error) => {
        if (!drainFails) return error === startupFailure;
        return (
          error instanceof AggregateError && error.errors[0] === startupFailure && error.errors[1] === drainFailure
        );
      },
    );
    assert.equal(calls.at(-1)[0], 'stop');
    assert.ok(calls.at(-1).includes('backend'));
    assert.ok(!calls.at(-1).includes('postgres'));
    assert.equal(calls.filter((args) => args.at(-1) === 'migrate').length, 1);
    assert.ok(!calls.some((args) => args.includes('down') || args.includes('--volumes')));
  }
});
test('stop keeps persistence alive until application drain succeeds', async () => {
  for (const local of [true, false]) {
    const calls = [];
    await stopContainerInstallation({ local }, async (args) => {
      calls.push(args);
    });
    assert.equal(calls.length, local ? 2 : 1);
    assert.ok(calls[0].includes('backend'));
    assert.ok(!calls[0].includes('postgres'));
    if (local) assert.deepEqual(calls[1].slice(-2), ['postgres', 'minio']);
  }
  let calls = 0;
  await assert.rejects(
    stopContainerInstallation({ local: true }, async () => {
      calls++;
      throw Error('drain failed');
    }),
  );
  assert.equal(calls, 1);
});
test('failed first immutable deployment is recoverable only with its matching pending receipt', () => {
  const config = containerServerConfig(environment('prod'), 'prod', 'local-storage');
  const container = {
    Config: { Labels: { 'com.docker.compose.service': 'backend', 'rivet.dev/release-manifest-digest': 'selected' } },
  };
  const evidence = {
    selectedDigest: 'selected',
    installedDigest: null,
    pending: { project: config.project, storageIdentity: containerStorageIdentity(config), digest: 'selected' },
  };
  assert.doesNotThrow(() => assertContainerDeploymentEvidence(config, [container], evidence));
  assert.throws(
    () => assertContainerDeploymentEvidence(config, [container], { ...evidence, pending: null }),
    /missing/,
  );
  for (const field of ['project', 'storageIdentity', 'digest'])
    assert.throws(
      () =>
        assertContainerDeploymentEvidence(config, [container], {
          ...evidence,
          pending: { ...evidence.pending, [field]: 'foreign' },
        }),
      /same target/,
    );
  assert.throws(
    () =>
      assertContainerDeploymentEvidence(
        config,
        [
          {
            Config: {
              Labels: {
                ...container.Config.Labels,
                'rivet.dev/release-manifest-digest': 'unknown',
              },
            },
          },
        ],
        evidence,
      ),
    /do not match/,
  );
});
test('storage fingerprint detects routing/key changes and CLI accepts only explicit operations', () => {
  const c = containerServerConfig(environment('dev'), 'dev', 'local-storage');
  assert.notEqual(containerStorageIdentity(c), containerStorageIdentity({ ...c, key: 'different-key' }));
  assert.notEqual(containerStorageIdentity(c), containerStorageIdentity({ ...c, sslMode: 'require' }));
  assert.notEqual(
    containerStorageIdentity(c),
    containerStorageIdentity({ ...c, settingsKey: 'dedicated-encryption-key' }),
  );
  assert.equal(containerStorageIdentity(c), containerStorageIdentity({ ...c, previousSettingsKey: 'older-key' }));
  assert.deepEqual(parseContainerArgs(['--', '--manifest', 'release.json', '--confirm', 'rivet-prod-local']), {
    '--manifest': 'release.json',
    '--confirm': 'rivet-prod-local',
  });
  for (const args of [['--volumes'], ['--stop', '--offline'], ['--confirm'], ['--stop', '--stop']])
    assert.throws(() => parseContainerArgs(args));
});

test(
  'real Docker partial startup drains producers, preserves stores and recovers forward',
  {
    skip: process.env.RIVET_CONTAINER_LIFECYCLE_CHECK !== '1',
    timeout: 600_000,
  },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    assert.ok(process.env.RIVET_ENV_FILE, 'Use a private fixture dotenv, never the default installation.');
    const config = containerServerConfig(
      parseEnvFile(path.resolve(root, process.env.RIVET_ENV_FILE)),
      'dev',
      'local-storage',
      root,
    );
    assert.equal(config.project, 'rivet-container-test');
    const directory = ensureContainerStateDirectory(root, config.project);
    const lockPath = path.join(directory, 'launcher.lock');
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    try {
      const file = path.join(directory, 'compose.private.json');
      const model = JSON.parse(readContainerState(file));
      assert.ok(model?.services && model?.volumes, 'Start the disposable installation before this fixture.');
      const docker = async (args) => ({
        stdout: execFileSync('docker', args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 360_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: containerProcessEnvironment(process.env),
        }),
      });
      const compose = (args) => docker(['compose', '-p', config.project, '-f', file, ...args]);
      await assertContainerInstallationOwned(config, docker, model);
      const unknownOutcome = Error('Injected readiness acknowledgement loss after real startup');
      await assert.rejects(
        startContainerInstallation(config, async (args) => {
          await compose(args);
          if (args[0] === 'up' && args.includes('backend')) throw unknownOutcome;
        }),
        (error) => error === unknownOutcome,
      );
      const stopped = await assertContainerInstallationOwned(config, docker, model);
      for (const container of stopped) {
        const service = container.Config.Labels['com.docker.compose.service'];
        if (['postgres', 'minio'].includes(service)) assert.equal(container.State.Running, true);
        else assert.equal(container.State.Running, false);
      }
      // Explicit forward recovery, not an automatic replay by the failure handler.
      await startContainerInstallation(config, compose);
      const recovered = await assertContainerInstallationOwned(config, docker, model);
      for (const container of recovered) {
        assert.equal(container.State.Running, true);
        if (container.State.Health) assert.equal(container.State.Health.Status, 'healthy');
      }
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  },
);
