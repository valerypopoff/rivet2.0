import path from 'node:path';

import type {
  ExecutorUrlOverrideSettings,
  ExecutorUrlOverrideSettingsDraft,
} from '../../studio-server-shared/app-settings-types.js';
import {
  hasSetting,
  normalizeBoundedSingleLineString,
  requireSettingsRecord,
  toSettingsRecord,
} from './app-settings/schema.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
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

function normalizeWebsocketUrl(value: unknown, fieldLabel: string, present = true): string {
  const normalized = normalizeBoundedSingleLineString(value, fieldLabel, MAX_WEBSOCKET_URL_LENGTH, {
    strict: present,
  });
  if (!normalized) {
    return '';
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
  const raw = toSettingsRecord(value) as ExecutorUrlOverrideSettingsDraft;

  return {
    executorWsUrl: hasSetting(raw, 'executorWsUrl')
      ? normalizeWebsocketUrl(raw.executorWsUrl, 'Node executor websocket URL override')
      : fallback.executorWsUrl,
    remoteDebuggerDefaultWs: hasSetting(raw, 'remoteDebuggerDefaultWs')
      ? normalizeWebsocketUrl(raw.remoteDebuggerDefaultWs, 'Remote Debugger websocket URL override')
      : fallback.remoteDebuggerDefaultWs,
  };
}

function readExecutorUrlOverrideSettingsFromText(settingsText: string): ExecutorUrlOverrideSettings {
  const parsed = requireSettingsRecord(JSON.parse(settingsText) as unknown, 'Executor URL override settings must be an object');

  const settings = normalizeExecutorUrlOverrideSettingsDraft(parsed);
  return {
    ...settings,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    source: 'app-settings',
  };
}

export const executorUrlOverrideSettingsRepository = new VersionedSettingsRepository<ExecutorUrlOverrideSettings>({
  key: 'executor URL override',
  currentVersion: 1,
  getPath: getExecutorUrlOverrideSettingsPath,
  getDefault: () => ({
    ...DEFAULT_EXECUTOR_URL_OVERRIDE_SETTINGS,
    updatedAt: null,
    source: 'default',
  }),
  parseStored: (stored) => readExecutorUrlOverrideSettingsFromText(JSON.stringify(stored)),
  serialize: (settings) => ({
    executorWsUrl: settings.executorWsUrl,
    remoteDebuggerDefaultWs: settings.remoteDebuggerDefaultWs,
    updatedAt: settings.updatedAt,
  }),
});

export function readExecutorUrlOverrideSettingsSync(): ExecutorUrlOverrideSettings {
  return executorUrlOverrideSettingsRepository.readSync().value;
}

export async function readExecutorUrlOverrideSettings(): Promise<ExecutorUrlOverrideSettings> {
  return (await executorUrlOverrideSettingsRepository.read()).value;
}

export async function writeExecutorUrlOverrideSettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<ExecutorUrlOverrideSettings> {
  return (await executorUrlOverrideSettingsRepository.update((previousSettings) => ({
    ...normalizeExecutorUrlOverrideSettingsDraft(draft, previousSettings),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
