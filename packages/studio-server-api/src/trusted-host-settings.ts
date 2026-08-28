import net from 'node:net';
import path from 'node:path';

import type {
  TrustedHostSettings,
  TrustedHostSettingsDraft,
} from '../../studio-server-shared/app-settings-types.js';
import { hasSetting, requireSettingsRecord, requireStringSetting, toSettingsRecord } from './app-settings/schema.js';
import { getAppDataRoot } from './security.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { badRequest } from './utils/httpError.js';

const TRUSTED_HOST_SETTINGS_RELATIVE_PATH = path.join('settings', 'trusted-hosts.json');
const MAX_TRUSTED_HOSTS = 100;
const MAX_HOST_LENGTH = 253;

export const DEFAULT_TRUSTED_HOST_SETTINGS: Omit<TrustedHostSettings, 'source' | 'updatedAt'> = {
  trustedHosts: [],
};

function getTrustedHostSettingsRoot(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot());
}

export function getTrustedHostSettingsPath(): string {
  return path.join(getTrustedHostSettingsRoot(), TRUSTED_HOST_SETTINGS_RELATIVE_PATH);
}

function isHostname(value: string): boolean {
  if (value.length > MAX_HOST_LENGTH || value.startsWith('.') || value.endsWith('.')) {
    return false;
  }

  return value
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function normalizeTrustedHost(value: unknown, index: number): string {
  const host = requireStringSetting(value, `Trusted host ${index + 1} must be a string`).trim().toLowerCase();
  if (!host) {
    return '';
  }

  if (host.includes('://') || host.includes('/') || host.includes('@') || host.includes('*')) {
    throw badRequest('Trusted hosts must be exact hostnames or IP addresses without protocol, path, or wildcard');
  }

  if (host.startsWith('[') || host.endsWith(']')) {
    throw badRequest('Trusted IPv6 hosts must not include square brackets');
  }

  if (host.includes(':') && net.isIP(host) !== 6) {
    throw badRequest('Trusted hosts must not include ports');
  }

  if (net.isIP(host) === 0 && !isHostname(host)) {
    throw badRequest('Trusted hosts must be valid hostnames or IP addresses');
  }

  return host;
}

function normalizeTrustedHostSettingsDraft(
  value: unknown,
  fallback = DEFAULT_TRUSTED_HOST_SETTINGS,
): Omit<TrustedHostSettings, 'source' | 'updatedAt'> {
  const raw = toSettingsRecord(value) as TrustedHostSettingsDraft;
  const rawHosts = hasSetting(raw, 'trustedHosts')
    ? raw.trustedHosts
    : fallback.trustedHosts;

  if (!Array.isArray(rawHosts)) {
    throw badRequest('Trusted hosts must be a list');
  }

  if (rawHosts.length > MAX_TRUSTED_HOSTS) {
    throw badRequest(`Trusted hosts cannot contain more than ${MAX_TRUSTED_HOSTS} entries`);
  }

  const seen = new Set<string>();
  const trustedHosts: string[] = [];
  rawHosts.forEach((rawHost, index) => {
    const host = normalizeTrustedHost(rawHost, index);
    if (!host || seen.has(host)) {
      return;
    }

    seen.add(host);
    trustedHosts.push(host);
  });

  return { trustedHosts };
}

function readTrustedHostSettingsFromText(settingsText: string): TrustedHostSettings {
  const parsed = requireSettingsRecord(JSON.parse(settingsText) as unknown, 'Trusted host settings must be an object');

  const settings = normalizeTrustedHostSettingsDraft(parsed);
  return {
    ...settings,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    source: 'app-settings',
  };
}

export const trustedHostSettingsRepository = new VersionedSettingsRepository<TrustedHostSettings>({
  key: 'trusted host',
  currentVersion: 1,
  getPath: getTrustedHostSettingsPath,
  getDefault: () => ({
    ...DEFAULT_TRUSTED_HOST_SETTINGS,
    updatedAt: null,
    source: 'default',
  }),
  parseStored: (stored) => readTrustedHostSettingsFromText(JSON.stringify(stored)),
  serialize: (settings) => ({
    trustedHosts: settings.trustedHosts,
    trustedHostsCsv: settings.trustedHosts.join(','),
    updatedAt: settings.updatedAt,
  }),
  mode: 0o644,
});

export function readTrustedHostSettingsSync(): TrustedHostSettings {
  return trustedHostSettingsRepository.readSync().value;
}

export async function readTrustedHostSettings(): Promise<TrustedHostSettings> {
  return (await trustedHostSettingsRepository.read()).value;
}

export async function writeTrustedHostSettings(draft: unknown, expectedRevision?: string): Promise<TrustedHostSettings> {
  return (await trustedHostSettingsRepository.update((previousSettings) => ({
    ...normalizeTrustedHostSettingsDraft(draft, previousSettings),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  }), expectedRevision)).value;
}
