import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseEnv(rawValue, parser, fallback) {
  const normalized = rawValue?.trim();
  if (!normalized) {
    return fallback;
  }

  return parser(normalized, fallback);
}

function normalizeBoolean(value, fallback = false) {
  return parseEnv(value, (normalized) => {
    const lower = normalized.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(lower)) {
      return false;
    }

    return fallback;
  }, fallback);
}

function normalizePositiveInt(value, fallback) {
  return parseEnv(value, (normalized) => {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }, fallback);
}

function stripDatabaseSslQueryOptions(rawConnectionString) {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

function parseManagedStorageUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid storage URL "${rawUrl}"`);
  }

  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);

  if (pathSegments.length > 0) {
    return {
      bucket: pathSegments[0],
      endpoint: url.origin,
      region: hostParts[0] === 's3' && hostParts[1] ? hostParts[1] : null,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    let region = null;
    let endpointHost = hostParts.slice(1).join('.');
    if (url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3) {
      region = hostParts[1] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    } else if (hostParts[1] === 's3') {
      region = hostParts[2] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    }

    return {
      bucket: hostParts[0],
      endpoint: `${url.protocol}//${endpointHost}`,
      region,
      forcePathStyle: false,
    };
  }

  throw new Error(`Storage URL "${rawUrl}" does not include a bucket name`);
}

const RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS';
const RUNTIME_PROCESS_ROLE_ENV_NAME = 'RIVET_RUNTIME_PROCESS_ROLE';
const RUNTIME_REPLICA_TIER_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER';
const RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED';
const DEPLOYMENT_STORAGE_SETTINGS_RELATIVE_PATH = path.join('settings', 'deployment-storage.json');

export const MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX = 'runtime-libraries/';

const RETIRED_RUNTIME_ENV_REPLACEMENTS = {
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME,
};

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function assertNoRetiredEnv(replacements) {
  const activeRetired = Object.entries(replacements)
    .filter(([name]) => Boolean(process.env[name]?.trim()))
    .map(([name, replacement]) => `${name} -> ${replacement}`);

  if (activeRetired.length === 0) {
    return;
  }

  throw new Error(
    `Retired environment variable(s) detected: ${activeRetired.join(', ')}. ` +
    'Update the configuration to the canonical runtime-library tuning env names.',
  );
}

function getAppDataRoot() {
  return path.resolve(
    readEnv('RIVET_APP_DATA_ROOT') ||
    path.join(os.homedir(), '.local', 'share', 'com.valerypopoff.rivet2'),
  );
}

