import path from 'node:path';
import type { TrustedClientSettings } from '../../studio-server-shared/app-settings-types.js';
import { VersionedSettingsRepository } from './app-settings/settings-repository.js';
import { requireSettingsRecord } from './app-settings/schema.js';
import { normalizeClientNetwork } from './client-networks.js';
import { getAppDataRoot } from './security.js';
import { badRequest } from './utils/httpError.js';

export const DEFAULT_TRUSTED_CLIENT_SETTINGS = { trustedClients: [] as string[], legacyTrustedHosts: [] as string[] };

// Preserve the durable domain/path, including encrypted managed rows. Old hosts
// are migration information only, never resolved or converted to client IPs.
export function getTrustedClientSettingsPath(): string {
  return path.join(getAppDataRoot(), 'settings', 'trusted-hosts.json');
}

function normalizeClients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw badRequest('Trusted clients must be a list of at most 100 IP addresses or networks');
  }
  try {
    return [...new Set(value.map((entry) => {
      if (typeof entry !== 'string' || entry.length > 128) throw new Error('Invalid client network');
      return normalizeClientNetwork(entry);
    }))];
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Invalid client network');
  }
}

export const trustedClientSettingsRepository = new VersionedSettingsRepository<TrustedClientSettings>({
  key: 'trusted host',
  currentVersion: 1,
  getPath: getTrustedClientSettingsPath,
  getDefault: () => ({ ...DEFAULT_TRUSTED_CLIENT_SETTINGS, source: 'default', updatedAt: null }),
  recoverParseError: () => ({
    ...DEFAULT_TRUSTED_CLIENT_SETTINGS,
    source: 'app-settings',
    updatedAt: null,
    policyError: 'Trusted-client settings are invalid. Bypass is disabled. Use ordinary administrator login and save a corrected client list.',
  }),
  parseStored(stored) {
    const raw = requireSettingsRecord(stored, 'Trusted client settings must be an object');
    if (raw.policyError) throw new Error('Trusted-client settings require repair');
    const legacy = raw.legacyTrustedHosts ?? raw.trustedHosts ?? [];
    return {
      trustedClients: normalizeClients(raw.trustedClients ?? []),
      legacyTrustedHosts: Array.isArray(legacy) ? legacy.filter((host): host is string => typeof host === 'string') : [],
      source: 'app-settings',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  },
  serialize: ({ trustedClients, legacyTrustedHosts, updatedAt, policyError }) => ({
    trustedClients, legacyTrustedHosts, updatedAt, ...(policyError ? { policyError } : {}),
  }),
  mode: 0o644,
});

export function readTrustedClientSettingsSync(): TrustedClientSettings {
  return trustedClientSettingsRepository.readSync().value;
}
export async function readTrustedClientSettings(): Promise<TrustedClientSettings> {
  return (await trustedClientSettingsRepository.read()).value;
}
export async function writeTrustedClientSettings(draft: unknown, expectedRevision?: string): Promise<TrustedClientSettings> {
  const raw = requireSettingsRecord(draft, 'Trusted client settings must be an object');
  if ('trustedHosts' in raw) {
    throw badRequest('Hostname bypass is retired. Configure trustedClients with client IP addresses or networks.');
  }
  return (await trustedClientSettingsRepository.update((previous) => {
    if (previous.policyError && !('trustedClients' in raw)) {
      throw badRequest('Provide a corrected trustedClients list to repair this policy.');
    }
    return {
      ...previous,
      policyError: undefined,
      trustedClients: 'trustedClients' in raw ? normalizeClients(raw.trustedClients) : previous.trustedClients,
      source: 'app-settings',
      updatedAt: new Date().toISOString(),
    };
  }, expectedRevision)).value;
}
