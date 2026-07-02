import fs from 'node:fs';
import path from 'node:path';

import type {
  AppSettingsSource,
  WebAppAuthMode,
  WebAppAuthSettings,
  WebAppAuthSettingsDraft,
  WebAppOAuthClientAuthMethod,
  WebAppOAuthProvider,
} from '../../shared/app-settings-types.js';
import { getAppDataRoot } from './security.js';
import { writePrivateJsonSettingsFile } from './settings-file-writer.js';
import { badRequest, createHttpError } from './utils/httpError.js';

export const WEB_APP_AUTH_SETTINGS_RELATIVE_PATH = path.join('settings', 'web-app-auth.json');

const MAX_URL_LENGTH = 2048;
const MAX_SHORT_TEXT_LENGTH = 1024;
const MAX_SECRET_LENGTH = 4096;
const MAX_EMAIL_LIST_ITEMS = 500;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 366 * 24 * 60 * 60;

export type WebAppAuthRuntimeSettings = {
  mode: WebAppAuthMode;
  provider: WebAppOAuthProvider;
  dummyEmail: string;
  dummyAllowNonLocalhost: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string;
  emailClaim: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  clientAuthMethod: WebAppOAuthClientAuthMethod;
  debugLogProfile: boolean;
  serverUiAdminEmails: string[];
  updatedAt: string | null;
  source: AppSettingsSource;
};

const DEFAULT_WEB_APP_AUTH_SETTINGS: WebAppAuthRuntimeSettings = {
  mode: 'ui-gate',
  provider: 'external',
  dummyEmail: 'local@example.test',
  dummyAllowNonLocalhost: false,
  authorizeUrl: '',
  tokenUrl: '',
  userUrl: '',
  clientId: '',
  clientSecret: '',
  callbackUrl: '',
  scopes: 'email',
  emailClaim: 'email',
  sessionSecret: '',
  sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
  clientAuthMethod: 'body',
  debugLogProfile: false,
  serverUiAdminEmails: [],
  updatedAt: null,
  source: 'default',
};

const FAIL_CLOSED_WEB_APP_AUTH_SETTINGS: WebAppAuthRuntimeSettings = {
  ...DEFAULT_WEB_APP_AUTH_SETTINGS,
  mode: 'oauth',
};

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rejectControlCharacters(value: string, fieldLabel: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }
}

function normalizeLimitedString(value: unknown, fieldLabel: string, maxLength = MAX_SHORT_TEXT_LENGTH): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length > maxLength) {
    throw badRequest(`${fieldLabel} is too long`);
  }

  rejectControlCharacters(normalized, fieldLabel);
  return normalized;
}

function normalizeEmailList(value: unknown, fieldLabel: string): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    const normalized = normalizeLimitedString(rawValue, fieldLabel).toLowerCase();
    if (!normalized) {
      continue;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw badRequest(`${fieldLabel} must contain valid email addresses`);
    }

    seen.add(normalized);
    if (seen.size > MAX_EMAIL_LIST_ITEMS) {
      throw badRequest(`${fieldLabel} has too many entries`);
    }
  }

  return [...seen].sort();
}

function normalizeSecret(value: unknown, fallback: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }

  if (normalized.length > MAX_SECRET_LENGTH) {
    throw badRequest('OAuth secret is too long');
  }

  rejectControlCharacters(normalized, 'OAuth secret');
  return normalized;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function normalizeWebAppAuthMode(value: unknown, fallback: WebAppAuthMode): WebAppAuthMode {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === 'oauth' || normalized === 'none' || normalized === 'ui-gate'
    ? normalized
    : fallback;
}

function normalizeOAuthProvider(value: unknown, fallback: WebAppOAuthProvider): WebAppOAuthProvider {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === 'dummy' || normalized === 'external' ? normalized : fallback;
}

function normalizeClientAuthMethod(value: unknown, fallback: WebAppOAuthClientAuthMethod): WebAppOAuthClientAuthMethod {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === 'basic' || normalized === 'body' ? normalized : fallback;
}

function normalizeSessionTtlSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, parsed));
}

function isLocalhostUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

export function requireSecureOAuthUrl(fieldLabel: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createHttpError(500, `${fieldLabel} must be a valid URL`);
  }

  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhostUrl(url))) {
    return;
  }

  throw createHttpError(500, `${fieldLabel} must use https unless it targets localhost`);
}

function validateOAuthUrlForSave(fieldLabel: string, value: string): void {
  try {
    requireSecureOAuthUrl(fieldLabel, value);
  } catch (error) {
    if ((error as { status?: unknown }).status === 500) {
      throw badRequest((error as Error).message);
    }

    throw error;
  }
}

function requireSavedValue(value: string, fieldLabel: string, reason = 'OAuth web-app auth is enabled'): void {
  if (!value) {
    throw badRequest(`${fieldLabel} is required when ${reason}`);
  }
}

