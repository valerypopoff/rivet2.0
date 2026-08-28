import path from 'node:path';

import type {
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft,
} from '../../studio-server-shared/app-settings-types.js';
import {
  hasSetting,
  normalizePositiveIntegerSetting,
  requireSettingsRecord,
  toSettingsRecord,
} from './app-settings/schema.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { badRequest } from './utils/httpError.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const RUNTIME_LIMIT_SETTINGS_RELATIVE_PATH = path.join('settings', 'runtime-limits.json');
const MAX_RUNTIME_LIMIT_SECONDS = 86_400;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MIN_WEB_APP_ACTION_REQUEST_LIMIT_BYTES = 1024 * 1024;
const MAX_WEB_APP_ACTION_REQUEST_LIMIT_BYTES = 1024 * 1024 * 1024;

export const DEFAULT_RUNTIME_LIMIT_SETTINGS = {
  commandTimeoutSeconds: 30,
  maxOutputBytes: 10 * 1024 * 1024,
  proxyReadTimeoutSeconds: 180,
  webAppActionRequestLimitBytes: 100 * 1024 * 1024,
  dockerWaitTimeoutSeconds: 1200,
} satisfies Omit<RuntimeLimitSettings, 'source' | 'updatedAt'>;

function getAppDataRootForRuntimeLimits(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || path.join(repoRoot, '.data', 'rivet-app'));
}

export function getRuntimeLimitSettingsPath(): string {
  return path.join(getAppDataRootForRuntimeLimits(), RUNTIME_LIMIT_SETTINGS_RELATIVE_PATH);
}

function normalizeRuntimeLimitSettingsDraft(
  value: unknown,
  fallback = DEFAULT_RUNTIME_LIMIT_SETTINGS,
): Omit<RuntimeLimitSettings, 'source' | 'updatedAt'> {
  const raw = toSettingsRecord(value) as RuntimeLimitSettingsDraft;
  const valueOrFallback = (
    key: keyof RuntimeLimitSettingsDraft,
    fallbackValue: number,
  ): unknown => (
    hasSetting(raw, key)
      ? raw[key]
      : fallbackValue
  );

  return {
    commandTimeoutSeconds: normalizePositiveIntegerSetting(
      valueOrFallback('commandTimeoutSeconds', fallback.commandTimeoutSeconds),
      'Command timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
    maxOutputBytes: normalizePositiveIntegerSetting(
      valueOrFallback('maxOutputBytes', fallback.maxOutputBytes),
      'Maximum captured output',
      MAX_OUTPUT_BYTES,
    ),
    proxyReadTimeoutSeconds: normalizePositiveIntegerSetting(
      valueOrFallback('proxyReadTimeoutSeconds', fallback.proxyReadTimeoutSeconds),
      'Proxy read timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
    webAppActionRequestLimitBytes: normalizeWebAppActionRequestLimitBytes(
      valueOrFallback('webAppActionRequestLimitBytes', fallback.webAppActionRequestLimitBytes),
    ),
    dockerWaitTimeoutSeconds: normalizePositiveIntegerSetting(
      valueOrFallback('dockerWaitTimeoutSeconds', fallback.dockerWaitTimeoutSeconds),
      'Docker startup wait timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
  };
}

function normalizeWebAppActionRequestLimitBytes(value: unknown): number {
  const parsed = normalizePositiveIntegerSetting(
    value,
    'Web app button data limit',
    MAX_WEB_APP_ACTION_REQUEST_LIMIT_BYTES,
  );

  if (parsed < MIN_WEB_APP_ACTION_REQUEST_LIMIT_BYTES) {
    throw badRequest('Web app button data limit must be at least 1 MiB');
  }

  return parsed;
}

function readRuntimeLimitSettingsFromText(settingsText: string): RuntimeLimitSettings {
  const parsed = requireSettingsRecord(JSON.parse(settingsText) as unknown, 'Runtime limit settings must be an object');

  const settings = normalizeRuntimeLimitSettingsDraft(parsed);
  return {
    ...settings,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    source: 'app-settings',
  };
}

export const runtimeLimitSettingsRepository = new VersionedSettingsRepository<RuntimeLimitSettings>({
  key: 'runtime limit',
  currentVersion: 1,
  getPath: getRuntimeLimitSettingsPath,
  getDefault: () => ({
    ...DEFAULT_RUNTIME_LIMIT_SETTINGS,
    updatedAt: null,
    source: 'default',
  }),
  parseStored: (stored) => readRuntimeLimitSettingsFromText(JSON.stringify(stored)),
  serialize: (settings) => ({
    commandTimeoutSeconds: settings.commandTimeoutSeconds,
    maxOutputBytes: settings.maxOutputBytes,
    proxyReadTimeoutSeconds: settings.proxyReadTimeoutSeconds,
    webAppActionRequestLimitBytes: settings.webAppActionRequestLimitBytes,
    dockerWaitTimeoutSeconds: settings.dockerWaitTimeoutSeconds,
    updatedAt: settings.updatedAt,
  }),
});

export function readRuntimeLimitSettingsSync(): RuntimeLimitSettings {
  return runtimeLimitSettingsRepository.readSync().value;
}

export async function readRuntimeLimitSettings(): Promise<RuntimeLimitSettings> {
  return (await runtimeLimitSettingsRepository.read()).value;
}

export async function writeRuntimeLimitSettings(draft: unknown, expectedRevision?: string): Promise<RuntimeLimitSettings> {
  return (await runtimeLimitSettingsRepository.update((previousSettings) => ({
    ...normalizeRuntimeLimitSettingsDraft(draft, previousSettings),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
