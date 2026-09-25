import type { RequestHandler } from 'express';
import { createHttpError } from '../utils/httpError.js';
import { isTrustedExecutorRequest, isTrustedProxyRequest } from '../auth.js';
import { isServerUiAuthRequestAllowed } from '../server-ui-auth.js';

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!isTrustedProxyRequest(req)) {
    next(createHttpError(403, 'Forbidden', { closeConnection: true }));
    return;
  }

  next();
};

export const requireOperatorAuth: RequestHandler = (req, res, next) => {
  requireAuth(req, res, (error) => {
    if (error) return next(error);
    // The executor's existing service-only overlay and profile-health routes
    // do not represent browser operator sessions. Never grant all /api access.
    if (isTrustedExecutorRequest(req) && (
      (req.method === 'GET' && (req.path === '/workflows/execution-environment' ||
        /^\/workflows\/subgraph-projects\/[^/]+\/execution$/.test(req.path))) ||
      (req.method === 'POST' && req.path === '/workflows/local-editor-recordings/subgraph-run') ||
      req.path === '/workflows/llm-profile-health' || req.path.startsWith('/workflows/llm-profile-health/')
    )) return next();
    if (!isServerUiAuthRequestAllowed(req)) {
      return next(createHttpError(403, 'Forbidden', { closeConnection: true }));
    }
    next();
  });
};
