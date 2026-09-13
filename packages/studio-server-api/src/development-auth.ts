import type { IncomingMessage } from 'node:http';
import { getVerifiedClientAddress } from './auth.js';
import { clientMatchesNetworks, normalizeClientNetwork } from './client-networks.js';

// This capability is deployment-owned, never enabled by a browser Settings save.
// Use only in an isolated development deployment; every allowed client can
// impersonate an allowlisted email. An empty/malformed policy denies all.
export function isDevelopmentAuthRequest(request: IncomingMessage): boolean {
  if (process.env.RIVET_ENABLE_DEVELOPMENT_AUTH !== 'true') return false;
  const address = getVerifiedClientAddress(request);
  if (!address) return false;
  try {
    const networks = (process.env.RIVET_DEVELOPMENT_AUTH_CLIENTS ?? '').split(',').filter(Boolean).map(normalizeClientNetwork);
    return clientMatchesNetworks(address, networks);
  } catch {
    return false;
  }
}

export function getDevelopmentAuthPolicyVersion(): string {
  return JSON.stringify(['verified-client-v1', process.env.RIVET_ENABLE_DEVELOPMENT_AUTH ?? '', process.env.RIVET_DEVELOPMENT_AUTH_CLIENTS ?? '']);
}
