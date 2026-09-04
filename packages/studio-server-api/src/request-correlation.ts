import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Request, RequestHandler } from 'express';

import { isTrustedProxyRequest } from './auth.js';

export const RIVET_CORRELATION_HEADER = 'x-rivet-correlation-id';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,95}$/;
const requestCorrelationIds = new WeakMap<IncomingMessage, string>();

function readHeaderValue(request: Request | IncomingMessage): string | null {
  const rawValue = request.headers[RIVET_CORRELATION_HEADER];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return typeof value === 'string' ? value : null;
}

/**
 * Keeps correlation IDs printable, bounded, and safe to include in logs and
 * durable recording metadata. Direct clients cannot choose an ID: only the
 * authenticated Rivet proxy is trusted to forward one.
 */
export function normalizeRivetCorrelationId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && CORRELATION_ID_PATTERN.test(normalized) ? normalized : null;
}

export function createRivetCorrelationId(): string {
  return 'rvt-' + randomUUID();
}

export function getRequestCorrelationId(request: Request | IncomingMessage): string {
  const cached = requestCorrelationIds.get(request);
  if (cached) {
    return cached;
  }

  const trustedForwardedId = isTrustedProxyRequest(request)
    ? normalizeRivetCorrelationId(readHeaderValue(request))
    : null;
  const correlationId = trustedForwardedId ?? createRivetCorrelationId();
  requestCorrelationIds.set(request, correlationId);
  return correlationId;
}

/**
 * Set one request-scoped response header before parsing or route dispatch.
 * This deliberately does not create a metric label: request IDs have unbounded
 * cardinality and belong in logs and recording metadata only.
 */
export function createRequestCorrelationMiddleware(): RequestHandler {
  return (request, response, next) => {
    response.setHeader(RIVET_CORRELATION_HEADER, getRequestCorrelationId(request));
    next();
  };
}
