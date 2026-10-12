import { createHash } from 'node:crypto';
import { readManagedWorkflowSchemaReleaseContract } from './studio-server-release-manifest.mjs';

export const containerStages = ['dev', 'staging', 'prod'];
export const containerStorageChoices = ['local-storage', 'external-storage'];
const apiScriptRoot = '/app/packages/studio-server-api/dist/studio-server-api/src';
const minioImage =
  'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4';

function value(env, name, fallback = '') {
  return String(env[name] ?? fallback).trim();
}
function requireValue(env, name, fallback) {
  const result = value(env, name, fallback);
  if (!result || result.startsWith('replace-')) throw new Error(`Configure ${name} in the shared .env.`);
  return result;
}
export function containerCredentialDefaults(stage, storage) {
  if (!containerStages.includes(stage) || !containerStorageChoices.includes(storage))
    throw new Error('Invalid container deployment selection.');
  return storage === 'local-storage'
    ? [
        [`RIVET_${stage.toUpperCase()}_LOCAL_POSTGRES_PASSWORD`, null],
        [`RIVET_${stage.toUpperCase()}_LOCAL_S3_ACCESS_KEY_ID`, 'rivet'],
        [`RIVET_${stage.toUpperCase()}_LOCAL_S3_SECRET_ACCESS_KEY`, null],
      ]
    : [];
}

export function containerServerConfig(env, stage, storage, root = process.cwd()) {
  if (!containerStages.includes(stage) || !containerStorageChoices.includes(storage))
    throw new Error('Invalid container deployment selection.');
  const prefix = `RIVET_${stage.toUpperCase()}_`;
  const local = storage === 'local-storage';
  const project = value(env, prefix + 'COMPOSE_PROJECT', `rivet-${stage}-${local ? 'local' : 'external'}`);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(project))
    throw new Error('Compose project must be a lowercase label of at most 40 characters.');
  if (
    containerStages.some(
      (other) => other !== stage && value(env, `RIVET_${other.toUpperCase()}_COMPOSE_PROJECT`) === project,
    )
  )
    throw new Error('Deployment stages must use separate Compose projects.');
  const key = requireValue(env, prefix + 'KEY', env.RIVET_KEY);
  if (key.length < 32) throw new Error('Rivet authentication key must have at least 32 characters.');
  const settingsKey = value(env, prefix + 'APP_SETTINGS_ENCRYPTION_KEY', env.RIVET_APP_SETTINGS_ENCRYPTION_KEY) || key;
  const previousSettingsKey = value(
    env,
    prefix + 'APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS',
    env.RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS,
  );
  const port = value(env, prefix + 'PORT', stage === 'dev' ? '8080' : stage === 'staging' ? '8082' : '8083');
  if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535)
    throw new Error('Rivet host port must be between 1 and 65535.');
  const external = (name, fallback) =>
    requireValue(env, prefix + name, stage === 'prod' ? value(env, `RIVET_K8S_${name}`, fallback) : fallback);
  const password = local ? requireValue(env, prefix + 'LOCAL_POSTGRES_PASSWORD') : '';
  const database = local
    ? `postgresql://rivet:${encodeURIComponent(password)}@postgres:5432/rivet`
    : external('DATABASE_CONNECTION_STRING');
  let url;
  try {
    url = new URL(database);
  } catch {
    throw new Error('Invalid PostgreSQL connection string.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname === '/')
    throw new Error('PostgreSQL URL must identify a database.');
  const objectStorage = local
    ? {
        endpoint: 'http://minio:9000',
        bucket: 'rivet',
        region: 'us-east-1',
        prefix: 'workflows/',
        forcePathStyle: 'true',
        accessKeyId: requireValue(env, prefix + 'LOCAL_S3_ACCESS_KEY_ID'),
        secretAccessKey: requireValue(env, prefix + 'LOCAL_S3_SECRET_ACCESS_KEY'),
      }
    : {
        endpoint: value(env, prefix + 'STORAGE_ENDPOINT', stage === 'prod' ? env.RIVET_K8S_STORAGE_ENDPOINT : ''),
        bucket: external('STORAGE_BUCKET'),
        region: external('STORAGE_REGION'),
        prefix: value(
          env,
          prefix + 'STORAGE_PREFIX',
          stage === 'prod' ? value(env, 'RIVET_K8S_STORAGE_PREFIX', 'workflows/') : 'workflows/',
        ),
        forcePathStyle: value(
          env,
          prefix + 'STORAGE_FORCE_PATH_STYLE',
          stage === 'prod' ? value(env, 'RIVET_K8S_STORAGE_FORCE_PATH_STYLE', 'false') : 'false',
        ),
        accessKeyId: external('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: external('STORAGE_ACCESS_KEY'),
      };
  if (objectStorage.endpoint) {
    let endpoint;
    try {
      endpoint = new URL(objectStorage.endpoint);
    } catch {
      throw new Error('Invalid S3 endpoint.');
    }
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !['', '/'].includes(endpoint.pathname)
    )
      throw new Error('S3 endpoint must be an HTTP(S) origin without credentials.');
  }
  if (!['true', 'false'].includes(objectStorage.forcePathStyle))
    throw new Error('Storage path-style setting must be true or false.');
  if (
    !objectStorage.prefix.endsWith('/') ||
    objectStorage.prefix.startsWith('/') ||
    /[\\]|(^|\/)\.{1,2}(\/|$)|\/\//.test(objectStorage.prefix) ||
    objectStorage.prefix.startsWith('runtime-libraries/')
  )
    throw new Error('Invalid workflow object prefix.');
  if (local && (objectStorage.accessKeyId.length < 3 || objectStorage.secretAccessKey.length < 8))
    throw new Error('Invalid local MinIO credentials.');
  const sslMode = local
    ? 'disable'
    : value(
        env,
        prefix + 'DATABASE_SSL_MODE',
        stage === 'prod' ? value(env, 'RIVET_K8S_DATABASE_SSL_MODE', 'require') : 'require',
      );
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) throw new Error('Invalid database SSL mode.');
  // Separate deployment stages may never silently use the same application catalog.
  if (!local)
    for (const other of containerStages.filter((item) => item !== stage)) {
      const raw = value(
        env,
        `RIVET_${other.toUpperCase()}_DATABASE_CONNECTION_STRING`,
        other === 'prod' ? env.RIVET_K8S_DATABASE_CONNECTION_STRING : '',
      );
      if (!raw) continue;
      let candidate;
      try {
        candidate = new URL(raw);
      } catch {
        continue;
      }
      if (
        candidate.hostname === url.hostname &&
        (candidate.port || '5432') === (url.port || '5432') &&
        candidate.pathname === url.pathname
      )
        throw new Error('Deployment stages must use separate PostgreSQL databases.');
    }
  return {
    stage,
    storage,
    local,
    project,
    key,
    settingsKey,
    previousSettingsKey,
    port: Number(port),
    password,
    database,
    sslMode,
    objectStorage,
    schema: readManagedWorkflowSchemaReleaseContract(root),
  };
}

