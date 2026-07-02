import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type {
  TrustedHostSettings,
  TrustedHostSettingsDraft,
} from '../../shared/app-settings-types.js';
import { getAppDataRoot } from './security.js';
import { writeJsonSettingsFile } from './settings-file-writer.js';
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
  if (typeof value !== 'string') {
    throw badRequest(`Trusted host ${index + 1} must be a string`);
  }

  const host = value.trim().toLowerCase();
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
  const raw = value && typeof value === 'object'
    ? value as TrustedHostSettingsDraft
    : {};
  const rawHosts = Object.prototype.hasOwnProperty.call(raw, 'trustedHosts')
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
  const parsed = JSON.parse(settingsText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Trusted host settings must be an object');
  }

  const settings = normalizeTrustedHostSettingsDraft(parsed);
  const raw = parsed as { updatedAt?: unknown };

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

export function readTrustedHostSettingsSync(): TrustedHostSettings {
  try {
    return readTrustedHostSettingsFromText(fs.readFileSync(getTrustedHostSettingsPath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_TRUSTED_HOST_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function readTrustedHostSettings(): Promise<TrustedHostSettings> {
  try {
    return readTrustedHostSettingsFromText(await fsp.readFile(getTrustedHostSettingsPath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_TRUSTED_HOST_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeTrustedHostSettings(draft: unknown): Promise<TrustedHostSettings> {
  const previousSettings = await readTrustedHostSettings();
  const settings = normalizeTrustedHostSettingsDraft(draft, previousSettings);
  const saved: TrustedHostSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  await writeJsonSettingsFile(
    getTrustedHostSettingsPath(),
    {
      version: 1,
      trustedHosts: saved.trustedHosts,
      trustedHostsCsv: saved.trustedHosts.join(','),
      updatedAt: saved.updatedAt,
    },
    0o644,
  );

  return saved;
}