function validateActiveOAuthSettings(settings: WebAppAuthRuntimeSettings): void {
  const needsOAuthProvider = settings.mode === 'oauth' || settings.serverUiAdminEmails.length > 0;
  if (!needsOAuthProvider) {
    return;
  }
  const reason = settings.mode === 'oauth'
    ? 'OAuth web-app auth is enabled'
    : 'server UI admin emails are configured';

  if (settings.provider === 'dummy') {
    requireSavedValue(settings.sessionSecret, 'Session signing secret', reason);
    return;
  }

  requireSavedValue(settings.authorizeUrl, 'Authorization URL', reason);
  requireSavedValue(settings.tokenUrl, 'Token URL', reason);
  requireSavedValue(settings.userUrl, 'Profile URL', reason);
  requireSavedValue(settings.clientId, 'Client ID', reason);
  requireSavedValue(settings.clientSecret, 'Client secret', reason);
  validateOAuthUrlForSave('Authorization URL', settings.authorizeUrl);
  validateOAuthUrlForSave('Token URL', settings.tokenUrl);
  validateOAuthUrlForSave('Profile URL', settings.userUrl);
  if (settings.callbackUrl) {
    validateOAuthUrlForSave('Callback URL', settings.callbackUrl);
  }
}

function normalizeStoredSettings(value: unknown, source: AppSettingsSource): WebAppAuthRuntimeSettings {
  const raw = value && typeof value === 'object'
    ? value as WebAppAuthSettingsDraft & { updatedAt?: unknown }
    : {};
  const modeFallback = source === 'app-settings'
    ? FAIL_CLOSED_WEB_APP_AUTH_SETTINGS.mode
    : DEFAULT_WEB_APP_AUTH_SETTINGS.mode;

  return {
    mode: normalizeWebAppAuthMode(raw.mode, modeFallback),
    provider: normalizeOAuthProvider(raw.provider, DEFAULT_WEB_APP_AUTH_SETTINGS.provider),
    dummyEmail: normalizeLimitedString(raw.dummyEmail, 'Dummy OAuth email') || DEFAULT_WEB_APP_AUTH_SETTINGS.dummyEmail,
    dummyAllowNonLocalhost: normalizeBoolean(raw.dummyAllowNonLocalhost, DEFAULT_WEB_APP_AUTH_SETTINGS.dummyAllowNonLocalhost),
    authorizeUrl: normalizeLimitedString(raw.authorizeUrl, 'Authorization URL', MAX_URL_LENGTH),
    tokenUrl: normalizeLimitedString(raw.tokenUrl, 'Token URL', MAX_URL_LENGTH),
    userUrl: normalizeLimitedString(raw.userUrl, 'Profile URL', MAX_URL_LENGTH),
    clientId: normalizeLimitedString(raw.clientId, 'Client ID'),
    clientSecret: normalizeLimitedString(raw.clientSecret, 'Client secret', MAX_SECRET_LENGTH),
    callbackUrl: normalizeLimitedString(raw.callbackUrl, 'Callback URL', MAX_URL_LENGTH),
    scopes: normalizeLimitedString(raw.scopes, 'OAuth scopes') || DEFAULT_WEB_APP_AUTH_SETTINGS.scopes,
    emailClaim: normalizeLimitedString(raw.emailClaim, 'Email claim path') || DEFAULT_WEB_APP_AUTH_SETTINGS.emailClaim,
    sessionSecret: normalizeLimitedString(raw.sessionSecret, 'Session signing secret', MAX_SECRET_LENGTH),
    sessionTtlSeconds: normalizeSessionTtlSeconds(raw.sessionTtlSeconds, DEFAULT_WEB_APP_AUTH_SETTINGS.sessionTtlSeconds),
    clientAuthMethod: normalizeClientAuthMethod(raw.clientAuthMethod, DEFAULT_WEB_APP_AUTH_SETTINGS.clientAuthMethod),
    debugLogProfile: normalizeBoolean(raw.debugLogProfile, DEFAULT_WEB_APP_AUTH_SETTINGS.debugLogProfile),
    serverUiAdminEmails: normalizeEmailList(raw.serverUiAdminEmails, 'Server UI admin emails'),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source,
  };
}