export function containerStorageIdentity(config) {
  // Password changes also require deliberate reconciliation; never silently
  // restart a retained PostgreSQL/MinIO volume with different credentials.
  return createHash('sha256')
    .update(
      JSON.stringify({
        database: config.database,
        sslMode: config.sslMode,
        key: config.key,
        settingsKey: config.settingsKey === config.key ? undefined : config.settingsKey,
        objectStorage: config.objectStorage,
      }),
    )
    .digest('hex');
}

/** Compose interpolation is not a second secret/template evaluation boundary. */
export function serializeManagedCompose(model) {
  return JSON.stringify(model, null, 2).replace(/\$/g, () => '$$');
}

export function createManagedCompose(config, images, { offline = false, releaseDigest = '' } = {}) {
  const { project, objectStorage: s, schema } = config;
  const labels = {
    'rivet.dev/container-installation': project,
    'rivet.dev/deployment-stage': config.stage,
    'rivet.dev/storage-identity': containerStorageIdentity(config),
    'rivet.dev/schema-reader-version': String(schema.minimumRollbackCompatibleVersion),
    'rivet.dev/release-manifest-digest': releaseDigest,
  };
  const common = {
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
    RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
    RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: config.database,
    RIVET_DEPLOYMENT_DATABASE_SSL_MODE: config.sslMode,
    RIVET_DEPLOYMENT_DATABASE_POOL_MAX: '10',
    RIVET_DEPLOYMENT_STORAGE_ENDPOINT: s.endpoint,
    RIVET_DEPLOYMENT_STORAGE_BUCKET: s.bucket,
    RIVET_DEPLOYMENT_STORAGE_REGION: s.region,
    RIVET_DEPLOYMENT_STORAGE_PREFIX: s.prefix,
    RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: s.forcePathStyle,
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: s.accessKeyId,
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: s.secretAccessKey,
    RIVET_KEY: config.key,
    RIVET_APP_SETTINGS_ENCRYPTION_KEY: config.settingsKey,
    RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS: config.previousSettingsKey,
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_REQUIRE_UI_GATE_KEY: 'true',
    RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify',
    RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION: String(schema.minimumRollbackCompatibleVersion),
    RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION: String(schema.version),
    RIVET_LEGACY_RESTORE_ENABLED: '1',
    RIVET_LEGACY_RESTORE_INSTALLATION: `docker/${project}`,
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_WORKSPACE_ROOT: '/workspace',
    RIVET_WORKFLOWS_ROOT: '/workflows',
    RIVET_APP_DATA_ROOT: '/data/rivet-app',
    RIVET_RUNTIME_LIBRARIES_ROOT: '/data/runtime-libraries',
    RIVET_SHUTDOWN_GRACE_SECONDS: '120',
    RIVET_MANAGED_MAINTENANCE_ENABLED: 'false',
    RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
    RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY: '1',
    RIVET_HOSTED_EVALUATIONS_MAX_JOBS_PER_RUN: '2000',
    RIVET_HOSTED_EVALUATIONS_MAX_OUTSTANDING_JOBS: '10000',
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
  };
  const volumes = {};
  const mount = (name, target) => {
    volumes[name] = {
      labels: {
        'rivet.dev/container-installation': project,
        'rivet.dev/storage-identity': containerStorageIdentity(config),
      },
    };
    return `${name}:${target}`;
  };
  const temporary = ['/tmp:rw,nosuid,size=1g,uid=10001,gid=10001', '/var/tmp:rw,nosuid,size=2g,uid=10001,gid=10001'];
  const health = (port, path = '/readyz') => ({
    test: [
      'CMD',
      'node',
      '-e',
      `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ],
    interval: '5s',
    timeout: '6s',
    retries: 48,
    start_period: '20s',
  });
  const api = (role) => ({
    image: images.api,
    labels,
    restart: 'unless-stopped',
    init: true,
    stop_grace_period: '150s',
    tmpfs: temporary,
    environment: {
      ...common,
      PORT: '8080',
      RIVET_API_PROFILE: role,
      RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: role === 'control' ? 'none' : 'endpoint',
      RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: role === 'control' ? 'true' : 'false',
    },
    volumes: [
      mount(`${role}-app`, '/data/rivet-app'),
      mount(`${role}-libraries`, '/data/runtime-libraries'),
      mount(`${role}-workspace`, '/workspace'),
      mount(`${role}-workflows`, '/workflows'),
    ],
    healthcheck: health(8080),
  });
  const services = { backend: api('control'), execution: api('execution'), evaluation: api('evaluation') };
  Object.assign(services.backend, {
    entrypoint: ['node', '/opt/rivet/backend-supervisor.mjs'],
    healthcheck: health(21890),
    environment: {
      ...services.backend.environment,
      RIVET_BACKEND_API_PORT: '8080',
      RIVET_BACKEND_EXECUTOR_PORT: '21889',
      RIVET_BACKEND_HEALTH_PORT: '21890',
      RIVET_EXECUTOR_RUNTIME_CONFIG_URL: 'http://127.0.0.1:8080/internal/executor-runtime-config',
      RIVET_INTERNAL_PUBLISHED_WORKFLOWS_BASE_URL: 'http://execution:8080/internal/workflows',
      RIVET_INTERNAL_LATEST_WORKFLOWS_BASE_URL: 'http://backend:8080/internal/workflows-latest',
      RIVET_LEGACY_RESTORE_EXECUTION_READY_URL: 'http://execution:8080/readyz',
      RIVET_LEGACY_RESTORE_EVALUATION_READY_URL: 'http://evaluation:8080/readyz',
      RIVET_LEGACY_RESTORE_ROOT: '/data/rivet-restore',
      RIVET_PROJECT_BUNDLE_SCRATCH_ROOT: '/data/project-bundles',
      RIVET_MANAGED_MAINTENANCE_ENABLED: 'true',
    },
  });
  services.backend.volumes.push(
    mount('editor-app', '/home/rivet/.local/share/com.valerypopoff.rivet2'),
    mount('restore', '/data/rivet-restore'),
    mount('bundles', '/data/project-bundles'),
  );
  Object.assign(services.execution.environment, {
    RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE: 'enforce',
    RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS: '4',
    RIVET_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS: '1',
  });
  const prepared = [mount('restore', '/data/rivet-restore'), mount('bundles', '/data/project-bundles')];
  services['prepare-volumes'] = {
    image: images.api,
    labels,
    user: '0:0',
    restart: 'no',
    entrypoint: ['node', '-e'],
    command: [
      "const fs=require('fs'); for(const p of ['/data/rivet-restore','/data/project-bundles']){fs.mkdirSync(p,{recursive:true});fs.chownSync(p,10001,10001);fs.chmodSync(p,0o700)}",
    ],
    volumes: prepared,
  };
  const migrationSteps = [
    `node ${apiScriptRoot}/scripts/migrate-managed-workflow-schema.js migrate`,
    `node ${apiScriptRoot}/scripts/import-managed-app-settings.js`,
    `node ${apiScriptRoot}/scripts/project-managed-app-settings.js`,
  ];
  services.migrate = {
    image: images.api,
    labels,
    restart: 'no',
    tmpfs: temporary,
    entrypoint: ['/bin/sh', '-ec'],
    environment: {
      ...common,
      RIVET_APP_DATA_ROOT: '/var/tmp/rivet-migration-app-data',
      RIVET_HOSTED_EVALUATIONS_ENABLED: 'false',
      RIVET_MANAGED_SCHEMA_OFFLINE: offline ? '1' : '',
      RIVET_DEPLOYMENT_STORAGE_SEED_MISSING: '1',
    },
  };
  services.web = {
    image: images.web,
    labels,
    restart: 'unless-stopped',
    read_only: true,
    tmpfs: temporary,
    healthcheck: health(3000, '/'),
  };
  services.proxy = {
    image: images.proxy,
    labels,
    restart: 'unless-stopped',
    read_only: true,
    ports: [`127.0.0.1:${config.port}:8080`],
    tmpfs: temporary,
    environment: {
      RIVET_KEY: config.key,
      RIVET_WEB_UPSTREAM_HOST: 'web',
      RIVET_WEB_UPSTREAM_PORT: '3000',
      RIVET_API_UPSTREAM_HOST: 'backend',
      RIVET_API_UPSTREAM_PORT: '8080',
      RIVET_EXECUTION_UPSTREAM_HOST: 'execution',
      RIVET_EXECUTION_UPSTREAM_PORT: '8080',
      RIVET_EXECUTOR_UPSTREAM_HOST: 'backend',
      RIVET_EXECUTOR_UPSTREAM_PORT: '21889',
      RIVET_PROXY_SETTINGS_URL: 'http://backend:8080/internal/app-settings/proxy-config',
      RIVET_PROXY_RESOLVER: '127.0.0.11',
    },
    depends_on: {
      backend: { condition: 'service_healthy' },
      execution: { condition: 'service_healthy' },
      web: { condition: 'service_healthy' },
    },
    healthcheck: {
      test: ['CMD-SHELL', 'curl --fail --silent http://127.0.0.1:18080/stub_status >/dev/null'],
      interval: '5s',
      timeout: '6s',
      retries: 48,
    },
  };
  if (config.local) {
    services.postgres = {
      image: 'postgres:16.8-alpine',
      labels,
      restart: 'unless-stopped',
      environment: { POSTGRES_DB: 'rivet', POSTGRES_USER: 'rivet', POSTGRES_PASSWORD: config.password },
      command: ['postgres', '-c', 'max_connections=200'],
      volumes: [mount('postgres-data', '/var/lib/postgresql/data')],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U rivet -d rivet'], interval: '3s', timeout: '5s', retries: 40 },
    };
    services.minio = {
      image: minioImage,
      labels,
      restart: 'unless-stopped',
      user: '0:0',
      command: ['server', '/data', '--console-address', ':9001'],
      environment: {
        MINIO_ROOT_USER: s.accessKeyId,
        MINIO_ROOT_PASSWORD: s.secretAccessKey,
        MINIO_REGION_NAME: s.region,
      },
      volumes: [mount('minio-data', '/data')],
    };
    const readiness = `node -e 'const end=Date.now()+120000; (async()=>{while(true){try{const r=await fetch("http://minio:9000/minio/health/ready",{signal:AbortSignal.timeout(3000)});if(r.ok)return}catch{}if(Date.now()>end)throw Error("MinIO readiness timeout");await new Promise(r=>setTimeout(r,1000))}})().catch(e=>{console.error(e.message);process.exitCode=1})'`;
    const bucket =
      'node --input-type=module -e \'import {S3Client,HeadBucketCommand,CreateBucketCommand} from "@aws-sdk/client-s3"; const client=new S3Client({endpoint:process.env.RIVET_DEPLOYMENT_STORAGE_ENDPOINT,region:process.env.RIVET_DEPLOYMENT_STORAGE_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID,secretAccessKey:process.env.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY}}); try{try{await client.send(new HeadBucketCommand({Bucket:process.env.RIVET_DEPLOYMENT_STORAGE_BUCKET}))}catch(e){if(e.$metadata?.httpStatusCode!==404)throw e;await client.send(new CreateBucketCommand({Bucket:process.env.RIVET_DEPLOYMENT_STORAGE_BUCKET}))}}finally{client.destroy()}\'';
    migrationSteps.unshift(readiness, bucket);
  }
  services.migrate.command = [migrationSteps.join('; ')];
  return {
    name: project,
    services,
    volumes,
    networks: {
      default: {
        labels: {
          'rivet.dev/container-installation': project,
          'rivet.dev/storage-identity': containerStorageIdentity(config),
        },
      },
    },
  };
}
