import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientMatchesNetworks, normalizeClientAddress } from './client-networks.js';
import { readTrustedClientSettingsSync } from './trusted-client-settings.js';

const PROXY_AUTH_HEADER = 'x-rivet-proxy-auth';
const EXECUTOR_AUTH_HEADER = 'x-rivet-executor-auth';
const UI_SESSION_COOKIE_NAME = 'rivet_ui_token';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getSharedKey(): string {
  return process.env.RIVET_KEY?.trim() ?? '';
}

export function getExpectedProxyAuthToken(): string {
  const sharedKey = getSharedKey();
  return sharedKey ? sha256Hex(`${sharedKey}:proxy-auth`) : '';
}

export function getExpectedExecutorAuthToken(): string {
  const sharedKey = getSharedKey();
  return sharedKey ? sha256Hex(`${sharedKey}:executor-internal`) : '';
}

export function getExpectedUiSessionToken(): string {
  const sharedKey = getSharedKey();
  return sharedKey ? sha256Hex(`${sharedKey}:ui-session`) : '';
}

export function isValidSharedKey(candidate: string | undefined | null): boolean {
  const sharedKey = getSharedKey();
  if (!sharedKey) {
    return false;
  }

  return timingSafeStringEqual((candidate ?? '').trim(), sharedKey);
}

export function isTrustedProxyRequest(request: Request | IncomingMessage): boolean {
  const expectedToken = getExpectedProxyAuthToken();
  if (!expectedToken) {
    return false;
  }

  const headerValue = request.headers[PROXY_AUTH_HEADER];
  const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof providedToken === 'string' && timingSafeStringEqual(providedToken.trim(), expectedToken);
}

/**
 * The executor reads the full UI-managed environment for Node runs. This is
 * separate from proxy auth, which is attached to ordinary browser requests.
 */
export function isTrustedExecutorRequest(request: Request | IncomingMessage): boolean {
  const expectedToken = getExpectedExecutorAuthToken();
  if (!expectedToken) {
    return false;
  }

  const headerValue = request.headers[EXECUTOR_AUTH_HEADER];
  const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof providedToken === 'string' && timingSafeStringEqual(providedToken.trim(), expectedToken);
}

export function getVerifiedClientAddress(request: Request | IncomingMessage): string | null {
  if (!isTrustedProxyRequest(request)) return null;
  const value = request.headers['x-rivet-client-ip'];
  return typeof value === 'string' ? normalizeClientAddress(value) : null;
}

export function isTrustedClientRequest(request: Request | IncomingMessage): boolean {
  const address = getVerifiedClientAddress(request);
  if (!address) return false;
  try {
    return clientMatchesNetworks(address, readTrustedClientSettingsSync().trustedClients);
  } catch {
    // Malformed policy disables bypass; infrastructure failures still fail
    // the repository health/snapshot boundary rather than granting access.
    return false;
  }
}

function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(';')) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const cookieName = cookie.slice(0, separatorIndex).trim();
    if (cookieName !== name) {
      continue;
    }

    return cookie.slice(separatorIndex + 1).trim();
  }

  return null;
}

export function isTrustedUiSessionRequest(request: Request | IncomingMessage): boolean {
  if (!isTrustedProxyRequest(request)) {
    return false;
  }

  const expectedSessionToken = getExpectedUiSessionToken();
  if (!expectedSessionToken) {
    return false;
  }

  const cookieHeader = request.headers.cookie;
  const rawCookieHeader = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  const providedSessionToken = readCookieValue(rawCookieHeader, UI_SESSION_COOKIE_NAME);
  return providedSessionToken != null && timingSafeStringEqual(providedSessionToken, expectedSessionToken);
}
