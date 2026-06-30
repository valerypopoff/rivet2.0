import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

import { RIVET_WEB_APPS_BASE_PATH } from './workflowEndpointPaths.js';
import { createHttpError } from './utils/httpError.js';
import { addUiAuthErrorToReturnTo, sanitizeUiAuthReturnTo } from './routes/ui-auth.js';

const OAUTH_STATE_COOKIE_NAME = 'rivet_web_app_oauth_state';
const OAUTH_SESSION_COOKIE_NAME = 'rivet_web_app_oauth_session';
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export type WebAppAuthMode = 'ui-gate' | 'oauth' | 'none';

export type WebAppOAuthSession = {
  email: string;
  expiresAt: number;
};

type SignedPayload = {
  expiresAt: number;
  [key: string]: unknown;
};

type OAuthStatePayload = SignedPayload & {
  nonce: string;
  returnTo: string;
};

type OAuthStateCookiePayload = SignedPayload & {
  nonce: string;
  returnTo?: string;
};

function getEnvString(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function isEnvFlagEnabled(name: string): boolean {
  const value = getEnvString(name).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function getWebAppAuthMode(): WebAppAuthMode {
  const value = getEnvString('RIVET_WEB_APPS_AUTH_MODE').toLowerCase();
  if (value === 'oauth' || value === 'none') {
    return value;
  }

  return 'ui-gate';
}

function getRequiredOauthConfig() {
  const authorizeUrl = getEnvString('OAUTH_AUTHORIZE_URL');
  const tokenUrl = getEnvString('OAUTH_TOKEN_URL');
  const userUrl = getEnvString('OAUTH_USER_URL');
  const clientId = getEnvString('OAUTH_CLIENT_ID');
  const clientSecret = getEnvString('OAUTH_CLIENT_SECRET');

  if (!authorizeUrl || !tokenUrl || !userUrl || !clientId || !clientSecret) {
    throw createHttpError(500, 'OAuth is enabled but OAuth provider settings are incomplete');
  }

  return {
    authorizeUrl,
    tokenUrl,
    userUrl,
    clientId,
    clientSecret,
    clientAuthMethod: getEnvString('OAUTH_CLIENT_AUTH_METHOD').toLowerCase() === 'basic' ? 'basic' : 'body',
    emailClaim: getEnvString('OAUTH_EMAIL_CLAIM') || 'email',
    scopes: getEnvString('OAUTH_SCOPES') || 'profile email',
  };
}

function getSigningSecret(): string {
  const secret = getEnvString('OAUTH_SESSION_SECRET') || getEnvString('OAUTH_CLIENT_SECRET') || getEnvString('RIVET_KEY');
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
  const expectedSignature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
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
  return getEnvString('OAUTH_CALLBACK_URL') || `${getRequestOrigin(req)}${RIVET_WEB_APPS_BASE_PATH}/auth/callback`;
}

export function createWebAppOAuthAuthorizationRedirect(req: Request, returnTo: string): {
  location: string;
  cookies: string[];
} {
  const config = getRequiredOauthConfig();
  const nonce = randomBytes(24).toString('base64url');
  const sanitizedReturnTo = sanitizeUiAuthReturnTo(returnTo);
  const expiresAt = Date.now() + STATE_TTL_SECONDS * 1000;
  const state = signPayload({
    nonce,
    returnTo: sanitizedReturnTo,
    expiresAt,
  } satisfies OAuthStatePayload);
  const stateCookie = signPayload({
    nonce,
    returnTo: sanitizedReturnTo,
    expiresAt,
  } satisfies OAuthStateCookiePayload);

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

  const email = payload.email.trim().toLowerCase();
  return email ? { email, expiresAt: payload.expiresAt } : null;
}

export function isWebAppOAuthSessionAllowed(
  session: WebAppOAuthSession | null,
  allowedEmails: readonly string[] = [],
): boolean {
  if (!session) {
    return false;
  }

  if (allowedEmails.length === 0) {
    return true;
  }

  const allowed = new Set(allowedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  return allowed.has(session.email);
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
  const response = await fetch(config.userUrl, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  const profile = await readJsonResponse(response, 'profile request');
  if (isEnvFlagEnabled('OAUTH_DEBUG_LOG_PROFILE')) {
    console.warn('[web-app-oauth] OAuth profile response:', JSON.stringify(profile));
  }

  const email = getClaimFromObject(profile, config.emailClaim);
  if (typeof email !== 'string' || !email.trim()) {
    throw createHttpError(401, `OAuth profile did not include ${config.emailClaim}`);
  }

  return email.trim().toLowerCase();
}

function getOAuthCallbackFailureCode(error: unknown): string {
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

    if (!code || !statePayload || !stateCookie || statePayload.nonce !== stateCookie.nonce) {
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

    const ttlSeconds = Math.max(60, Number.parseInt(getEnvString('OAUTH_SESSION_TTL_SECONDS'), 10) || DEFAULT_SESSION_TTL_SECONDS);
    const sessionCookie = createCookie(
      OAUTH_SESSION_COOKIE_NAME,
      signPayload({
        email,
        expiresAt: Date.now() + ttlSeconds * 1000,
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
