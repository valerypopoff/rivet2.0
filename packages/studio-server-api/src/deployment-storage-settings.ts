import path from 'node:path';

import type {
  AppSettingsSource,
  DeploymentDatabaseMode,
  DeploymentDatabaseSslMode,
  DeploymentStorageMode,
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft,
} from '../../studio-server-shared/app-settings-types.js';
import { normalizeBoundedText, normalizeStrictEnumSetting, toSettingsRecord } from './app-settings/schema.js';
import { getAppSettingsBackendKind, VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { writeJsonSettingsFile } from './settings-file-writer.js';
import { getAppDataRoot } from './security.js';
import {
  buildLegacyStorageUrl,
  parseLegacyStorageUrl,
  validateObjectStorageLocation,
  type ObjectStorageLocation,
} from './object-storage-location.js';
import { badRequest } from './utils/httpError.js';

export const DEPLOYMENT_STORAGE_SETTINGS_RELATIVE_PATH = path.join('settings', 'deployment-storage.json');

export type DeploymentStorageRuntimeSettings = Omit<
  DeploymentStorageSettings,
  'databaseConnectionStringConfigured' | 'storageAccessKeyConfigured' | 'deploymentManaged'
> & {
  databaseConnectionString: string;
  storageAccessKey: string;
};

const MAX_PATH_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 8192;
const LOCAL_DOCKER_DATABASE_CONNECTION_STRING = 'postgres://rivet:rivet@workflow-postgres:5432/rivet';

function normalizeSingleLine(value: unknown, fieldLabel: string, maxLength = MAX_SECRET_LENGTH): string {
  return normalizeBoundedText(value, fieldLabel, maxLength, { singleLine: true });
}

function normalizeSecret(value: unknown, previous: string, fieldLabel: string): string {
  const normalized = normalizeSingleLine(value, fieldLabel, MAX_SECRET_LENGTH);
  return normalized || previous;
}

function normalizeStorageMode(value: unknown, fallback: DeploymentStorageMode): DeploymentStorageMode {
  return normalizeStrictEnumSetting(value, ['filesystem', 'managed'] as const, fallback);
}

function normalizeDatabaseMode(value: unknown, fallback: DeploymentDatabaseMode): DeploymentDatabaseMode {
  return normalizeStrictEnumSetting(value, ['local-docker', 'managed'] as const, fallback);
}

function normalizeDatabaseSslMode(value: unknown, fallback: DeploymentDatabaseSslMode): DeploymentDatabaseSslMode {
  return normalizeStrictEnumSetting(value, ['disable', 'require', 'verify-full'] as const, fallback);
}

function defaultDatabaseSslMode(databaseMode: DeploymentDatabaseMode): DeploymentDatabaseSslMode {
  return databaseMode === 'local-docker' ? 'disable' : 'require';
}

function getNextDatabaseSslMode(
  value: unknown,
  databaseMode: DeploymentDatabaseMode,
  fallback: DeploymentStorageRuntimeSettings,
): DeploymentDatabaseSslMode {
  if (typeof value !== 'undefined') {
    return normalizeDatabaseSslMode(value, fallback.databaseSslMode);
  }

  if (databaseMode === fallback.databaseMode) {
    return fallback.databaseSslMode;
  }

  return defaultDatabaseSslMode(databaseMode);
}

function getDefaultSettings(source: AppSettingsSource = 'default'): DeploymentStorageRuntimeSettings {
  return {
    storageMode: 'filesystem',
    artifactsHostPath: '../',
    databaseMode: 'local-docker',
    databaseSslMode: 'disable',
    databaseConnectionString: '',
    storageUrl: '',
    objectStorageBucket: '',
    objectStorageEndpoint: '',
    objectStorageRegion: 'us-east-1',
    objectStoragePrefix: 'workflows/',
    objectStorageForcePathStyle: false,
    storageAccessKeyId: '',
    storageAccessKey: '',
    updatedAt: null,
    source,
  };
}

function deploymentEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

export function readDeploymentStorageBootstrapSettings(): DeploymentStorageRuntimeSettings {
  const explicitDatabaseUrl = deploymentEnv('RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING');
  const host = deploymentEnv('RIVET_DEPLOYMENT_DATABASE_HOST');
  const database = deploymentEnv('RIVET_DEPLOYMENT_DATABASE_NAME');
  const username = deploymentEnv('RIVET_DEPLOYMENT_DATABASE_USERNAME');
  const password = process.env.RIVET_DEPLOYMENT_DATABASE_PASSWORD ?? '';
  if (!explicitDatabaseUrl && (!host || !database || !username || !password)) {
    throw new Error('Managed deployment storage requires a PostgreSQL connection string or complete host, database, username and password settings.');
  }
  const databaseConnectionString = explicitDatabaseUrl ||
    `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${deploymentEnv('RIVET_DEPLOYMENT_DATABASE_PORT') || '5432'}/${encodeURIComponent(database)}`;
  const bucket = deploymentEnv('RIVET_DEPLOYMENT_STORAGE_BUCKET');
  const legacyUrl = deploymentEnv('RIVET_DEPLOYMENT_STORAGE_URL');
  if (bucket && legacyUrl) {
    throw new Error('RIVET_DEPLOYMENT_STORAGE_URL conflicts with the chart-owned bucket and S3 location fields.');
  }
  const pathStyle = deploymentEnv('RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE').toLowerCase();
  if (pathStyle && !['true', 'false'].includes(pathStyle)) {
    throw new Error('RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE must be true or false.');
  }
  const location = bucket ? validateObjectStorageLocation({
    objectStorageBucket: bucket,
    objectStorageEndpoint: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_ENDPOINT').replace(/\/+$/, ''),
    objectStorageRegion: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_REGION'),
    objectStoragePrefix: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_PREFIX') || 'workflows/',
    objectStorageForcePathStyle: pathStyle === 'true',
  }) : undefined;
  if (!location && !legacyUrl) {
    throw new Error('Managed deployment storage requires an object storage bucket or URL.');
  }
  const settings = normalizeSettings({
    storageMode: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_MODE') || 'managed',
    databaseMode: deploymentEnv('RIVET_DEPLOYMENT_DATABASE_MODE') || 'managed',
    databaseSslMode: deploymentEnv('RIVET_DEPLOYMENT_DATABASE_SSL_MODE') || 'require',
    databaseConnectionString,
    storageUrl: location ? buildLegacyStorageUrl(location) : legacyUrl,
    ...location,
    storageAccessKeyId: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID'),
    storageAccessKey: deploymentEnv('RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY'),
  });
  assertKubernetesStorageModes(settings);
  return settings;
}

export function getDeploymentStorageBootstrapDrift(active: DeploymentStorageRuntimeSettings): string[] {
  const bootstrap = readDeploymentStorageBootstrapSettings();
  const checks = [
    ['databaseConnectionString', 'PostgreSQL connection or credentials'],
    ['databaseSslMode', 'PostgreSQL SSL mode'],
    ['objectStorageBucket', 'object storage bucket'],
    ['objectStorageEndpoint', 'object storage endpoint'],
    ['objectStorageRegion', 'object storage region'],
    ['objectStoragePrefix', 'object storage prefix'],
    ['objectStorageForcePathStyle', 'object storage path style'],
    ['storageAccessKeyId', 'object storage credentials'],
    ['storageAccessKey', 'object storage credentials'],
  ] as const;
  return [...new Set(checks.filter(([field]) => bootstrap[field] !== active[field]).map(([, label]) => label))];
}

function validateUrl(value: string, fieldLabel: string): void {
  if (!value) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${fieldLabel} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`${fieldLabel} must use http or https`);
  }
}

