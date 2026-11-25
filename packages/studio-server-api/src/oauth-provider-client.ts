import { createHttpError } from './utils/httpError.js';

type OAuthTokenConfig = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  clientAuthMethod: 'body' | 'basic';
};

/** Return fetch directly so the surface keeps its response/JSON await boundaries. */
export function requestOAuthToken(
  config: OAuthTokenConfig,
  code: string,
  callbackUrl: string,
): Promise<globalThis.Response> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl });
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
  return fetch(config.tokenUrl, { method: 'POST', headers, body });
}

export function requestOAuthProfile(userUrl: string, accessToken: string): Promise<globalThis.Response> {
  return fetch(userUrl, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
}

export async function readOAuthProviderJsonResponse(
  response: globalThis.Response,
  description: string,
): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createHttpError(401, `OAuth ${description} failed`);
  }
  return payload as Record<string, unknown>;
}

export function readOAuthAccessToken(payload: Record<string, unknown>): string {
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw createHttpError(401, 'OAuth token response did not include an access token');
  }
  return accessToken;
}

function getClaimFromObject(value: unknown, claimPath: string): unknown {
  return claimPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function readOAuthProfileEmail(profile: Record<string, unknown>, claimPath: string): string {
  const email = getClaimFromObject(profile, claimPath);
  if (typeof email !== 'string' || !email.trim()) {
    throw createHttpError(401, `OAuth profile did not include ${claimPath}`);
  }
  return email.trim().toLowerCase();
}