function readDeploymentStorageSettingsFile() {
  const settingsPath = path.join(getAppDataRoot(), DEPLOYMENT_STORAGE_SETTINGS_RELATIVE_PATH);

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      throw new Error('Deployment storage settings must be an object');
    }

    const storageMode = raw.storageMode === 'managed' ? 'managed' : 'filesystem';
    const databaseMode = raw.databaseMode === 'managed' ? 'managed' : 'local-docker';
    const fallbackDatabaseSslMode = databaseMode === 'local-docker' ? 'disable' : 'require';
    const databaseSslMode = ['disable', 'require', 'verify-full'].includes(raw.databaseSslMode)
      ? raw.databaseSslMode
      : fallbackDatabaseSslMode;

    return {
      source: 'app-settings',
      storageMode,
      databaseMode,
      databaseSslMode,
      databaseConnectionString: typeof raw.databaseConnectionString === 'string'
        ? raw.databaseConnectionString.trim()
        : '',
      storageUrl: typeof raw.storageUrl === 'string' ? raw.storageUrl.trim() : '',
      storageAccessKeyId: typeof raw.storageAccessKeyId === 'string' ? raw.storageAccessKeyId.trim() : '',
      storageAccessKey: typeof raw.storageAccessKey === 'string' ? raw.storageAccessKey.trim() : '',
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function getStorageMode() {
  const deploymentSettings = readDeploymentStorageSettingsFile();
  if (deploymentSettings?.source === 'app-settings') {
    assertNoRetiredEnv(RETIRED_RUNTIME_ENV_REPLACEMENTS);
    return deploymentSettings.storageMode;
  }

  assertNoRetiredEnv(RETIRED_RUNTIME_ENV_REPLACEMENTS);
  return 'filesystem';
}

function getManagedStorageConfig() {
  const deploymentSettings = readDeploymentStorageSettingsFile();
  if (deploymentSettings?.source === 'app-settings') {
    assertNoRetiredEnv(RETIRED_RUNTIME_ENV_REPLACEMENTS);

    return {
      source: 'app-settings',
      databaseMode: deploymentSettings.databaseMode,
      databaseUrl: stripDatabaseSslQueryOptions(deploymentSettings.databaseConnectionString),
      databaseSslMode: deploymentSettings.databaseSslMode,
      storageUrl: deploymentSettings.storageUrl,
      objectStorageAccessKeyId: deploymentSettings.storageAccessKeyId,
      objectStorageSecretAccessKey: deploymentSettings.storageAccessKey,
    };
  }

  return {
    source: 'default',
    databaseMode: 'local-docker',
    databaseUrl: '',
    databaseSslMode: 'disable',
    storageUrl: '',
    objectStorageAccessKeyId: '',
    objectStorageSecretAccessKey: '',
  };
}

function inferRuntimeProcessRole() {
  const rawExplicitRole = readEnv(RUNTIME_PROCESS_ROLE_ENV_NAME);
  const explicitRole = rawExplicitRole?.toLowerCase();
  if (explicitRole === 'api' || explicitRole === 'executor') {
    return explicitRole;
  }

  if (rawExplicitRole) {
    throw new Error(
      `Invalid configuration value "${rawExplicitRole}" for ${RUNTIME_PROCESS_ROLE_ENV_NAME}. ` +
      'Expected "api" or "executor".',
    );
  }

  const argv = process.argv.join(' ').toLowerCase();
  if (argv.includes('executor-bundle') || argv.includes('app-executor')) {
    return 'executor';
  }

  return 'api';
}

function inferRuntimeReplicaTier(runtimeProcessRole) {
  const rawExplicitTier = readEnv(RUNTIME_REPLICA_TIER_ENV_NAME);
  const explicitTier = rawExplicitTier?.toLowerCase();
  if (explicitTier === 'endpoint' || explicitTier === 'editor' || explicitTier === 'none') {
    return explicitTier;
  }

  if (rawExplicitTier) {
    throw new Error(
      `Invalid configuration value "${rawExplicitTier}" for ${RUNTIME_REPLICA_TIER_ENV_NAME}. ` +
      'Expected "endpoint", "editor", or "none".',
    );
  }

  return runtimeProcessRole === 'executor' ? 'editor' : 'endpoint';
}

function getDefaultReplicaStatusRetentionMs(databaseMode) {
  return databaseMode === 'local-docker'
    ? 24 * 60 * 60 * 1_000
    : 15 * 60 * 1_000;
}

function getDefaultReplicaStatusCleanupIntervalMs(databaseMode) {
  return databaseMode === 'local-docker'
    ? 15 * 60 * 1_000
    : 5 * 60 * 1_000;
}

function getNormalizedArgv() {
  return process.argv.map((arg) => arg.replace(/\\/g, '/').toLowerCase());
}

function isApiRuntimeEntryArg(arg) {
  return arg === 'src/server.ts' ||
    arg.endsWith('/src/server.ts') ||
    arg === 'dist/api/src/server.js' ||
    arg.endsWith('/dist/api/src/server.js');
}

function isExecutorRuntimeEntryArg(arg) {
  return arg.includes('executor-bundle') || arg.includes('app-executor');
}

export function isManagedRuntimeLibrariesEnabled() {
  return getStorageMode() === 'managed';
}

export function shouldBootstrapManagedRuntimeLibrariesInCurrentProcess() {
  if (!isManagedRuntimeLibrariesEnabled()) {
    return false;
  }

  const argv = getNormalizedArgv();
  const runtimeProcessRole = inferRuntimeProcessRole();

  if (runtimeProcessRole === 'executor') {
    return argv.some(isExecutorRuntimeEntryArg);
  }

  if (argv.includes('watch')) {
    return false;
  }

  return argv.some(isApiRuntimeEntryArg);
}

export function getManagedRuntimeLibrariesConfig() {
  const storageConfig = getManagedStorageConfig();
  const databaseUrl = storageConfig.databaseUrl;
  if (!databaseUrl) {
    throw new Error('Managed runtime-library sync requires a PostgreSQL connection string in Settings -> Storage');
  }

  const parsedStorageUrl = storageConfig.storageUrl ? parseManagedStorageUrl(storageConfig.storageUrl) : null;
  if (!parsedStorageUrl) {
    throw new Error('Managed runtime-library sync requires an object storage URL in deployment storage app settings');
  }

  const objectStorageBucket = parsedStorageUrl?.bucket;
  const objectStorageRegion = parsedStorageUrl?.region || 'us-east-1';
  const objectStorageEndpoint = parsedStorageUrl?.endpoint || undefined;
  const objectStorageForcePathStyle = parsedStorageUrl?.forcePathStyle ?? false;
  const replicaStatusRetentionMs = normalizePositiveInt(
    readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME),
    getDefaultReplicaStatusRetentionMs(storageConfig.databaseMode),
  );
  const runtimeProcessRole = inferRuntimeProcessRole();

  return {
    databaseMode: storageConfig.databaseMode,
    databaseUrl,
    databaseSslMode: storageConfig.databaseSslMode,
    objectStorageBucket,
    objectStorageRegion,
    objectStorageEndpoint,
    objectStorageAccessKeyId: storageConfig.objectStorageAccessKeyId,
    objectStorageSecretAccessKey: storageConfig.objectStorageSecretAccessKey,
    objectStorageForcePathStyle,
    objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
    syncPollIntervalMs: normalizePositiveInt(readEnv(RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME), 5_000),
    runtimeProcessRole,
    runtimeReplicaTier: inferRuntimeReplicaTier(runtimeProcessRole),
    replicaStatusRetentionMs,
    replicaStatusCleanupIntervalMs: normalizePositiveInt(
      readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME),
      getDefaultReplicaStatusCleanupIntervalMs(storageConfig.databaseMode),
    ),
    jobWorkerEnabled: normalizeBoolean(
      readEnv(RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME),
      true,
    ),
  };
}

export function getManagedRuntimeLibrariesPoolConfig(config) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    max: 2,
  };

  if (config.databaseSslMode === 'disable') {
    return sharedConfig;
  }

  return {
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  };
}
