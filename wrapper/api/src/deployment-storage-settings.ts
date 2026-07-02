import fs from 'node:fs';
import path from 'node:path';

import type {
  AppSettingsSource,
  DeploymentDatabaseMode,
  DeploymentDatabaseSslMode,
  DeploymentStorageMode,
  DeploymentStorageSettings,
  DeploymentStorageSettingsDraft,
} from '../../shared/app-settings-types.js';
import { getAppDataRoot } from './security.js';
import { writePrivateJsonSettingsFile } from './settings-file-writer.js';
import { badRequest } from './utils/httpError.js';
import { parseEnum } from './utils/env-parsing.js';

export const DEPLOYMENT_STORAGE_SETTINGS_RELATIVE_PATH = path.join('settings', 'deployment-storage.json');

export type DeploymentStorageRuntimeSettings = Omit<
  DeploymentStorageSettings,
  'databaseConnectionStringConfigured' | 'storageAccessKeyConfigured'
> & {
  databaseConnectionString: string;
  storageAccessKey: string;
};

const MAX_PATH_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 8192;
const LOCAL_DOCKER_DATABASE_CONNECTION_STRING = 'postgres://rivet:rivet@workflow-postgres:5432/rivet';

function normalizeString(value: unknown, fieldLabel: string, maxLength = MAX_SECRET_LENGTH): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }

  if (normalized.length > maxLength) {
    throw badRequest(`${fieldLabel} is too long`);
  }

  if (/[\0]/.test(normalized)) {
    throw badRequest(`${fieldLabel} contains an invalid character`);
  }

  return normalized;
}

function normalizeSingleLine(value: unknown, fieldLabel: string, maxLength = MAX_SECRET_LENGTH): string {
  const normalized = normalizeString(value, fieldLabel, maxLength);
  if (/[\r\n]/.test(normalized)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }

  return normalized;
}

function normalizeSecret(value: unknown, previous: string, fieldLabel: string): string {
  const normalized = normalizeSingleLine(value, fieldLabel, MAX_SECRET_LENGTH);
  return normalized || previous;
}

function normalizeStorageMode(value: unknown, fallback: DeploymentStorageMode): DeploymentStorageMode {
  return parseEnum(
    typeof value === 'string' ? value.trim() : undefined,
    ['filesystem', 'managed'],
    fallback,
    { strict: true },
  );
}

function normalizeDatabaseMode(value: unknown, fallback: DeploymentDatabaseMode): DeploymentDatabaseMode {
  return parseEnum(
    typeof value === 'string' ? value.trim() : undefined,
    ['local-docker', 'managed'],
    fallback,
    { strict: true },
  );
}

function normalizeDatabaseSslMode(
  value: unknown,
  fallback: DeploymentDatabaseSslMode,
): DeploymentDatabaseSslMode {
  return parseEnum(
    typeof value === 'string' ? value.trim() : undefined,
    ['disable', 'require', 'verify-full'],
    fallback,
    { strict: true },
  );
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
    storageAccessKeyId: '',
    storageAccessKey: '',
    updatedAt: null,
    source,
  };
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
  const raw = value && typeof value === 'object'
    ? value as DeploymentStorageSettingsDraft & { updatedAt?: unknown }
    : {};
  const storageMode = normalizeStorageMode(raw.storageMode, fallback.storageMode);
  const databaseMode = normalizeDatabaseMode(raw.databaseMode, fallback.databaseMode);
  const previousManagedDatabaseConnectionString = fallback.databaseMode === 'managed'
    ? fallback.databaseConnectionString
    : '';
  const localDockerDatabaseConnectionString = databaseMode === 'local-docker'
    ? LOCAL_DOCKER_DATABASE_CONNECTION_STRING
    : previousManagedDatabaseConnectionString;
  const previousManagedStorageAccessKey = fallback.storageAccessKey;

  const settings: DeploymentStorageRuntimeSettings = {
    storageMode,
    artifactsHostPath: normalizeSingleLine(raw.artifactsHostPath, 'Filesystem artifacts host path', MAX_PATH_LENGTH)
      || fallback.artifactsHostPath
      || '../',
    databaseMode,
    databaseSslMode: getNextDatabaseSslMode(raw.databaseSslMode, databaseMode, fallback),
    databaseConnectionString: normalizeSecret(
      raw.databaseConnectionString,
      localDockerDatabaseConnectionString,
      'Managed PostgreSQL connection string',
    ),
    storageUrl: normalizeSingleLine(raw.storageUrl, 'Object storage URL', MAX_URL_LENGTH) || fallback.storageUrl,
    storageAccessKeyId: normalizeSingleLine(raw.storageAccessKeyId, 'Object storage access key ID') || fallback.storageAccessKeyId,
    storageAccessKey: normalizeSecret(raw.storageAccessKey, previousManagedStorageAccessKey, 'Object storage secret access key'),
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

export function readDeploymentStorageRuntimeSettingsSync(): DeploymentStorageRuntimeSettings {
  const settingsPath = getDeploymentStorageSettingsPath();

  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), getDefaultSettings(), 'app-settings');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return getDefaultSettings();
    }

    throw error;
  }
}

export async function readDeploymentStorageSettings(): Promise<DeploymentStorageSettings> {
  return toPublicSettings(readDeploymentStorageRuntimeSettingsSync());
}

export async function writeDeploymentStorageSettings(draft: unknown): Promise<DeploymentStorageSettings> {
  const previous = readDeploymentStorageRuntimeSettingsSync();
  const saved = {
    ...normalizeSettings(draft, previous, 'app-settings'),
    updatedAt: new Date().toISOString(),
    source: 'app-settings' as const,
  };

  await writePrivateJsonSettingsFile(getDeploymentStorageSettingsPath(), {
    version: 1,
    storageMode: saved.storageMode,
    artifactsHostPath: saved.artifactsHostPath,
    databaseMode: saved.databaseMode,
    databaseSslMode: saved.databaseSslMode,
    databaseConnectionString: saved.databaseConnectionString,
    storageUrl: saved.storageUrl,
    storageAccessKeyId: saved.storageAccessKeyId,
    storageAccessKey: saved.storageAccessKey,
    updatedAt: saved.updatedAt,
  });

  return toPublicSettings(saved);
}
