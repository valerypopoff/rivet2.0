import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';

export type ExpiringOAuthPayload = {
  expiresAt: number;
  [key: string]: unknown;
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Resolve the surface's secret only after encoding, preserving its original error order. */
export function signOAuthPayload(value: ExpiringOAuthPayload, getSigningSecret: () => string): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readSignedOAuthPayload<T extends ExpiringOAuthPayload>(
  value: string | null,
  getSigningSecret: () => string,
): T | null {
  if (!value) return null;
  const separatorIndex = value.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  const payload = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  let expectedSignature: string;
  try {
    expectedSignature = createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
  } catch {
    return null;
  }
  if (!safeEqual(signature, expectedSignature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
    return Number(parsed.expiresAt) > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function readOAuthCookie(req: Request | IncomingMessage, name: string): string | null {
  const rawCookieHeader = 'get' in req ? req.get('cookie') : req.headers.cookie;
  const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader.join(';') : rawCookieHeader ?? '';
  for (const cookie of cookieHeader.split(';')) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex < 0) continue;
    if (cookie.slice(0, separatorIndex).trim() === name) return cookie.slice(separatorIndex + 1).trim();
  }
  return null;
}

/** The caller retains trust/protocol policy and supplies the historical suffix verbatim. */
export function createOAuthCookie(name: string, value: string, maxAgeSeconds: number, securitySuffix: string): string {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, securitySuffix]
    .filter(Boolean)
    .join('; ');
}
