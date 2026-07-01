import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import { RIVET_WEB_APPS_BASE_PATH } from './workflowEndpointPaths.js';
import { createHttpError } from './utils/httpError.js';
import { addUiAuthErrorToReturnTo, sanitizeUiAuthReturnTo } from './routes/ui-auth.js';
import { isTrustedProxyRequest } from './auth.js';
import {
  readWebAppAuthSettingsSync,
  requireSecureOAuthUrl,
} from './web-app-auth-settings.js';
import type { WebAppAuthMode } from '../../shared/app-settings-types.js';

const OAUTH_STATE_COOKIE_NAME = 'rivet_web_app_oauth_state';
const OAUTH_SESSION_COOKIE_NAME = 'rivet_web_app_oauth_session';
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const DUMMY_OAUTH_CODE_PREFIX = 'dummy:';

export type WebAppOAuthSession = {
  email: string;
  expiresAt: number;
  settingsVersion: string;
};

type SignedPayload = {
  expiresAt: number;
  [key: string]: unknown;
};

type OAuthStatePayload = SignedPayload & {
  nonce: string;
  returnTo: string;
  settingsVersion: string;
};

type OAuthStateCookiePayload = SignedPayload & {
  nonce: string;
  returnTo?: string;
  settingsVersion: string;
};

type OAuthConfig = {
  provider: 'dummy';
  email: string;
} | {
  provider: 'external';
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: 'basic' | 'body';
  emailClaim: string;
  scopes: string;
};

function isDummyOAuthProvider(): boolean {
  const settings = readWebAppAuthSettingsSync();
  return settings.mode === 'oauth' && settings.provider === 'dummy';
}

export function getWebAppAuthMode(): WebAppAuthMode {
  return readWebAppAuthSettingsSync().mode;
}

function getRequiredOauthConfig(): OAuthConfig {
  const settings = readWebAppAuthSettingsSync();
  if (settings.mode !== 'oauth') {
    throw createHttpError(401, 'OAuth web-app auth is not enabled');
  }

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
    throw createHttpError(500, 'OAuth is enabled but OAuth provider settings are incomplete');
  }
  requireSecureOAuthUrl('Authorization URL', authorizeUrl);
  requireSecureOAuthUrl('Token URL', tokenUrl);
  requireSecureOAuthUrl('Profile URL', userUrl);

  return {
    authorizeUrl,
    tokenUrl,
    userUrl,
    clientId,
    clientSecret,
    provider: 'external',
    clientAuthMethod: settings.clientAuthMethod,
    emailClaim: settings.emailClaim || 'email',
    scopes: settings.scopes || 'email',
  };
}

