import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';

import {
  isTrustedTokenFreeHostRequest,
  isTrustedUiSessionRequest,
} from './auth.js';
import { addUiAuthErrorToReturnTo, sanitizeUiAuthReturnTo } from './ui-auth-utils.js';
import { readWebAppAuthSettingsSync, requireSecureOAuthUrl } from './web-app-auth-settings.js';
import { createHttpError } from './utils/httpError.js';

export type ServerUiAuthMode = 'none' | 'key' | 'oauth';

type SignedPayload = {
  expiresAt: number;
  [key: string]: unknown;
};

type ServerUiOAuthStatePayload = SignedPayload & {
  nonce: string;
  returnTo: string;
  settingsVersion: string;
};

type ServerUiOAuthStateCookiePayload = SignedPayload & {
  nonce: string;
  returnTo?: string;
  settingsVersion: string;
};

type ServerUiOAuthSession = SignedPayload & {
  email: string;
  settingsVersion: string;
};

type ServerUiOAuthConfig = {
  provider: 'dummy';
  email: string;
} | {
  provider: 'external';
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: 'body' | 'basic';
  emailClaim: string;
  scopes: string;
};

export const SERVER_UI_OAUTH_STATE_COOKIE_NAME = 'rivet_ui_oauth_state';
export const SERVER_UI_OAUTH_SESSION_COOKIE_NAME = 'rivet_ui_oauth_session';

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const DUMMY_OAUTH_CODE_PREFIX = 'dummy:';

function normalizeString(value: string | undefined): string {
  return value?.trim() ?? '';
}

function normalizeBoolean(value: string | undefined, fallback = false): boolean {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeAuthMode(value: string | undefined): ServerUiAuthMode | null {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['none', 'no-gate', 'nogate', 'off', 'false', '0'].includes(normalized)) {
    return 'none';
  }

  if (['key', 'rivet-key', 'rivet_key', 'ui-gate', 'uigate'].includes(normalized)) {
    return 'key';
  }

  return normalized === 'oauth' ? 'oauth' : null;
}

function getEnv(name: string): string {
  return normalizeString(process.env[name]);
}

export function getServerUiAuthMode(): ServerUiAuthMode {
  const explicitMode = normalizeAuthMode(process.env.RIVET_SERVER_UI_AUTH_MODE);
  if (explicitMode) {
    return explicitMode;
  }

  return normalizeBoolean(process.env.RIVET_REQUIRE_UI_GATE_KEY) ? 'key' : 'none';
}

function getRequiredServerUiOAuthConfig(): ServerUiOAuthConfig {
  if (getServerUiAuthMode() !== 'oauth') {
    throw createHttpError(401, 'OAuth server UI auth is not enabled');
  }

  const settings = readWebAppAuthSettingsSync();
  if (settings.provider === 'dummy') {
    return {
      provider: 'dummy',
      email: settings.dummyEmail || 'local@example.test',
    };
  }

  const authorizeUrl = settings.authorizeUrl;
  const tokenUrl = settings.tokenUrl;
  const userUrl = settings.userUrl;
  const clientId = settings.clientId;
  const clientSecret = settings.clientSecret;

  if (!authorizeUrl || !tokenUrl || !userUrl || !clientId || !clientSecret) {
    throw createHttpError(
      500,
      'OAuth is enabled for the server UI but saved OAuth provider settings are incomplete',
    );
  }
  requireSecureOAuthUrl('Server UI OAuth authorization URL', authorizeUrl);
  requireSecureOAuthUrl('Server UI OAuth token URL', tokenUrl);
  requireSecureOAuthUrl('Server UI OAuth profile URL', userUrl);

  return {
    provider: 'external',
    authorizeUrl,
    tokenUrl,
    userUrl,
    clientId,
    clientSecret,
    clientAuthMethod: settings.clientAuthMethod,
    emailClaim: settings.emailClaim || 'email',
    scopes: settings.scopes || 'email',
  };
}

function getSigningSecret(): string {
  const settings = readWebAppAuthSettingsSync();
  const secret = settings.sessionSecret || settings.clientSecret || getEnv('RIVET_KEY');
  if (!secret) {
    throw createHttpError(500, 'OAuth is enabled for the server UI but no session signing secret is configured');
  }

  return secret;
}

