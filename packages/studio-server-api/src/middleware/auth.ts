import type { RequestHandler } from 'express';
import { createHttpError } from '../utils/httpError.js';
import { isTrustedExecutorRequest, isTrustedProxyRequest, isTrustedUiSessionRequest } from '../auth.js';
import {
  getServerUiAuthMode,
  isServerUiAuthRequestAllowed,
  isServerUiOAuthSessionAllowed,
  readServerUiOAuthSession,
} from '../server-ui-auth.js';

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
    if (
      isTrustedExecutorRequest(req) &&
      ((req.method === 'GET' &&
        (req.path === '/workflows/execution-environment' ||
          /^\/workflows\/subgraph-projects\/[^/]+\/execution$/.test(req.path))) ||
        (req.method === 'POST' && req.path === '/workflows/local-editor-recordings/subgraph-run') ||
        (req.method === 'POST' && req.path === '/workflows/local-catalog-io') ||
        req.path === '/workflows/llm-profile-health' ||
        req.path.startsWith('/workflows/llm-profile-health/'))
    )
      return next();
    if (!isServerUiAuthRequestAllowed(req)) {
      return next(createHttpError(403, 'Forbidden', { closeConnection: true }));
    }
    next();
  });
};

/** Migration exports the complete installation, including secrets. General UI access and trusted-client bypass are insufficient. */
function sensitiveStorageOperatorAuth(flag: string): RequestHandler {
  return (req, res, next) => {
    if (process.env[flag] !== '1') {
      return next(createHttpError(404, 'Not found'));
    }
    const mode = getServerUiAuthMode();
    const authenticated =
      mode === 'key'
        ? isTrustedUiSessionRequest(req)
        : mode === 'oauth' && isServerUiOAuthSessionAllowed(readServerUiOAuthSession(req));
    if (!authenticated) return next(createHttpError(403, 'Migration requires a signed-in operator session.'));

    if (req.method !== 'GET') {
      // A custom header prevents a cross-site HTML form from invoking a state-changing route.
      if (req.get('X-Rivet-Migration-Intent') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site') {
        return next(createHttpError(403, 'Migration request must come from the server UI.'));
      }
      const origin = req.get('Origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('Host')) {
            return next(createHttpError(403, 'Migration request origin does not match this server.'));
          }
        } catch {
          return next(createHttpError(403, 'Migration request origin is invalid.'));
        }
      }
    }
    next();
  };
}
export const requireVmMigrationOperatorAuth = sensitiveStorageOperatorAuth('RIVET_VM_MIGRATION_ENABLED');
export const requireLocalUpgradeOperatorAuth = sensitiveStorageOperatorAuth('RIVET_LOCAL_METADATA_UPGRADE_ENABLED');
