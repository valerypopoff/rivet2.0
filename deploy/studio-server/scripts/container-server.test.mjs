import test, { mock } from 'node:test';
// test-style: fixture-read: reads the published dotenv setup template and test-owned receipt/dotenv artifacts, not implementation text.
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
import {
  containerDevelopmentBuildArgs,
  containerStartupMessage,
  ensureContainerDevelopmentMountPoints,
  parseContainerArgs,
} from './container-server.mjs';

const images = { api: 'test/api:source', web: 'test/web:source', proxy: 'test/proxy:source' };
function environment(stage) {
  const p = `RIVET_${stage.toUpperCase()}_`;
  return {
    RIVET_KEY: 'test-key-'.repeat(8),
    RIVET_LOCAL_POSTGRES_PASSWORD: 'private-postgres-password',
    RIVET_LOCAL_S3_ACCESS_KEY_ID: 'rivet',
    RIVET_LOCAL_S3_SECRET_ACCESS_KEY: 'private-minio-password',
    [p + 'DATABASE_CONNECTION_STRING']: `postgresql://user:secret@db.example/${stage}`,
    [p + 'STORAGE_BUCKET']: `${stage}-bucket`,
    [p + 'STORAGE_REGION']: 'us-east-1',
    [p + 'STORAGE_ACCESS_KEY_ID']: 'external-id',
    [p + 'STORAGE_ACCESS_KEY']: 'external-secret',
  };
}

test('only development uses source-bound watched bundles; managed storage and auth are unchanged', () => {
  const sourceRoot = path.resolve('fixture checkout with spaces');
  for (const storage of ['local-storage', 'external-storage']) {
    for (const stage of ['dev', 'staging', 'prod']) {
      const config = containerServerConfig(environment(stage), stage, storage);
      const model = createManagedCompose(config, images, { sourceRoot });
      const web = model.services.web;
      assert.equal(web.read_only, true);
      assert.equal(model.services.proxy.environment.RIVET_KEY, config.key);
      assert.deepEqual(model.services.proxy.ports, [`127.0.0.1:${config.port}:8080`]);
      assert.equal(model.services.proxy.environment.RIVET_WEB_UPSTREAM_PORT, stage === 'dev' ? '5174' : '3000');
      if (stage !== 'dev') {
        assert.equal(web.volumes, undefined);
        assert.equal(model.volumes['web-development'], undefined);
        continue;
      }
      assert.equal(web.init, true);
      assert.equal(web.healthcheck.start_period, '900s');
      assert.ok(
        web.tmpfs.includes('/app/packages/studio-server-web/node_modules:rw,nosuid,size=512m,uid=10001,gid=10001'),
      );
      assert.match(web.healthcheck.test.at(-1), /5174\/readyz/);
      const sources = web.volumes.filter((mount) => mount.type === 'bind');
      for (const mount of sources) {
        assert.equal(mount.read_only, true);
        assert.equal(mount.bind.create_host_path, false);
        assert.ok(mount.source.startsWith(sourceRoot + path.sep));
        assert.ok(!/\.env|node_modules|\.git|\.data/.test(mount.target));
        assert.equal(mount.target, '/app/' + path.relative(sourceRoot, mount.source).split(path.sep).join('/'));
      }
      for (const required of ['packages/app/src', 'packages/core/src', 'packages/studio-server-web'])
        assert.ok(sources.some((mount) => mount.target === `/app/${required}`));
      assert.deepEqual(model.volumes['web-development'].labels, {
        'rivet.dev/container-installation': config.project,
        'rivet.dev/storage-identity': containerStorageIdentity(config),
      });
      assert.equal(web.ports, undefined);
      assert.ok(
        !web.volumes.some((mount) => mount.type === 'volume'),
        'Development must not orphan anonymous dependency volumes',
      );
    }
  }
});

test('development builds select the watched web target but not an API or proxy target', () => {
  assert.deepEqual(containerDevelopmentBuildArgs('web', images.web), [
    'build',
    '-f',
    'deploy/studio-server/images/web/Dockerfile',
    '--target',
    'development',
    '-t',
    images.web,
    '.',
  ]);
  for (const name of ['api', 'proxy'])
    assert.ok(!containerDevelopmentBuildArgs(name, images[name]).includes('--target'));
});

