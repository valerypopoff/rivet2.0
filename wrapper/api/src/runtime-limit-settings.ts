import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft,
} from '../../shared/app-settings-types.js';
import { writePrivateJsonSettingsFile } from './settings-file-writer.js';
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

function normalizePositiveInteger(
  value: unknown,
  fieldLabel: string,
  maxValue: number,
): number {
  if (value === '') {
    throw badRequest(`${fieldLabel} is required`);
  }

  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`${fieldLabel} must be a positive whole number`);
  }

  if (parsed > maxValue) {
    throw badRequest(`${fieldLabel} is too large`);
  }

  return parsed;
}

function normalizeRuntimeLimitSettingsDraft(
  value: unknown,
  fallback = DEFAULT_RUNTIME_LIMIT_SETTINGS,
): Omit<RuntimeLimitSettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object'
    ? value as RuntimeLimitSettingsDraft
    : {};
  const valueOrFallback = (
    key: keyof RuntimeLimitSettingsDraft,
    fallbackValue: number,
  ): unknown => (
    Object.prototype.hasOwnProperty.call(raw, key)
      ? raw[key]
      : fallbackValue
  );

  return {
    commandTimeoutSeconds: normalizePositiveInteger(
      valueOrFallback('commandTimeoutSeconds', fallback.commandTimeoutSeconds),
      'Command timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
    maxOutputBytes: normalizePositiveInteger(
      valueOrFallback('maxOutputBytes', fallback.maxOutputBytes),
      'Maximum captured output',
      MAX_OUTPUT_BYTES,
    ),
    proxyReadTimeoutSeconds: normalizePositiveInteger(
      valueOrFallback('proxyReadTimeoutSeconds', fallback.proxyReadTimeoutSeconds),
      'Proxy read timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
    webAppActionRequestLimitBytes: normalizeWebAppActionRequestLimitBytes(
      valueOrFallback('webAppActionRequestLimitBytes', fallback.webAppActionRequestLimitBytes),
    ),
    dockerWaitTimeoutSeconds: normalizePositiveInteger(
      valueOrFallback('dockerWaitTimeoutSeconds', fallback.dockerWaitTimeoutSeconds),
      'Docker startup wait timeout',
      MAX_RUNTIME_LIMIT_SECONDS,
    ),
  };
}

function normalizeWebAppActionRequestLimitBytes(value: unknown): number {
  const parsed = normalizePositiveInteger(
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
  const parsed = JSON.parse(settingsText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Runtime limit settings must be an object');
  }

  const settings = normalizeRuntimeLimitSettingsDraft(parsed);
  const raw = parsed as { updatedAt?: unknown };

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

export function readRuntimeLimitSettingsSync(): RuntimeLimitSettings {
  const settingsPath = getRuntimeLimitSettingsPath();

  try {
    return readRuntimeLimitSettingsFromText(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_RUNTIME_LIMIT_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function readRuntimeLimitSettings(): Promise<RuntimeLimitSettings> {
  const settingsPath = getRuntimeLimitSettingsPath();

  try {
    return readRuntimeLimitSettingsFromText(await fsp.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_RUNTIME_LIMIT_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeRuntimeLimitSettings(draft: unknown): Promise<RuntimeLimitSettings> {
  const previousSettings = await readRuntimeLimitSettings();
  const settings = normalizeRuntimeLimitSettingsDraft(draft, previousSettings);
  const saved: RuntimeLimitSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  await writePrivateJsonSettingsFile(getRuntimeLimitSettingsPath(), {
    version: 1,
    commandTimeoutSeconds: saved.commandTimeoutSeconds,
    maxOutputBytes: saved.maxOutputBytes,
    proxyReadTimeoutSeconds: saved.proxyReadTimeoutSeconds,
    webAppActionRequestLimitBytes: saved.webAppActionRequestLimitBytes,
    dockerWaitTimeoutSeconds: saved.dockerWaitTimeoutSeconds,
    updatedAt: saved.updatedAt,
  });

  return saved;
}