function getSigningSecret(): string {
  const settings = readWebAppAuthSettingsSync();
  const secret = settings.sessionSecret || settings.clientSecret;
  if (!secret) {
    throw createHttpError(500, 'OAuth is enabled but no OAuth session signing secret is configured');
  }

  return secret;
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(value: SignedPayload): string {
  const payload = base64UrlEncodeJson(value);
  const signature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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

function getOAuthSettingsSessionVersion(): string {
  const settings = readWebAppAuthSettingsSync();
  const signingSecret = getSigningSecret();
  const clientSecretFingerprint = settings.clientSecret
    ? createHmac('sha256', signingSecret).update(settings.clientSecret).digest('base64url')
    : '';

  return createHmac('sha256', signingSecret)
    .update(JSON.stringify({
      mode: settings.mode,
      provider: settings.provider,
      dummyEmail: settings.dummyEmail,
      dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      userUrl: settings.userUrl,
      clientId: settings.clientId,
      clientSecretFingerprint,
      callbackUrl: settings.callbackUrl,
      scopes: settings.scopes,
      emailClaim: settings.emailClaim,
      sessionTtlSeconds: settings.sessionTtlSeconds,
      clientAuthMethod: settings.clientAuthMethod,
    }))
    .digest('base64url');
}

function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.get('cookie') ?? '';
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
  if (!isTrustedProxyRequest(req)) {
    return req.protocol || 'http';
  }

  return req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
}

function getForwardedHost(req: Request): string {
  if (!isTrustedProxyRequest(req)) {
    return req.get('host') || 'localhost';
  }

  return req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || 'localhost';
}

function getRequestOrigin(req: Request): string {
  return `${getForwardedProtocol(req)}://${getForwardedHost(req)}`;
}

function getCookieSecuritySuffix(req: Request): string {
  return getForwardedProtocol(req) === 'https' ? '; Secure' : '';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createCookie(name: string, value: string, req: Request, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    getCookieSecuritySuffix(req),
  ].filter(Boolean).join('; ');
}

function clearCookie(name: string, req: Request): string {
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
  const configuredCallbackUrl = readWebAppAuthSettingsSync().callbackUrl;
  if (configuredCallbackUrl) {
    requireSecureOAuthUrl('Callback URL', configuredCallbackUrl);
    return configuredCallbackUrl;
  }

  return `${getRequestOrigin(req)}${RIVET_WEB_APPS_BASE_PATH}/auth/callback`;
}

export function createWebAppOAuthAuthorizationRedirect(req: Request, returnTo: string): {
  location: string;
  cookies: string[];
} {
  const config = getRequiredOauthConfig();
  const nonce = randomBytes(24).toString('base64url');
  const sanitizedReturnTo = sanitizeUiAuthReturnTo(returnTo);
  const expiresAt = Date.now() + STATE_TTL_SECONDS * 1000;
  const settingsVersion = getOAuthSettingsSessionVersion();
  const state = signPayload({
    nonce,
    returnTo: sanitizedReturnTo,
    settingsVersion,
    expiresAt,
  } satisfies OAuthStatePayload);
  const stateCookie = signPayload({
    nonce,
    returnTo: sanitizedReturnTo,
    settingsVersion,
    expiresAt,
  } satisfies OAuthStateCookiePayload);

  if (config.provider === 'dummy') {
    if (!isDummyOAuthAllowedForRequest(req)) {
      throw createHttpError(403, 'Dummy OAuth is only available for localhost requests');
    }

    const authorizeUrl = new URL(`${getRequestOrigin(req)}${RIVET_WEB_APPS_BASE_PATH}/auth/dummy`);
    authorizeUrl.searchParams.set('state', state);

    return {
      location: authorizeUrl.toString(),
      cookies: [createCookie(OAUTH_STATE_COOKIE_NAME, stateCookie, req, STATE_TTL_SECONDS)],
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
    cookies: [createCookie(OAUTH_STATE_COOKIE_NAME, stateCookie, req, STATE_TTL_SECONDS)],
  };
}

export function readWebAppOAuthSession(req: Request): WebAppOAuthSession | null {
  const payload = readSignedPayload<WebAppOAuthSession>(readCookie(req, OAUTH_SESSION_COOKIE_NAME));
  if (!payload || typeof payload.email !== 'string') {
    return null;
  }

  let expectedSettingsVersion: string;
  try {
    expectedSettingsVersion = getOAuthSettingsSessionVersion();
  } catch {
    return null;
  }

  if (payload.settingsVersion !== expectedSettingsVersion) {
    return null;
  }

  const email = payload.email.trim().toLowerCase();
  return email ? { email, expiresAt: payload.expiresAt, settingsVersion: payload.settingsVersion } : null;
}

export function isWebAppOAuthSessionAllowed(
  session: WebAppOAuthSession | null,
  allowedEmails: readonly string[] = [],
): boolean {
  if (!session) {
    return false;
  }

  const allowed = new Set(allowedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  return allowed.size > 0 && allowed.has(session.email);
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
  const config = getRequiredOauthConfig();
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

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await readJsonResponse(response, 'token exchange');
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw createHttpError(401, 'OAuth token response did not include an access token');
  }

  return accessToken;
}

async function fetchOAuthUserEmail(accessToken: string): Promise<string> {
  const config = getRequiredOauthConfig();
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
    console.warn('[web-app-oauth] OAuth profile response:', JSON.stringify(profile));
  }

  const email = getClaimFromObject(profile, config.emailClaim);
  if (typeof email !== 'string' || !email.trim()) {
    throw createHttpError(401, `OAuth profile did not include ${config.emailClaim}`);
  }

  return email.trim().toLowerCase();
}

function getOAuthCallbackFailureCode(error: unknown): string {
  if (error instanceof Error && error.message.includes('not enabled')) {
    return 'oauth_state';
  }

  if (error instanceof Error && error.message.includes('profile did not include')) {
    return 'oauth_profile';
  }

  if (error instanceof Error && error.message.includes('token')) {
    return 'oauth_token';
  }

  return 'oauth_failed';
}

function shouldRedirectOAuthCallbackFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status < 500;
}

export const webAppOAuthRouter = Router();

function getLocalRequestHostName(req: Request): string {
  const host = getForwardedHost(req).split(',')[0]?.trim() ?? '';
  if (host.startsWith('[')) {
    const closingBracketIndex = host.indexOf(']');
    return closingBracketIndex > 1 ? host.slice(1, closingBracketIndex) : host;
  }

  const colonCount = host.split(':').length - 1;
  if (colonCount === 1) {
    return host.split(':')[0]!;
  }

  return host;
}

