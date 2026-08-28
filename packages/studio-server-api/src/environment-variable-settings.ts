import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  EnvironmentVariableSettings,
  EnvironmentVariableSettingsDraft,
  EnvironmentVariableSettingsDraftEntry,
} from '../../studio-server-shared/app-settings-types.js';
import {
  hasSetting,
  requireBooleanSetting,
  requireSettingsRecord,
  requireStringSetting,
  toSettingsRecord,
} from './app-settings/schema.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { getAppDataRoot, isProtectedBrowserEnvName } from './security.js';
import { badRequest } from './utils/httpError.js';

const ENVIRONMENT_VARIABLE_SETTINGS_RELATIVE_PATH = path.join('settings', 'environment-variables.json');
const MAX_VARIABLES = 250;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 64 * 1024;
const MAX_TOTAL_VALUE_LENGTH = 1024 * 1024;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type StoredEnvironmentVariable = {
  id: string;
  name: string;
  value: string;
  browserAccess: boolean;
};

type StoredEnvironmentVariableSettings = {
  variables: StoredEnvironmentVariable[];
  updatedAt: string | null;
  source: 'app-settings' | 'default';
};

function getEnvironmentVariableSettingsRoot(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot());
}

export function getEnvironmentVariableSettingsPath(): string {
  return path.join(getEnvironmentVariableSettingsRoot(), ENVIRONMENT_VARIABLE_SETTINGS_RELATIVE_PATH);
}

function normalizeName(value: unknown, index: number): string {
  const name = requireStringSetting(value, `Environment variable ${index + 1} name must be a string`).trim();
  if (!name) {
    throw badRequest(`Environment variable ${index + 1} needs a name`);
  }
  if (name.length > MAX_NAME_LENGTH || !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    throw badRequest(`Environment variable ${index + 1} name must use letters, numbers, and underscores only`);
  }
  return name;
}

function normalizeId(value: unknown): string {
  if (value == null) {
    return randomUUID();
  }
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw badRequest('Environment variable IDs are invalid');
  }
  return value;
}

function normalizeValue(value: unknown, index: number): string {
  const normalized = requireStringSetting(value, `Environment variable ${index + 1} value must be a string`);
  if (normalized.includes('\0')) {
    throw badRequest(`Environment variable ${index + 1} value contains an invalid character`);
  }
  if (normalized.length > MAX_VALUE_LENGTH) {
    throw badRequest(`Environment variable ${index + 1} value is too long`);
  }
  return normalized;
}