function validateDatabaseConnectionString(value: string): void {
  if (!value) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('Managed PostgreSQL connection string must be a valid URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw badRequest('Managed PostgreSQL connection string must use postgres or postgresql');
  }
}

function validateActiveSettings(settings: DeploymentStorageRuntimeSettings): void {
  if (settings.storageMode !== 'managed') {
    return;
  }

  if (!settings.databaseConnectionString) {
    throw badRequest('Managed workflow storage requires a PostgreSQL connection string');
  }

  if (!settings.storageUrl) {
    throw badRequest('Managed workflow storage requires an object storage URL');
  }

  if (!settings.storageAccessKeyId) {
    throw badRequest('Managed workflow storage requires an object storage access key ID');
  }

  if (!settings.storageAccessKey) {
    throw badRequest('Managed workflow storage requires an object storage secret access key');
  }

  validateDatabaseConnectionString(settings.databaseConnectionString);
  validateUrl(settings.storageUrl, 'Object storage URL');
}

function normalizeSettings(
  value: unknown,
  fallback = getDefaultSettings(),
  source: AppSettingsSource = 'app-settings',
): DeploymentStorageRuntimeSettings {
  const raw = toSettingsRecord(value) as DeploymentStorageSettingsDraft & { updatedAt?: unknown };
  const storageMode = normalizeStorageMode(raw.storageMode, fallback.storageMode);
  const databaseMode = normalizeDatabaseMode(raw.databaseMode, fallback.databaseMode);
  const previousManagedDatabaseConnectionString =
    fallback.databaseMode === 'managed' ? fallback.databaseConnectionString : '';
  const localDockerDatabaseConnectionString =
    databaseMode === 'local-docker' ? LOCAL_DOCKER_DATABASE_CONNECTION_STRING : previousManagedDatabaseConnectionString;
  const previousManagedStorageAccessKey = fallback.storageAccessKey;
  const suppliedLocation = [
    raw.objectStorageBucket,
    raw.objectStorageEndpoint,
    raw.objectStorageRegion,
    raw.objectStoragePrefix,
    raw.objectStorageForcePathStyle,
  ].some((field) => field !== undefined);
  if (
    suppliedLocation &&
    [
      raw.objectStorageBucket,
      raw.objectStorageEndpoint,
      raw.objectStorageRegion,
      raw.objectStoragePrefix,
      raw.objectStorageForcePathStyle,
    ].some((field) => field === undefined)
  ) {
    throw badRequest('Object storage bucket, endpoint, region, prefix, and path-style must be supplied together');
  }
  const storageUrl = normalizeSingleLine(raw.storageUrl, 'Object storage URL', MAX_URL_LENGTH) || fallback.storageUrl;
  let location: ObjectStorageLocation;
  if (suppliedLocation && (storageMode === 'managed' || raw.objectStorageBucket)) {
    if (typeof raw.objectStorageForcePathStyle !== 'boolean') {
      throw badRequest('Object storage path-style must be true or false');
    }
    location = validateObjectStorageLocation({
      objectStorageBucket: normalizeSingleLine(raw.objectStorageBucket, 'Object storage bucket'),
      objectStorageEndpoint: normalizeSingleLine(raw.objectStorageEndpoint, 'Object storage endpoint', MAX_URL_LENGTH),
      objectStorageRegion: normalizeSingleLine(raw.objectStorageRegion, 'Object storage region'),
      objectStoragePrefix: normalizeSingleLine(raw.objectStoragePrefix, 'Object storage prefix'),
      objectStorageForcePathStyle: raw.objectStorageForcePathStyle,
    });
  } else if (storageUrl && (raw.storageUrl !== undefined || !fallback.objectStorageBucket)) {
    location = validateObjectStorageLocation(parseLegacyStorageUrl(storageUrl));
  } else {
    location = {
      objectStorageBucket: fallback.objectStorageBucket,
      objectStorageEndpoint: fallback.objectStorageEndpoint,
      objectStorageRegion: fallback.objectStorageRegion,
      objectStoragePrefix: fallback.objectStoragePrefix,
      objectStorageForcePathStyle: fallback.objectStorageForcePathStyle,
    };
  }

  const settings: DeploymentStorageRuntimeSettings = {
    storageMode,
    artifactsHostPath:
      normalizeSingleLine(raw.artifactsHostPath, 'Filesystem artifacts host path', MAX_PATH_LENGTH) ||
      fallback.artifactsHostPath ||
      '../',
    databaseMode,
    databaseSslMode: getNextDatabaseSslMode(raw.databaseSslMode, databaseMode, fallback),
    databaseConnectionString: normalizeSecret(
      raw.databaseConnectionString,
      localDockerDatabaseConnectionString,
      'Managed PostgreSQL connection string',
    ),
    storageUrl: suppliedLocation && location.objectStorageBucket ? buildLegacyStorageUrl(location) : storageUrl,
    ...location,
    storageAccessKeyId:
      normalizeSingleLine(raw.storageAccessKeyId, 'Object storage access key ID') || fallback.storageAccessKeyId,
    storageAccessKey: normalizeSecret(
      raw.storageAccessKey,
      previousManagedStorageAccessKey,
      'Object storage secret access key',
    ),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source,
  };

  validateActiveSettings(settings);
  return settings;
}