function getAdminEmails(): Set<string> {
  return new Set(readWebAppAuthSettingsSync().serverUiAdminEmails);
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signPayload(value: SignedPayload): string {
  const payload = base64UrlEncodeJson(value);
  const signature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSignedPayload<T extends SignedPayload>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  const payload = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  let expectedSignature: string;
  try {
    expectedSignature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  } catch {
    return null;
  }

  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
    return Number(parsed.expiresAt) > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function getServerUiOAuthSettingsVersion(): string {
  const settings = readWebAppAuthSettingsSync();
  const signingSecret = getSigningSecret();
  const clientSecret = settings.clientSecret;
  const sessionSecret = settings.sessionSecret;

  return createHmac('sha256', signingSecret)
    .update(JSON.stringify({
      mode: getServerUiAuthMode(),
      provider: settings.provider,
      dummyEmail: settings.dummyEmail,
      dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      userUrl: settings.userUrl,
      clientId: settings.clientId,
      clientSecretFingerprint: clientSecret ? createHmac('sha256', signingSecret).update(clientSecret).digest('base64url') : '',
      scopes: settings.scopes,
      emailClaim: settings.emailClaim,
      sessionSecretFingerprint: sessionSecret ? createHmac('sha256', signingSecret).update(sessionSecret).digest('base64url') : '',
      sessionTtlSeconds: settings.sessionTtlSeconds,
      clientAuthMethod: settings.clientAuthMethod,
      adminEmails: [...getAdminEmails()].sort(),
    }))
    .digest('base64url');
}

export function readCookie(req: Request | IncomingMessage, name: string): string | null {
  const rawCookieHeader = 'get' in req ? req.get('cookie') : req.headers.cookie;
  const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader.join(';') : rawCookieHeader ?? '';
  for (const cookie of cookieHeader.split(';')) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    if (cookie.slice(0, separatorIndex).trim() === name) {
      return cookie.slice(separatorIndex + 1).trim();
    }
  }

  return null;
}

function getForwardedProtocol(req: Request): string {
  return req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
}

function getForwardedHost(req: Request): string {
  return req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
}

function getRequestOrigin(req: Request): string {
  return `${getForwardedProtocol(req)}://${getForwardedHost(req)}`;
}

function getCookieSecuritySuffix(req: Request): string {
  return getForwardedProtocol(req) === 'https' ? '; Secure' : '';
}

export function createCookie(name: string, value: string, req: Request, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    getCookieSecuritySuffix(req),
  ].filter(Boolean).join('; ');
}

export function clearCookie(name: string, req: Request): string {
  return [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    getCookieSecuritySuffix(req),
  ].filter(Boolean).join('; ');
}

function getCallbackUrl(req: Request): string {
  return `${getRequestOrigin(req)}/__rivet_auth/oauth/callback`;
}

export function createServerUiOAuthAuthorizationRedirect(req: Request, returnTo: string): {
  location: string;
  cookies: string[];
} {
  const config = getRequiredServerUiOAuthConfig();
  const nonce = randomBytes(24).toString('base64url');
  const sanitizedReturnTo = sanitizeUiAuthReturnTo(returnTo);
  const expiresAt = Date.now() + STATE_TTL_SECONDS * 1000;
  const settingsVersion = getServerUiOAuthSettingsVersion();
  const state = signPayload({ nonce, returnTo: sanitizedReturnTo, settingsVersion, expiresAt } satisfies ServerUiOAuthStatePayload);
  const stateCookie = signPayload({ nonce, returnTo: sanitizedReturnTo, settingsVersion, expiresAt });

  if (config.provider === 'dummy') {
    if (!isDummyOAuthAllowedForRequest(req)) {
      throw createHttpError(403, 'Dummy OAuth is only available for localhost requests');
    }

    const authorizeUrl = new URL(`${getRequestOrigin(req)}/__rivet_auth/oauth/dummy`);
    authorizeUrl.searchParams.set('state', state);
    return {
      location: authorizeUrl.toString(),
      cookies: [createCookie(SERVER_UI_OAUTH_STATE_COOKIE_NAME, stateCookie, req, STATE_TTL_SECONDS)],
    };
  }

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', getCallbackUrl(req));
  authorizeUrl.searchParams.set('state', state);
  if (config.scopes) {
    authorizeUrl.searchParams.set('scope', config.scopes);
  }

  return {
    location: authorizeUrl.toString(),
    cookies: [createCookie(SERVER_UI_OAUTH_STATE_COOKIE_NAME, stateCookie, req, STATE_TTL_SECONDS)],
  };
}