function isDummyOAuthAllowedForRequest(req: Request): boolean {
  if (!isDummyOAuthProvider()) {
    return false;
  }

  if (readWebAppAuthSettingsSync().dummyAllowNonLocalhost) {
    return true;
  }

  const host = getLocalRequestHostName(req).toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function createDummyOAuthCode(email: string): string {
  return `${DUMMY_OAUTH_CODE_PREFIX}${Buffer.from(email.trim().toLowerCase(), 'utf8').toString('base64url')}`;
}

function renderDummyOAuthPage(state: string): string {
  const config = getRequiredOauthConfig();
  const email = config.provider === 'dummy' ? config.email : 'local@example.test';
  const action = `${RIVET_WEB_APPS_BASE_PATH}/auth/dummy`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dummy OAuth sign in</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101114; color: #f4f4f5; }
  main { width: min(440px, calc(100vw - 32px)); border: 1px solid #333741; border-radius: 8px; background: #1d1f24; padding: 24px; box-shadow: 0 24px 80px rgb(0 0 0 / 0.38); }
  h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.2; }
  p { margin: 0 0 18px; color: #c8c8cf; line-height: 1.5; }
  label { display: grid; gap: 8px; color: #d6d8df; font-size: 13px; font-weight: 650; }
  input { box-sizing: border-box; width: 100%; min-height: 38px; border: 1px solid #3d414b; border-radius: 6px; background: #272a31; color: #f4f4f5; padding: 0 11px; font: inherit; }
  button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; margin-top: 14px; padding: 0 13px; border: 0; border-radius: 6px; background: #2f6fed; color: white; font: 650 14px/1 Inter, ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
  code { color: #d6d8df; }
</style>
<main>
  <h1>Dummy OAuth sign in</h1>
  <p>This local-only provider creates a normal Rivet web-app OAuth session for testing allowlists.</p>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label>
      Email
      <input name="email" type="email" value="${escapeHtml(email)}" autocomplete="email" required autofocus>
    </label>
    <button type="submit">Continue</button>
  </form>
</main>`;
}

webAppOAuthRouter.get('/auth/dummy', (req, res) => {
  if (!isDummyOAuthAllowedForRequest(req)) {
    res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Forbidden</title><body>Dummy OAuth is only available for localhost requests.</body>');
    return;
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).type('html').send(renderDummyOAuthPage(state));
});

webAppOAuthRouter.post('/auth/dummy', (req, res) => {
  if (!isDummyOAuthAllowedForRequest(req)) {
    res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Forbidden</title><body>Dummy OAuth is only available for localhost requests.</body>');
    return;
  }

  const state = typeof req.body?.state === 'string' ? req.body.state : '';
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const callbackUrl = new URL(`${RIVET_WEB_APPS_BASE_PATH}/auth/callback`, getRequestOrigin(req));
  callbackUrl.searchParams.set('code', createDummyOAuthCode(email));
  callbackUrl.searchParams.set('state', state);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.redirect(303, `${callbackUrl.pathname}${callbackUrl.search}`);
});

webAppOAuthRouter.get('/auth/callback', async (req, res, next) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const statePayload = readSignedPayload<OAuthStatePayload>(state);
    const stateCookie = readSignedPayload<OAuthStateCookiePayload>(
      readCookie(req, OAUTH_STATE_COOKIE_NAME),
    );
    const fallbackReturnTo = sanitizeUiAuthReturnTo(statePayload?.returnTo ?? stateCookie?.returnTo);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Set-Cookie', clearCookie(OAUTH_STATE_COOKIE_NAME, req));

    if (typeof req.query.error === 'string') {
      res.redirect(303, addUiAuthErrorToReturnTo(fallbackReturnTo, 'oauth_denied'));
      return;
    }

    let currentSettingsVersion: string;
    try {
      currentSettingsVersion = getOAuthSettingsSessionVersion();
    } catch {
      res.redirect(303, addUiAuthErrorToReturnTo(fallbackReturnTo, 'oauth_state'));
      return;
    }

    if (
      !code
      || !statePayload
      || !stateCookie
      || statePayload.nonce !== stateCookie.nonce
      || statePayload.settingsVersion !== stateCookie.settingsVersion
      || statePayload.settingsVersion !== currentSettingsVersion
    ) {
      res.redirect(303, addUiAuthErrorToReturnTo(fallbackReturnTo, 'oauth_state'));
      return;
    }

    let email: string;
    try {
      const accessToken = await exchangeCodeForToken(req, code);
      email = await fetchOAuthUserEmail(accessToken);
    } catch (error) {
      if (!shouldRedirectOAuthCallbackFailure(error)) {
        throw error;
      }

      res.redirect(303, addUiAuthErrorToReturnTo(fallbackReturnTo, getOAuthCallbackFailureCode(error)));
      return;
    }

    const ttlSeconds = Math.max(60, readWebAppAuthSettingsSync().sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS);
    const sessionCookie = createCookie(
      OAUTH_SESSION_COOKIE_NAME,
      signPayload({
        email,
        expiresAt: Date.now() + ttlSeconds * 1000,
        settingsVersion: getOAuthSettingsSessionVersion(),
      }),
      req,
      ttlSeconds,
    );
    res.setHeader('Set-Cookie', [
      clearCookie(OAUTH_STATE_COOKIE_NAME, req),
      sessionCookie,
    ]);
    res.redirect(303, sanitizeUiAuthReturnTo(statePayload.returnTo));
  } catch (error) {
    next(error);
  }
});

webAppOAuthRouter.get('/auth/logout', (req, res) => {
  const returnTo = typeof req.query.return_to === 'string'
    ? req.query.return_to
    : RIVET_WEB_APPS_BASE_PATH;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Set-Cookie', [
    clearCookie(OAUTH_STATE_COOKIE_NAME, req),
    clearCookie(OAUTH_SESSION_COOKIE_NAME, req),
  ]);
  res.redirect(303, sanitizeUiAuthReturnTo(returnTo));
});
