import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  ExecutorUrlOverrideSettings,
  ExecutorUrlOverrideSettingsDraft,
} from '../../shared/app-settings-types.js';
import { writePrivateJsonSettingsFile } from './settings-file-writer.js';
import { badRequest } from './utils/httpError.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const EXECUTOR_URL_OVERRIDE_SETTINGS_RELATIVE_PATH = path.join('settings', 'executor-url-overrides.json');
const MAX_WEBSOCKET_URL_LENGTH = 2048;

export const DEFAULT_EXECUTOR_URL_OVERRIDE_SETTINGS = {
  executorWsUrl: '',
  remoteDebuggerDefaultWs: '',
} satisfies Omit<ExecutorUrlOverrideSettings, 'source' | 'updatedAt'>;

function getAppDataRootForExecutorUrlOverrides(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || path.join(repoRoot, '.data', 'rivet-app'));
}

export function getExecutorUrlOverrideSettingsPath(): string {
  return path.join(getAppDataRootForExecutorUrlOverrides(), EXECUTOR_URL_OVERRIDE_SETTINGS_RELATIVE_PATH);
}

function isPresent(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWebsocketUrl(value: unknown, fieldLabel: string, present = true): string {
  if (present && typeof value !== 'undefined' && typeof value !== 'string') {
    throw badRequest(`${fieldLabel} must be a string`);
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length > MAX_WEBSOCKET_URL_LENGTH) {
    throw badRequest(`${fieldLabel} is too long`);
  }

  if (/[\r\n\0]/.test(normalized)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw badRequest(`${fieldLabel} must be a valid URL`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw badRequest(`${fieldLabel} must use ws or wss`);
  }

  return normalized;
}

function normalizeExecutorUrlOverrideSettingsDraft(
  value: unknown,
  fallback = DEFAULT_EXECUTOR_URL_OVERRIDE_SETTINGS,
): Omit<ExecutorUrlOverrideSettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object'
    ? value as ExecutorUrlOverrideSettingsDraft
    : {};

  return {
    executorWsUrl: isPresent(raw, 'executorWsUrl')
      ? normalizeWebsocketUrl(raw.executorWsUrl, 'Node executor websocket URL override')
      : fallback.executorWsUrl,
    remoteDebuggerDefaultWs: isPresent(raw, 'remoteDebuggerDefaultWs')
      ? normalizeWebsocketUrl(raw.remoteDebuggerDefaultWs, 'Remote Debugger websocket URL override')
      : fallback.remoteDebuggerDefaultWs,
  };
}

function readExecutorUrlOverrideSettingsFromText(settingsText: string): ExecutorUrlOverrideSettings {
  const parsed = JSON.parse(settingsText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Executor URL override settings must be an object');
  }

  const settings = normalizeExecutorUrlOverrideSettingsDraft(parsed);
  const raw = parsed as { updatedAt?: unknown };

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

export function readExecutorUrlOverrideSettingsSync(): ExecutorUrlOverrideSettings {
  const settingsPath = getExecutorUrlOverrideSettingsPath();

  try {
    return readExecutorUrlOverrideSettingsFromText(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_EXECUTOR_URL_OVERRIDE_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function readExecutorUrlOverrideSettings(): Promise<ExecutorUrlOverrideSettings> {
  const settingsPath = getExecutorUrlOverrideSettingsPath();

  try {
    return readExecutorUrlOverrideSettingsFromText(await fsp.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_EXECUTOR_URL_OVERRIDE_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeExecutorUrlOverrideSettings(draft: unknown): Promise<ExecutorUrlOverrideSettings> {
  const previousSettings = await readExecutorUrlOverrideSettings();
  const settings = normalizeExecutorUrlOverrideSettingsDraft(draft, previousSettings);
  const saved: ExecutorUrlOverrideSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  await writePrivateJsonSettingsFile(getExecutorUrlOverrideSettingsPath(), {
    version: 1,
    executorWsUrl: saved.executorWsUrl,
    remoteDebuggerDefaultWs: saved.remoteDebuggerDefaultWs,
    updatedAt: saved.updatedAt,
  });

  return saved;
}
