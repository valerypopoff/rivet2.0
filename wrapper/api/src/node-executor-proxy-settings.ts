import path from 'node:path';

import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
} from '../../shared/app-settings-types.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { getAppDataRoot } from './security.js';
import { badRequest } from './utils/httpError.js';

const NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH = path.join('settings', 'node-executor-proxy.json');
const MAX_PROXY_URL_LENGTH = 2048;
const MAX_NO_PROXY_LENGTH = 4096;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPresent(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControlCharacters(value: string, fieldLabel: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }
}

function normalizeProxyUrl(value: unknown, fieldLabel: string, present = true): string {
  if (present && typeof value !== 'undefined' && typeof value !== 'string') {
    throw badRequest(`${fieldLabel} must be a string`);
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length > MAX_PROXY_URL_LENGTH) {
    throw badRequest(`${fieldLabel} is too long`);
  }
  rejectControlCharacters(normalized, fieldLabel);

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
  if (present && typeof value !== 'undefined' && typeof value !== 'string') {
    throw badRequest('NO_PROXY must be a string');
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length > MAX_NO_PROXY_LENGTH) {
    throw badRequest('NO_PROXY is too long');
  }
  rejectControlCharacters(normalized, 'NO_PROXY');
  return normalized;
}

function normalizeNodeExecutorProxySettingsDraft(
  value: unknown,
): Omit<NodeExecutorProxySettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object' ? value as NodeExecutorProxySettingsDraft : {};
  return {
    httpProxy: normalizeProxyUrl(raw.httpProxy, 'HTTP_PROXY', isPresent(raw, 'httpProxy')),
    httpsProxy: normalizeProxyUrl(raw.httpsProxy, 'HTTPS_PROXY', isPresent(raw, 'httpsProxy')),
    noProxy: normalizeNoProxy(raw.noProxy, isPresent(raw, 'noProxy')),
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
      ...(draft && typeof draft === 'object' ? draft : {}),
    }),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
