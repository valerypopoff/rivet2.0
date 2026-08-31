import { createHmac, timingSafeEqual } from 'node:crypto';

const CAPABILITY_PREFIX = 'rivet-capacity-v1';
const MAX_CAPABILITY_LIFETIME_SECONDS = 3 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const safeEndpointName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export type WorkflowCapacityCapabilityPayload = {
  v: 1;
  iat: number;
  exp: number;
  endpoints: string[];
};

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function decodePayload(encodedPayload: string): WorkflowCapacityCapabilityPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    !Number.isInteger(record.iat) ||
    !Number.isInteger(record.exp) ||
    !Array.isArray(record.endpoints) ||
    record.endpoints.length === 0 ||
    record.endpoints.length > 8 ||
    Object.keys(record).some((key) => !['v', 'iat', 'exp', 'endpoints'].includes(key))
  ) {
    return null;
  }
  const endpoints = record.endpoints;
  if (
    !endpoints.every((endpoint) => typeof endpoint === 'string' && safeEndpointName.test(endpoint)) ||
    new Set(endpoints).size !== endpoints.length
  ) {
    return null;
  }
  return {
    v: 1,
    iat: record.iat as number,
    exp: record.exp as number,
    endpoints: endpoints as string[],
  };
}

export function createWorkflowCapacityCapability({
  signingKey,
  endpoints,
  nowMs = Date.now(),
  lifetimeSeconds,
}: {
  signingKey: string;
  endpoints: string[];
  nowMs?: number;
  lifetimeSeconds: number;
}): string {
  if (!signingKey.trim()) throw new Error('Capacity capability signing key is required.');
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_CAPABILITY_LIFETIME_SECONDS) {
    throw new Error(
      `Capacity capability lifetime must be an integer from 1 to ${MAX_CAPABILITY_LIFETIME_SECONDS} seconds.`,
    );
  }
  const normalizedEndpoints = [...new Set(endpoints)];
  if (
    normalizedEndpoints.length === 0 ||
    normalizedEndpoints.length > 8 ||
    normalizedEndpoints.some((endpoint) => !safeEndpointName.test(endpoint))
  ) {
    throw new Error('Capacity capability endpoints must contain between 1 and 8 safe published endpoint names.');
  }
  const iat = Math.floor(nowMs / 1_000);
  const payload: WorkflowCapacityCapabilityPayload = {
    v: 1,
    iat,
    exp: iat + lifetimeSeconds,
    endpoints: normalizedEndpoints,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey)
    .update(`${CAPABILITY_PREFIX}.${encodedPayload}`)
    .digest('base64url');
  return `${CAPABILITY_PREFIX}.${encodedPayload}.${signature}`;
}

export function isWorkflowCapacityCapabilityValid({
  token,
  signingKey,
  endpointName,
  nowMs = Date.now(),
}: {
  token: string | null;
  signingKey: string;
  endpointName: string;
  nowMs?: number;
}): boolean {
  if (!token || !signingKey.trim() || !safeEndpointName.test(endpointName)) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX) return false;
  const [, encodedPayload, providedSignature] = parts;
  const expectedSignature = createHmac('sha256', signingKey)
    .update(`${CAPABILITY_PREFIX}.${encodedPayload}`)
    .digest('base64url');
  if (!timingSafeStringEqual(providedSignature, expectedSignature)) return false;
  const payload = decodePayload(encodedPayload);
  if (!payload) return false;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    payload.exp <= nowSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_CAPABILITY_LIFETIME_SECONDS ||
    !payload.endpoints.includes(endpointName)
  ) {
    return false;
  }
  return true;
}