function normalizeDraftSettings(value: unknown, previous: WebAppAuthRuntimeSettings): WebAppAuthRuntimeSettings {
  const raw = value && typeof value === 'object'
    ? value as WebAppAuthSettingsDraft
    : {};

  const next: WebAppAuthRuntimeSettings = {
    mode: normalizeWebAppAuthMode(raw.mode, previous.mode),
    provider: normalizeOAuthProvider(raw.provider, previous.provider),
    dummyEmail: normalizeLimitedString(raw.dummyEmail, 'Dummy OAuth email') || previous.dummyEmail || DEFAULT_WEB_APP_AUTH_SETTINGS.dummyEmail,
    dummyAllowNonLocalhost: normalizeBoolean(raw.dummyAllowNonLocalhost, previous.dummyAllowNonLocalhost),
    authorizeUrl: normalizeLimitedString(raw.authorizeUrl, 'Authorization URL', MAX_URL_LENGTH),
    tokenUrl: normalizeLimitedString(raw.tokenUrl, 'Token URL', MAX_URL_LENGTH),
    userUrl: normalizeLimitedString(raw.userUrl, 'Profile URL', MAX_URL_LENGTH),
    clientId: normalizeLimitedString(raw.clientId, 'Client ID'),
    clientSecret: normalizeSecret(raw.clientSecret, previous.clientSecret),
    callbackUrl: normalizeLimitedString(raw.callbackUrl, 'Callback URL', MAX_URL_LENGTH),
    scopes: normalizeLimitedString(raw.scopes, 'OAuth scopes') || DEFAULT_WEB_APP_AUTH_SETTINGS.scopes,
    emailClaim: normalizeLimitedString(raw.emailClaim, 'Email claim path') || DEFAULT_WEB_APP_AUTH_SETTINGS.emailClaim,
    sessionSecret: normalizeSecret(raw.sessionSecret, previous.sessionSecret),
    sessionTtlSeconds: normalizeSessionTtlSeconds(raw.sessionTtlSeconds, DEFAULT_WEB_APP_AUTH_SETTINGS.sessionTtlSeconds),
    clientAuthMethod: normalizeClientAuthMethod(raw.clientAuthMethod, DEFAULT_WEB_APP_AUTH_SETTINGS.clientAuthMethod),
    debugLogProfile: normalizeBoolean(raw.debugLogProfile, DEFAULT_WEB_APP_AUTH_SETTINGS.debugLogProfile),
    serverUiAdminEmails: normalizeEmailList(raw.serverUiAdminEmails, 'Server UI admin emails'),
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  validateActiveOAuthSettings(next);
  return next;
}

function toPublicSettings(settings: WebAppAuthRuntimeSettings): WebAppAuthSettings {
  return {
    mode: settings.mode,
    provider: settings.provider,
    dummyEmail: settings.dummyEmail,
    dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
    authorizeUrl: settings.authorizeUrl,
    tokenUrl: settings.tokenUrl,
    userUrl: settings.userUrl,
    clientId: settings.clientId,
    clientSecretConfigured: Boolean(settings.clientSecret),
    callbackUrl: settings.callbackUrl,
    scopes: settings.scopes,
    emailClaim: settings.emailClaim,
    sessionSecretConfigured: Boolean(settings.sessionSecret),
    sessionTtlSeconds: settings.sessionTtlSeconds,
    clientAuthMethod: settings.clientAuthMethod,
    debugLogProfile: settings.debugLogProfile,
    serverUiAdminEmails: settings.serverUiAdminEmails,
    updatedAt: settings.updatedAt,
    source: settings.source,
  };
}

export function getWebAppAuthSettingsPath(): string {
  return path.join(
    path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot()),
    WEB_APP_AUTH_SETTINGS_RELATIVE_PATH,
  );
}

function readStoredWebAppAuthSettingsSync(): WebAppAuthRuntimeSettings {
  const settingsPath = getWebAppAuthSettingsPath();

  try {
    return normalizeStoredSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), 'app-settings');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_WEB_APP_AUTH_SETTINGS };
    }

    console.error('[web-app-auth] Failed to read web-app auth app settings; failing closed:', error);
    return { ...FAIL_CLOSED_WEB_APP_AUTH_SETTINGS };
  }
}

export function readWebAppAuthSettingsSync(): WebAppAuthRuntimeSettings {
  return readStoredWebAppAuthSettingsSync();
}

export async function readWebAppAuthSettings(): Promise<WebAppAuthSettings> {
  return toPublicSettings(readStoredWebAppAuthSettingsSync());
}

export async function writeWebAppAuthSettings(draft: unknown): Promise<WebAppAuthSettings> {
  const previous = readStoredWebAppAuthSettingsSync();
  const saved = normalizeDraftSettings(draft, previous);
  const settingsPath = getWebAppAuthSettingsPath();

  await writePrivateJsonSettingsFile(settingsPath, {
    version: 1,
    mode: saved.mode,
    provider: saved.provider,
    dummyEmail: saved.dummyEmail,
    dummyAllowNonLocalhost: saved.dummyAllowNonLocalhost,
    authorizeUrl: saved.authorizeUrl,
    tokenUrl: saved.tokenUrl,
    userUrl: saved.userUrl,
    clientId: saved.clientId,
    clientSecret: saved.clientSecret,
    callbackUrl: saved.callbackUrl,
    scopes: saved.scopes,
    emailClaim: saved.emailClaim,
    sessionSecret: saved.sessionSecret,
    sessionTtlSeconds: saved.sessionTtlSeconds,
    clientAuthMethod: saved.clientAuthMethod,
    debugLogProfile: saved.debugLogProfile,
    serverUiAdminEmails: saved.serverUiAdminEmails,
    updatedAt: saved.updatedAt,
  });

  return toPublicSettings(saved);
}