function toPublicSettings(settings: DeploymentStorageRuntimeSettings): DeploymentStorageSettings {
  return {
    storageMode: settings.storageMode,
    artifactsHostPath: settings.artifactsHostPath,
    databaseMode: settings.databaseMode,
    databaseSslMode: settings.databaseSslMode,
    databaseConnectionStringConfigured: Boolean(settings.databaseConnectionString),
    storageUrl: settings.storageUrl,
    objectStorageBucket: settings.objectStorageBucket,
    objectStorageEndpoint: settings.objectStorageEndpoint,
    objectStorageRegion: settings.objectStorageRegion,
    objectStoragePrefix: settings.objectStoragePrefix,
    objectStorageForcePathStyle: settings.objectStorageForcePathStyle,
    deploymentManaged: process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated',
    storageAccessKeyId: settings.storageAccessKeyId,
    storageAccessKeyConfigured: Boolean(settings.storageAccessKey),
    updatedAt: settings.updatedAt,
    source: settings.source,
  };
}

export function getDeploymentStorageSettingsPath(): string {
  return path.join(
    path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot()),
    DEPLOYMENT_STORAGE_SETTINGS_RELATIVE_PATH,
  );
}

export const deploymentStorageSettingsRepository = new VersionedSettingsRepository<DeploymentStorageRuntimeSettings>({
  key: 'deployment storage',
  currentVersion: 1,
  getPath: getDeploymentStorageSettingsPath,
  getDefault: getDefaultSettings,
  getManagedBootstrap: () => {
    if (process.env.RIVET_DEPLOYMENT_TOPOLOGY !== 'replicated') return undefined;
    if (process.env.RIVET_DEPLOYMENT_STORAGE_SEED_MISSING !== '1') {
      throw new Error('The authoritative deployment-storage settings row is missing. Run the Kubernetes migration Job before serving.');
    }
    return readDeploymentStorageBootstrapSettings();
  },
  parseStored: (stored) => normalizeSettings(stored, getDefaultSettings(), 'app-settings'),
  serialize: (settings) => ({
    storageMode: settings.storageMode,
    artifactsHostPath: settings.artifactsHostPath,
    databaseMode: settings.databaseMode,
    databaseSslMode: settings.databaseSslMode,
    databaseConnectionString: settings.databaseConnectionString,
    storageUrl: settings.storageUrl,
    objectStorageBucket: settings.objectStorageBucket,
    objectStorageEndpoint: settings.objectStorageEndpoint,
    objectStorageRegion: settings.objectStorageRegion,
    objectStoragePrefix: settings.objectStoragePrefix,
    objectStorageForcePathStyle: settings.objectStorageForcePathStyle,
    storageAccessKeyId: settings.storageAccessKeyId,
    storageAccessKey: settings.storageAccessKey,
    updatedAt: settings.updatedAt,
  }),
});