function normalizeStoredSettings(value: unknown): StoredEnvironmentVariableSettings {
  const raw = requireSettingsRecord(value, 'Environment variable settings must be an object');
  const variables = raw.variables;
  if (!Array.isArray(variables)) {
    throw badRequest('Environment variables must be a list');
  }
  return {
    variables: normalizeStoredVariables(variables),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

function normalizeStoredVariables(values: unknown[]): StoredEnvironmentVariable[] {
  if (values.length > MAX_VARIABLES) {
    throw badRequest(`Environment variables cannot contain more than ${MAX_VARIABLES} entries`);
  }

  const names = new Set<string>();
  const ids = new Set<string>();
  let totalValueLength = 0;
  return values.map((value, index) => {
    const raw = requireSettingsRecord(value, `Environment variable ${index + 1} must be an object`);
    const id = normalizeId(raw.id);
    const name = normalizeName(raw.name, index);
    const nameKey = name.toUpperCase();
    if (ids.has(id) || names.has(nameKey)) {
      throw badRequest('Environment variable names and IDs must be unique');
    }
    ids.add(id);
    names.add(nameKey);
    const entry = {
      id,
      name,
      value: normalizeValue(raw.value, index),
      browserAccess: requireBooleanSetting(raw.browserAccess, `Environment variable ${index + 1} browser access`),
    };
    if (entry.browserAccess && isProtectedBrowserEnvName(name)) {
      throw badRequest(`Environment variable ${index + 1} cannot be exposed to Browser executor`);
    }
    totalValueLength += entry.value.length;
    if (totalValueLength > MAX_TOTAL_VALUE_LENGTH) {
      throw badRequest('Environment variable values are too large in total');
    }
    return entry;
  });
}

function normalizeDraft(
  value: unknown,
  previous: StoredEnvironmentVariableSettings,
): StoredEnvironmentVariableSettings['variables'] {
  const raw = toSettingsRecord(value) as EnvironmentVariableSettingsDraft;
  if (!hasSetting(raw, 'variables') || !Array.isArray(raw.variables)) {
    throw badRequest('Environment variables must be a list');
  }
  if (raw.variables.length > MAX_VARIABLES) {
    throw badRequest(`Environment variables cannot contain more than ${MAX_VARIABLES} entries`);
  }

  const previousById = new Map(previous.variables.map((entry) => [entry.id, entry]));
  const names = new Set<string>();
  const ids = new Set<string>();
  let totalValueLength = 0;
  return raw.variables.map((value, index) => {
    const entry = toSettingsRecord(value) as EnvironmentVariableSettingsDraftEntry;
    const requestedId = typeof entry.id === 'string' ? entry.id : undefined;
    const existing = requestedId ? previousById.get(requestedId) : undefined;
    const id = existing?.id ?? normalizeId(entry.id);
    const name = normalizeName(entry.name, index);
    const nameKey = name.toUpperCase();
    if (ids.has(id) || names.has(nameKey)) {
      throw badRequest('Environment variable names and IDs must be unique');
    }
    ids.add(id);
    names.add(nameKey);

    const valueProvided = hasSetting(entry, 'value');
    if (!existing && !valueProvided) {
      throw badRequest(`Environment variable ${index + 1} needs a value`);
    }
    const normalizedValue = valueProvided ? normalizeValue(entry.value, index) : existing!.value;
    totalValueLength += normalizedValue.length;
    if (totalValueLength > MAX_TOTAL_VALUE_LENGTH) {
      throw badRequest('Environment variable values are too large in total');
    }

    const browserAccess = hasSetting(entry, 'browserAccess')
      ? requireBooleanSetting(entry.browserAccess, `Environment variable ${index + 1} browser access`)
      : existing?.browserAccess ?? false;
    if (browserAccess && isProtectedBrowserEnvName(name)) {
      throw badRequest(`Environment variable ${index + 1} cannot be exposed to Browser executor`);
    }

    return {
      id,
      name,
      value: normalizedValue,
      browserAccess,
    };
  });
}

function getDefaultSettings(): StoredEnvironmentVariableSettings {
  return { variables: [], updatedAt: null, source: 'default' };
}

export const environmentVariableSettingsRepository = new VersionedSettingsRepository<StoredEnvironmentVariableSettings>(
  {
    key: 'environment variable',
    currentVersion: 1,
    getPath: getEnvironmentVariableSettingsPath,
    getDefault: getDefaultSettings,
    parseStored: (stored) => normalizeStoredSettings(stored),
    serialize: (settings) => ({
      variables: settings.variables,
      updatedAt: settings.updatedAt,
    }),
    mode: 0o600,
  },
);

function toPublicSettings(settings: StoredEnvironmentVariableSettings): EnvironmentVariableSettings {
  return {
    variables: settings.variables.map((entry) => ({
      id: entry.id,
      name: entry.name,
      valueConfigured: true,
      browserAccess: entry.browserAccess,
      overridesPhysicalEnvironment: Object.prototype.hasOwnProperty.call(process.env, entry.name),
    })),
    updatedAt: settings.updatedAt,
    source: settings.source,
  };
}

export function readEnvironmentVariableSettingsSync(): EnvironmentVariableSettings {
  return toPublicSettings(environmentVariableSettingsRepository.readSync().value);
}

export async function readEnvironmentVariableSettings(): Promise<EnvironmentVariableSettings> {
  return toPublicSettings((await environmentVariableSettingsRepository.read()).value);
}

export async function readEnvironmentVariableValue(id: string): Promise<string | undefined> {
  await environmentVariableSettingsRepository.refreshIfChanged();
  return environmentVariableSettingsRepository.readSync().value.variables.find((entry) => entry.id === id)?.value;
}

export async function writeEnvironmentVariableSettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<EnvironmentVariableSettings> {
  const saved = await environmentVariableSettingsRepository.update(
    (previous) => ({
      variables: normalizeDraft(draft, previous),
      updatedAt: new Date().toISOString(),
      source: 'app-settings',
    }),
    expectedRevision,
  );
  return toPublicSettings(saved.value);
}

/** Loads a fresh immutable overlay for one execution. */
export async function readExecutionEnvironmentVariables(): Promise<Readonly<Record<string, string>>> {
  await environmentVariableSettingsRepository.refreshIfChanged();
  const settings = environmentVariableSettingsRepository.readSync().value;
  return Object.freeze(Object.fromEntries(settings.variables.map((entry) => [entry.name, entry.value])));
}

export async function resolveBrowserEnvironmentVariable(name: string): Promise<{
  configured: boolean;
  value: string | undefined;
}> {
  // Refresh here so a database notification/poll or an external file-backend
  // writer is visible to a new editor run without waiting for the background poll.
  await environmentVariableSettingsRepository.refreshIfChanged();
  const managedEntry = environmentVariableSettingsRepository
    .readSync()
    .value.variables.find((entry) => entry.name === name);
  return managedEntry
    ? {
        configured: true,
        value: managedEntry.browserAccess ? managedEntry.value : undefined,
      }
    : { configured: false, value: undefined };
}