export function readServerUiOAuthSession(req: Request | IncomingMessage): ServerUiOAuthSession | null {
  const payload = readSignedPayload<ServerUiOAuthSession>(readCookie(req, SERVER_UI_OAUTH_SESSION_COOKIE_NAME));
  if (!payload || typeof payload.email !== 'string') {
    return null;
  }

  let expectedSettingsVersion: string;
  try {
    expectedSettingsVersion = getServerUiOAuthSettingsVersion();
  } catch {
    return null;
  }

  if (payload.settingsVersion !== expectedSettingsVersion) {
    return null;
  }

  const email = payload.email.trim().toLowerCase();
  return email ? { email, expiresAt: payload.expiresAt, settingsVersion: payload.settingsVersion } : null;
}

export function readServerUiOAuthState(req: Request, state: string): ServerUiOAuthStatePayload | null {
  const statePayload = readSignedPayload<ServerUiOAuthStatePayload>(state);
  const stateCookie = readSignedPayload<ServerUiOAuthStateCookiePayload>(
    readCookie(req, SERVER_UI_OAUTH_STATE_COOKIE_NAME),
  );

  if (
    !statePayload ||
    !stateCookie ||
    statePayload.nonce !== stateCookie.nonce ||
    statePayload.returnTo !== stateCookie.returnTo
  ) {
    return null;
  }

  let expectedSettingsVersion: string;
  try {
    expectedSettingsVersion = getServerUiOAuthSettingsVersion();
  } catch {
    return null;
  }

  if (
    statePayload.settingsVersion !== stateCookie.settingsVersion ||
    statePayload.settingsVersion !== expectedSettingsVersion
  ) {
    return null;
  }

  return statePayload;
}

export function isServerUiOAuthSessionAllowed(session: ServerUiOAuthSession | null): boolean {
  if (!session) {
    return false;
  }

  const allowed = getAdminEmails();
  return allowed.size > 0 && allowed.has(session.email);
}

export function isServerUiAuthRequestAllowed(req: Request | IncomingMessage): boolean {
  if (isTrustedTokenFreeHostRequest(req)) {
    return true;
  }

  const mode = getServerUiAuthMode();
  if (mode === 'none') {
    return true;
  }

  if (mode === 'key') {
    return isTrustedUiSessionRequest(req);
  }

  return isServerUiOAuthSessionAllowed(readServerUiOAuthSession(req));
}

function getClaimFromObject(value: unknown, claimPath: string): unknown {
  return claimPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);
}

async function readJsonResponse(response: globalThis.Response, description: string): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError(401, `OAuth ${description} failed`);
  }

  return payload as Record<string, unknown>;
}

async function exchangeCodeForToken(req: Request, code: string): Promise<string> {
  const config = getRequiredServerUiOAuthConfig();
  if (config.provider === 'dummy') {
    if (!isDummyOAuthAllowedForRequest(req)) {
      throw createHttpError(403, 'Dummy OAuth is only available for localhost requests');
    }

    if (!code.startsWith(DUMMY_OAUTH_CODE_PREFIX)) {
      throw createHttpError(401, 'OAuth dummy code is invalid');
    }

    return code;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getCallbackUrl(req),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };

  if (config.clientAuthMethod === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, { method: 'POST', headers, body });
  const payload = await readJsonResponse(response, 'token exchange');
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw createHttpError(401, 'OAuth token response did not include an access token');
  }

  return accessToken;
}