test('every bound development input exists in the checkout', () => {
  const config = containerServerConfig(environment('dev'), 'dev', 'local-storage');
  for (const mount of createManagedCompose(config, images).services.web.volumes) {
    if (mount.type === 'bind') assert.ok(fs.existsSync(mount.source), `Missing source input: ${mount.source}`);
  }
});

test('development dependency mountpoint preparation supports PnP and preserves existing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-web-mountpoint-'));
  try {
    ensureContainerDevelopmentMountPoints(root);
    const directory = path.join(root, 'packages/studio-server-web/node_modules');
    assert.deepEqual(fs.readdirSync(directory), []);
    fs.writeFileSync(path.join(directory, 'host-marker'), 'retained');
    ensureContainerDevelopmentMountPoints(root);
    assert.equal(fs.readFileSync(path.join(directory, 'host-marker'), 'utf8'), 'retained');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only development extends application readiness for the first watched compilation', async () => {
  for (const stage of ['dev', 'staging', 'prod']) {
    const calls = [];
    await startContainerInstallation(
      { stage, local: false },
      async (args) => {
        calls.push(args);
        return {};
      },
      async () => {},
    );
    const start = calls.find((args) => args[0] === 'up');
    assert.equal(start[start.indexOf('--wait-timeout') + 1], stage === 'dev' ? '1200' : '300');
    assert.equal(start.includes('--renew-anon-volumes'), false);
    assert.equal(
      containerStartupMessage({ stage, port: 8081 }).includes('source watching is enabled'),
      stage === 'dev',
    );
  }
});

