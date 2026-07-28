import path from 'node:path';

import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
} from '../../shared/app-settings-types.js';
import { hasSetting, normalizeBoundedSingleLineString, toSettingsRecord } from './app-settings/schema.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { getAppDataRoot } from './security.js';
import { badRequest } from './utils/httpError.js';

const NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH = path.join('settings', 'node-executor-proxy.json');
const MAX_PROXY_URL_LENGTH = 2048;
const MAX_NO_PROXY_LENGTH = 4096;

function normalizeProxyUrl(value: unknown, fieldLabel: string, present = true): string {
  const normalized = normalizeBoundedSingleLineString(value, fieldLabel, MAX_PROXY_URL_LENGTH, { strict: present });
  if (!normalized) {
    return '';
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw badRequest(`${fieldLabel} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`${fieldLabel} must use http or https`);
  }
  return normalized;
}

function normalizeNoProxy(value: unknown, present = true): string {
  const normalized = normalizeBoundedSingleLineString(value, 'NO_PROXY', MAX_NO_PROXY_LENGTH, { strict: present });
  if (!normalized) {
    return '';
  }
  return normalized;
}

function normalizeNodeExecutorProxySettingsDraft(
  value: unknown,
): Omit<NodeExecutorProxySettings, 'source' | 'updatedAt'> {
  const raw = toSettingsRecord(value) as NodeExecutorProxySettingsDraft;
  return {
    httpProxy: normalizeProxyUrl(raw.httpProxy, 'HTTP_PROXY', hasSetting(raw, 'httpProxy')),
    httpsProxy: normalizeProxyUrl(raw.httpsProxy, 'HTTPS_PROXY', hasSetting(raw, 'httpsProxy')),
    noProxy: normalizeNoProxy(raw.noProxy, hasSetting(raw, 'noProxy')),
  };
}

export function getNodeExecutorProxySettingsPath(): string {
  return path.join(
    path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot()),
    NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH,
  );
}

export const nodeExecutorProxySettingsRepository = new VersionedSettingsRepository<NodeExecutorProxySettings>({
  key: 'node executor proxy',
  currentVersion: 1,
  getPath: getNodeExecutorProxySettingsPath,
  getDefault: () => ({ httpProxy: '', httpsProxy: '', noProxy: '', updatedAt: null, source: 'default' }),
  parseStored: (stored) => ({
    ...normalizeNodeExecutorProxySettingsDraft(stored),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    source: 'app-settings',
  }),
  serialize: (settings) => ({
    httpProxy: settings.httpProxy,
    httpsProxy: settings.httpsProxy,
    noProxy: settings.noProxy,
    updatedAt: settings.updatedAt,
  }),
});

export async function readNodeExecutorProxySettings(): Promise<NodeExecutorProxySettings> {
  return (await nodeExecutorProxySettingsRepository.read()).value;
}

export async function writeNodeExecutorProxySettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<NodeExecutorProxySettings> {
  return (await nodeExecutorProxySettingsRepository.update((previous) => ({
    ...normalizeNodeExecutorProxySettingsDraft({
      ...previous,
      ...toSettingsRecord(draft),
    }),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