export async function projectDeploymentStorageSettings(): Promise<void> {
  if (getAppSettingsBackendKind() !== 'postgres' || process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') {
    return;
  }
  const settings = deploymentStorageSettingsRepository.readSync().value;
  await writeJsonSettingsFile(
    getDeploymentStorageSettingsPath(),
    {
      version: 1,
      ...deploymentStorageSettingsRepository.descriptor.serialize(settings),
    },
    0o600,
  );
}

export function readDeploymentStorageRuntimeSettingsSync(): DeploymentStorageRuntimeSettings {
  return deploymentStorageSettingsRepository.readSync().value;
}

export function assertKubernetesStorageModes(
  settings: Pick<DeploymentStorageRuntimeSettings, 'storageMode' | 'databaseMode'>,
): void {
  if (settings.storageMode !== 'managed' || settings.databaseMode !== 'managed') {
    throw new Error(
      'Kubernetes requires managed workflow storage and managed PostgreSQL, but the authoritative settings row selects another mode. Refusing to start a pod with ephemeral local storage.',
    );
  }
}

export async function readDeploymentStorageSettings(): Promise<DeploymentStorageSettings> {
  return toPublicSettings((await deploymentStorageSettingsRepository.read()).value);
}

export async function writeDeploymentStorageSettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<DeploymentStorageSettings> {
  if (process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') {
    throw badRequest(
      'Kubernetes deployment storage is managed by the deployment. Change it through a coordinated operator migration and rollout, not App Settings.',
    );
  }
  const saved = await deploymentStorageSettingsRepository.update((previous) => {
    const next = normalizeSettings(draft, previous, 'app-settings');
    if (
      previous.objectStorageBucket &&
      (previous.objectStorageBucket !== next.objectStorageBucket ||
        previous.objectStorageEndpoint !== next.objectStorageEndpoint ||
        previous.objectStorageRegion !== next.objectStorageRegion ||
        previous.objectStoragePrefix !== next.objectStoragePrefix ||
        previous.objectStorageForcePathStyle !== next.objectStorageForcePathStyle)
    ) {
      throw badRequest(
        'Changing the object-storage location or addressing of active managed storage requires a coordinated operator migration and restart; no objects were moved.',
      );
    }
    return { ...next, updatedAt: new Date().toISOString(), source: 'app-settings' };
  }, expectedRevision);
  return toPublicSettings(saved.value);
}

deploymentStorageSettingsRepository.subscribe(() => {
  void projectDeploymentStorageSettings().catch((error) => {
    console.error('[deployment-storage] Failed to refresh the pod-local settings projection:', error);
  });
});