async function fetchOAuthUserEmail(accessToken: string): Promise<string> {
  const config = getRequiredServerUiOAuthConfig();
  if (config.provider === 'dummy') {
    const encodedEmail = accessToken.slice(DUMMY_OAUTH_CODE_PREFIX.length);
    const email = Buffer.from(encodedEmail, 'base64url').toString('utf8').trim().toLowerCase();
    if (!email) {
      throw createHttpError(401, 'OAuth dummy profile did not include email');
    }

    return email;
  }

  const response = await fetch(config.userUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  const profile = await readJsonResponse(response, 'profile request');
  if (readWebAppAuthSettingsSync().debugLogProfile) {
    console.warn('[server-ui-oauth] OAuth profile response:', JSON.stringify(profile));
  }

  const email = getClaimFromObject(profile, config.emailClaim);
  if (typeof email !== 'string' || !email.trim()) {
    throw createHttpError(401, `OAuth profile did not include ${config.emailClaim}`);
  }

  return email.trim().toLowerCase();
}

export function getServerUiOAuthCallbackFailureCode(error: unknown): string {
  if (error instanceof Error && error.message.includes('profile did not include')) {
    return 'oauth_profile';
  }
  if (error instanceof Error && error.message.includes('token')) {
    return 'oauth_token';
  }
  if ((error as { status?: unknown } | null)?.status === 403) {
    return 'oauth_forbidden';
  }

  return 'oauth_failed';
}

export function shouldRedirectServerUiOAuthCallbackFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status < 500;
}

function getLocalRequestHostName(req: Request): string {
  const host = getForwardedHost(req).split(',')[0]?.trim() ?? '';
  if (host.startsWith('[')) {
    const closingBracketIndex = host.indexOf(']');
    return closingBracketIndex > 1 ? host.slice(1, closingBracketIndex) : host;
  }

  const colonCount = host.split(':').length - 1;
  return colonCount === 1 ? host.split(':')[0]! : host;
}

export function isDummyOAuthAllowedForRequest(req: Request): boolean {
  const settings = readWebAppAuthSettingsSync();
  if (getServerUiAuthMode() !== 'oauth' || settings.provider !== 'dummy') {
    return false;
  }

  if (settings.dummyAllowNonLocalhost) {
    return true;
  }

  const host = getLocalRequestHostName(req).toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function createDummyOAuthCode(email: string): string {
  return `${DUMMY_OAUTH_CODE_PREFIX}${Buffer.from(email.trim().toLowerCase(), 'utf8').toString('base64url')}`;
}

export function getServerUiOAuthDummyEmail(): string {
  return readWebAppAuthSettingsSync().dummyEmail || 'local@example.test';
}

export async function completeServerUiOAuthCallback(req: Request, code: string): Promise<string> {
  const accessToken = await exchangeCodeForToken(req, code);
  const email = await fetchOAuthUserEmail(accessToken);
  const settingsVersion = getServerUiOAuthSettingsVersion();
  if (!isServerUiOAuthSessionAllowed({ email, expiresAt: Date.now() + 1000, settingsVersion })) {
    throw createHttpError(403, 'OAuth user is not allowed to open the Rivet server UI');
  }

  const ttlSeconds = readWebAppAuthSettingsSync().sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS;
  return createCookie(
    SERVER_UI_OAUTH_SESSION_COOKIE_NAME,
    signPayload({ email, expiresAt: Date.now() + ttlSeconds * 1000, settingsVersion }),
    req,
    ttlSeconds,
  );
}

export function getServerUiAuthErrorMessage(errorCode: string): string {
  if (errorCode === 'invalid') {
    return 'Access key was rejected. Try again.';
  }
  if (errorCode === 'forbidden' || errorCode === 'unavailable') {
    return 'Unable to authenticate right now.';
  }
  if (errorCode === 'oauth_profile') {
    return 'OAuth sign-in succeeded, but the profile response did not include the configured email claim.';
  }
  if (errorCode === 'oauth_token') {
    return 'OAuth sign-in could not exchange the authorization code for an access token.';
  }
  if (errorCode === 'oauth_state') {
    return 'The OAuth sign-in session expired. Try signing in again.';
  }
  if (errorCode === 'oauth_denied') {
    return 'The OAuth provider rejected the sign-in request.';
  }
  if (errorCode === 'oauth_forbidden') {
    return 'Your email is not allowed to open this Rivet server UI.';
  }

  return errorCode ? 'OAuth sign-in failed. Try signing in again.' : '';
}

export function getServerUiOAuthStartPath(returnTo: string): string {
  const url = new URL('/__rivet_auth/oauth/start', 'http://rivet.local');
  url.searchParams.set('return_to', sanitizeUiAuthReturnTo(returnTo));
  return `${url.pathname}${url.search}`;
}

export function addServerUiOAuthError(returnTo: string, errorCode: string): string {
  return addUiAuthErrorToReturnTo(returnTo, errorCode);
}