test('the shared dotenv example declares the complete current launcher input contract without retired assignments', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const declarations = [...example.matchAll(/^# (RIVET_[A-Z0-9_]+)=([^\r\n]*)$/gm)];
  const shared = [
    'RIVET_KEY',
    'RIVET_APP_SETTINGS_ENCRYPTION_KEY',
    'RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS',
    'RIVET_PORT',
    'RIVET_SERVER_UI_AUTH_MODE',
    'RIVET_LOCAL_POSTGRES_PASSWORD',
    'RIVET_LOCAL_S3_ACCESS_KEY_ID',
    'RIVET_LOCAL_S3_SECRET_ACCESS_KEY',
  ];
  const fields = [
    'KEY',
    'APP_SETTINGS_ENCRYPTION_KEY',
    'APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS',
    'COMPOSE_PROJECT',
    'DATABASE_CONNECTION_STRING',
    'DATABASE_SSL_MODE',
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_REGION',
    'STORAGE_PREFIX',
    'STORAGE_FORCE_PATH_STYLE',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_ACCESS_KEY',
  ];
  const expected = [
    ...shared,
    ...['DEV', 'STAGING', 'PROD'].flatMap((stage) => fields.map((field) => `RIVET_${stage}_${field}`)),
  ];
  assert.deepEqual(declarations.map((match) => match[1]).sort(), expected.sort());
  // Copying the template alone is intentionally a blank local-start configuration.
  assert.ok(!/^[A-Z][A-Z0-9_]*=/m.test(example));
});

test('documented local auto-initialization and explicit external examples configure every tier without Docker', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const externalFields = new Set([
    'DATABASE_CONNECTION_STRING',
    'DATABASE_SSL_MODE',
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_REGION',
    'STORAGE_PREFIX',
    'STORAGE_FORCE_PATH_STYLE',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_ACCESS_KEY',
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-documented-env-'));
  try {
    for (const stage of ['dev', 'staging', 'prod']) {
      const prefix = `RIVET_${stage.toUpperCase()}_`;
      for (const storage of ['local-storage', 'external-storage']) {
        const file = path.join(root, `${stage}-${storage}.env`);
        const selected =
          storage === 'local-storage'
            ? example
            : example.replace(/^# (RIVET_[A-Z0-9_]+)=([^\r\n]*)$/gm, (line, name, value) => {
                if (name === 'RIVET_KEY') return `${name}=${'fixture-auth-key-'.repeat(4)}`;
                if (!name.startsWith(prefix) || !externalFields.has(name.slice(prefix.length))) return line;
                const safe = value.startsWith('replace-with-')
                  ? 'fixture-secret'
                  : value.replace('replace-with-password', 'fixture-password');
                return `${name}=${safe}`;
              });
        fs.writeFileSync(file, selected);
        if (storage === 'local-storage') {
          initializeServerEnvironment(root, file, () => ({
            RIVET_KEY: 'fixture-auth-key-'.repeat(4),
            ...Object.fromEntries(
              containerCredentialDefaults(stage, storage).map(([name, fixed]) => [
                name,
                fixed || 'fixture-private-secret',
              ]),
            ),
          }));
        }
        const config = containerServerConfig(parseEnvFile(file), stage, storage);
        const model = createManagedCompose(config, images);
        assert.equal(config.project, `rivet-${stage}-${storage === 'local-storage' ? 'local' : 'external'}`);
        assert.equal(config.port, { dev: 8080, staging: 8082, prod: 8083 }[stage]);
        assert.equal(config.sslMode, storage === 'local-storage' ? 'disable' : 'verify-full');
        assert.equal(Boolean(model.services.postgres), storage === 'local-storage');
        assert.equal(Boolean(model.services.minio), storage === 'local-storage');
        assert.equal(
          config.objectStorage.endpoint,
          storage === 'local-storage' ? 'http://minio:9000' : stage === 'prod' ? '' : `https://s3.${stage}.example`,
        );
        assert.equal(
          config.objectStorage.forcePathStyle,
          storage === 'external-storage' && stage === 'prod' ? 'false' : 'true',
        );
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local credentials are initialized once and reused across all tiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-shared-local-env-'));
  const file = path.join(root, '.env');
  try {
    fs.writeFileSync(file, `RIVET_KEY=${environment('dev').RIVET_KEY}\n`);
    for (const stage of ['dev', 'staging', 'prod']) {
      initializeServerEnvironment(root, file, (source) =>
        Object.fromEntries(
          containerCredentialDefaults(stage, 'local-storage', source).map(([name, fixed]) => [
            name,
            fixed || 'fixture-original-secret',
          ]),
        ),
      );
      const source = parseEnvFile(file);
      const config = containerServerConfig(source, stage, 'local-storage');
      assert.equal(config.password, 'fixture-original-secret');
      assert.equal(config.objectStorage.accessKeyId, 'rivet');
      assert.equal(config.objectStorage.secretAccessKey, 'fixture-original-secret');
    }
    const saved = fs.readFileSync(file, 'utf8');
    for (const [name] of containerCredentialDefaults('dev', 'local-storage'))
      assert.equal(saved.split(`${name}=`).length, 2);
    assert.equal(containerCredentialDefaults('prod', 'external-storage').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy tier credentials migrate without rotating secrets or changing storage identity', () => {
  for (const legacyTier of ['DEV', 'STAGING', 'PROD']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-local-credential-upgrade-'));
    const file = path.join(root, '.env');
    try {
      const original = environment('dev');
      const legacy = { ...original };
      for (const [name] of containerCredentialDefaults('dev', 'local-storage')) {
        legacy[name.replace('RIVET_', `RIVET_${legacyTier}_`)] = legacy[name];
        delete legacy[name];
      }
      const expectedIdentity = containerStorageIdentity(containerServerConfig(original, 'dev', 'local-storage'));
      // Stops can still resolve legacy names without generating or writing anything.
      assert.equal(containerStorageIdentity(containerServerConfig(legacy, 'dev', 'local-storage')), expectedIdentity);
      fs.writeFileSync(
        file,
        Object.entries(legacy)
          .map(([name, value]) => `${name}=${value}`)
          .join('\n') + '\n',
      );
      initializeServerEnvironment(root, file, (source) =>
        Object.fromEntries(containerCredentialDefaults('dev', 'local-storage', source)),
      );
      const migrated = parseEnvFile(file);
      for (const [name] of containerCredentialDefaults('dev', 'local-storage'))
        assert.equal(migrated[name], original[name]);
      assert.equal(containerStorageIdentity(containerServerConfig(migrated, 'dev', 'local-storage')), expectedIdentity);
      const saved = fs.readFileSync(file, 'utf8');
      initializeServerEnvironment(root, file, (source) =>
        Object.fromEntries(containerCredentialDefaults('prod', 'local-storage', source)),
      );
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('conflicting legacy credentials fail before dotenv mutation; an explicit shared value takes precedence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-local-credential-conflict-'));
  const file = path.join(root, '.env');
  try {
    const base = environment('dev');
    for (const [name] of containerCredentialDefaults('dev', 'local-storage')) {
      const env = {
        ...base,
        [name.replace('RIVET_', 'RIVET_DEV_')]: 'dev-private',
        [name.replace('RIVET_', 'RIVET_PROD_')]: 'prod-private',
      };
      delete env[name];
      const original =
        Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + '\n';
      fs.writeFileSync(file, original);
      assert.throws(() => containerServerConfig(env, 'dev', 'local-storage'), /Legacy local credentials differ/);
      assert.throws(
        () =>
          initializeServerEnvironment(root, file, (source) =>
            Object.fromEntries(containerCredentialDefaults('dev', 'local-storage', source)),
          ),
        /Legacy local credentials differ/,
      );
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.ok(!fs.existsSync(`${file}.rivet-init.lock`));
      assert.doesNotThrow(() => containerServerConfig({ ...env, [name]: base[name] }, 'dev', 'local-storage'));
      assert.doesNotThrow(() => containerServerConfig(env, 'dev', 'external-storage'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
        assert.equal(m.services[name].environment.RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING, c.database);
        assert.equal(m.services[name].environment.RIVET_DEPLOYMENT_DATABASE_SSL_MODE, c.sslMode);
        assert.equal(m.services[name].environment.RIVET_DEPLOYMENT_STORAGE_ENDPOINT, c.objectStorage.endpoint);
        assert.equal(m.services[name].environment.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY, c.objectStorage.secretAccessKey);
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
test('shared port and UI auth configure all six deployments without changing internal ports or storage identity', () => {
  for (const stage of ['dev', 'staging', 'prod']) {
    for (const storage of ['local-storage', 'external-storage']) {
      const base = containerServerConfig(environment(stage), stage, storage);
      assert.equal(base.uiAuthMode, 'key');
      for (const mode of ['key', 'oauth']) {
        const config = containerServerConfig(
          {
            ...environment(stage),
            RIVET_PORT: '8081',
            RIVET_DEV_PORT: '9991',
            RIVET_STAGING_PORT: '9992',
            RIVET_PROD_PORT: '9993',
            RIVET_SERVER_UI_AUTH_MODE: mode,
            RIVET_ENABLE_DEVELOPMENT_AUTH: 'true',
            RIVET_DEVELOPMENT_AUTH_CLIENTS: '0.0.0.0/0',
          },
          stage,
          storage,
        );
        const model = createManagedCompose(config, images);
        assert.equal(config.port, 8081);
        assert.equal(containerStorageIdentity(config), containerStorageIdentity(base));
        assert.deepEqual(model.services.proxy.ports, ['127.0.0.1:8081:8080']);
        for (const service of ['backend', 'execution', 'evaluation', 'migrate']) {
          const env = model.services[service].environment;
          assert.equal(env.RIVET_SERVER_UI_AUTH_MODE, mode);
          assert.equal(env.RIVET_REQUIRE_UI_GATE_KEY, 'true');
          assert.equal(env.RIVET_KEY, config.key);
          assert.equal(env.RIVET_ENABLE_DEVELOPMENT_AUTH, undefined);
          assert.equal(env.RIVET_DEVELOPMENT_AUTH_CLIENTS, undefined);
        }
        assert.equal(model.services.backend.environment.PORT, '8080');
        assert.equal(model.services.backend.environment.RIVET_BACKEND_EXECUTOR_PORT, '21889');
      }
    }
  }
});

test('shared port and auth validation reject unsafe inputs before generating container configuration', () => {
  const env = environment('dev');
  for (const port of ['', '0', '65536', '2.5', '-1', '8081 # comment'])
    assert.throws(() => containerServerConfig({ ...env, RIVET_PORT: port }, 'dev', 'local-storage'), /RIVET_PORT/);
  for (const mode of ['', 'none', 'off', 'invalid', 'oauth # comment'])
    assert.throws(
      () => containerServerConfig({ ...env, RIVET_SERVER_UI_AUTH_MODE: mode }, 'dev', 'local-storage'),
      /RIVET_SERVER_UI_AUTH_MODE/,
    );
  assert.equal(
    containerServerConfig({ ...env, RIVET_SERVER_UI_AUTH_MODE: ' OAuth ' }, 'dev', 'local-storage').uiAuthMode,
    'oauth',
  );
});

test('startup guidance follows the selected auth mode and never prints credentials', () => {
  for (const mode of ['key', 'oauth']) {
    const config = containerServerConfig(
      {
        ...environment('dev'),
        RIVET_PORT: '8081',
        RIVET_SERVER_UI_AUTH_MODE: mode,
      },
      'dev',
      'local-storage',
    );
    const message = containerStartupMessage(config);
    assert.ok(message.startsWith('Rivet started: http://127.0.0.1:8081.'));
    assert.ok(message.endsWith('Existing data was not imported or deleted.'));
    if (mode === 'oauth') {
      assert.ok(message.includes('Sign in using your configured OAuth provider.'));
      assert.ok(message.includes('key-mode setup'));
      assert.ok(!message.includes('Sign in using the selected tier key'));
    } else assert.ok(message.includes('Sign in using the selected tier key or RIVET_KEY'));
    for (const secret of [config.key, config.password, config.objectStorage.secretAccessKey])
      assert.ok(!message.includes(secret));
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
  assert.throws(() => containerServerConfig({ ...environment('dev'), RIVET_PORT: '2.5' }, 'dev', 'local-storage'));
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
  for (const connection of ['postgresql://db.example', 'postgresql://db.example/']) {
    assert.throws(
      () =>
        containerServerConfig(
          { ...environment('dev'), RIVET_DEV_DATABASE_CONNECTION_STRING: connection },
          'dev',
          'external-storage',
        ),
      /identify a database/,
    );
  }
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

test('only verified restore preparation starts recovery consumers; other migration outcomes stay blocked', async () => {
  for (const exitCode of [null, undefined, 1, 74, 75, 76]) {
    const calls = [];
    const failure = Object.assign(Error('Preparation result; text is not a decision signal'), { exitCode });
    const startup = startContainerInstallation(
      { local: true },
      async (args, options) => {
        calls.push(args);
        if (args[0] === 'run' && args.at(-1) === 'migrate') {
          assert.deepEqual(options.acceptedExitCodes, [75]);
          if (exitCode === 75) return { exitCode };
          throw failure;
        }
      },
      async () => {},
    );
    if (exitCode === 75) {
      assert.deepEqual(await startup, { restoreRecovery: true });
      assert.equal(calls.at(-1)[0], 'up');
      assert.ok(calls.at(-1).includes('backend'));
      const message = containerStartupMessage({ port: 8081, uiAuthMode: 'key' }, { restoreRecovery: true });
      assert.match(message, /8081\/\?restore-legacy-backup/);
      assert.match(message, /pending restore was retained/);
      assert.match(message, /no schema migration or settings seeding/);
    } else {
      await assert.rejects(startup, (error) => error === failure);
      assert.equal(calls.at(-1).at(-1), 'migrate');
    }
    assert.equal(calls.filter((args) => args.at(-1) === 'migrate').length, 1);
    assert.ok(calls.every((args) => !args.includes('down') && !args.includes('--volumes')));
  }
});

test('failed recovery readiness still drains producers without replaying preparation', async () => {
  const calls = [];
  const failure = Error('Recovery consumer failed');
  await assert.rejects(
    startContainerInstallation(
      { local: false },
      async (args) => {
        calls.push(args);
        if (args.at(-1) === 'migrate') return { exitCode: 75 };
        if (args[0] === 'up') throw failure;
      },
      async () => {},
    ),
    (error) => error === failure,
  );
  assert.equal(calls.at(-1)[0], 'stop');
  assert.equal(calls.filter((args) => args.at(-1) === 'migrate').length, 1);
});
test('real port collisions identify the shared port setting before migration', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const calls = [];
    await assert.rejects(
      startContainerInstallation({ stage: 'staging', port: server.address().port, local: false }, async (args) => {
        calls.push(args);
      }),
      /RIVET_PORT/,
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
