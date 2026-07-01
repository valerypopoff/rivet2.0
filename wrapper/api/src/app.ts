import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

import { nativeRouter } from './routes/native.js';
import { shellRouter } from './routes/shell.js';
import { pluginsRouter } from './routes/plugins.js';
import { projectsRouter } from './routes/projects.js';
import {
  internalPublishedWorkflowsRouter,
  latestWebAppsRouter,
  latestWorkflowsRouter,
  publishedWebAppsRouter,
  publishedWorkflowsRouter,
  workflowsRouter,
} from './routes/workflows/index.js';
import { configRouter } from './routes/config.js';
import { uiAuthRouter } from './routes/ui-auth.js';
import { webAppOAuthRouter } from './web-app-oauth.js';
import { runtimeLibrariesRouter } from './routes/runtime-libraries.js';
import {
  LATEST_WORKFLOWS_BASE_PATH,
  PUBLISHED_WORKFLOWS_BASE_PATH,
  RIVET_LATEST_WEB_APPS_BASE_PATH,
  RIVET_WEB_APPS_BASE_PATH,
} from './workflowEndpointPaths.js';
import { requireAuth } from './middleware/auth.js';
import { isTrustedProxyRequest } from './auth.js';
import { getApiRuntimeProfile, isControlPlaneApiProfile, isExecutionOnlyApiProfile } from './runtime-profile.js';

export function getApiErrorResponse(err: Error): { status: number; body: { error: string } } {
  const status = (err as { status?: number }).status ?? 500;
  const expose = Boolean((err as { expose?: boolean }).expose);

  return {
    status,
    body: {
      error: status >= 500 && !expose ? 'Internal server error' : err.message,
    },
  };
}

function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getFirstHeaderValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim() ?? '';
}

function getPublicRequestOrigin(req: Request): string | null {
  const shouldTrustForwardedHeaders = isTrustedProxyRequest(req);
  const protocol = shouldTrustForwardedHeaders
    ? getFirstHeaderValue(req.get('x-forwarded-proto')).toLowerCase() || req.protocol || 'http'
    : req.protocol || 'http';
  const host = shouldTrustForwardedHeaders
    ? getFirstHeaderValue(req.get('x-forwarded-host')) || req.get('host') || ''
    : req.get('host') || '';
  return normalizeOrigin(host ? `${protocol}://${host}` : null);
}

function getConfiguredCorsAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of (process.env.RIVET_CORS_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = normalizeOrigin(value.trim());
    if (origin) {
      origins.add(origin);
    }
  }

  return origins;
}

export function isCorsOriginAllowed(req: Request, origin: string | undefined): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  if (normalizedOrigin === getPublicRequestOrigin(req)) {
    return true;
  }

  return getConfiguredCorsAllowedOrigins().has(normalizedOrigin);
}

function createCorsOptions(req: Request) {
  const origin = req.get('origin');
  return {
    credentials: true,
    origin: origin && isCorsOriginAllowed(req, origin) ? origin : false,
    optionsSuccessStatus: 204,
  };
}

export function getApiRouteExposureMatrix(profile = getApiRuntimeProfile()): string[] {
  const surfaces: string[] = [];

  if (isControlPlaneApiProfile(profile)) {
    surfaces.push(
      '/ui-auth',
      `${RIVET_WEB_APPS_BASE_PATH}/auth/callback`,
      `${RIVET_WEB_APPS_BASE_PATH}/auth/dummy`,
      `${RIVET_WEB_APPS_BASE_PATH}/auth/logout`,
      `${LATEST_WORKFLOWS_BASE_PATH}/:endpointName`,
      `${RIVET_LATEST_WEB_APPS_BASE_PATH}/:slug`,
      '/api/native/*',
      '/api/shell/*',
      '/api/plugins/*',
      '/api/projects/*',
      '/api/workflows/*',
      '/api/runtime-libraries/*',
      '/api/config*',
    );
  }

  if (profile === 'combined' || profile === 'execution') {
    surfaces.push(
      `${RIVET_WEB_APPS_BASE_PATH}/auth/callback`,
      `${RIVET_WEB_APPS_BASE_PATH}/auth/dummy`,
      `${RIVET_WEB_APPS_BASE_PATH}/auth/logout`,
      `${PUBLISHED_WORKFLOWS_BASE_PATH}/:endpointName`,
      `${RIVET_WEB_APPS_BASE_PATH}/:slug`,
      '/internal/workflows/:endpointName',
    );
  }

  return [...new Set(surfaces)];
}

export function assertApiRuntimeProfileStartupPreconditions(profile = getApiRuntimeProfile()): void {
  if (isExecutionOnlyApiProfile(profile) && process.env.RIVET_STORAGE_MODE?.trim().toLowerCase() !== 'managed') {
    throw new Error('RIVET_API_PROFILE=execution requires RIVET_STORAGE_MODE=managed');
  }
}

function mountControlPlaneRoutes(app: Express): void {
  app.use('/', uiAuthRouter);
  app.use(LATEST_WORKFLOWS_BASE_PATH, latestWorkflowsRouter);
  app.use(RIVET_LATEST_WEB_APPS_BASE_PATH, latestWebAppsRouter);
  app.use('/api', requireAuth);
  app.use('/api/native', nativeRouter);
  app.use('/api/shell', shellRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/runtime-libraries', runtimeLibrariesRouter);
  app.use('/api', configRouter);
}

function mountPublishedExecutionRoutes(app: Express): void {
  app.use(PUBLISHED_WORKFLOWS_BASE_PATH, publishedWorkflowsRouter);
  app.use(RIVET_WEB_APPS_BASE_PATH, publishedWebAppsRouter);
  app.use('/internal/workflows', internalPublishedWorkflowsRouter);
}

export function createApiApp(profile = getApiRuntimeProfile()): Express {
  const app = express();

  app.use(cors((req, callback) => {
    callback(null, createCorsOptions(req));
  }));
  app.use(express.json({ limit: '100mb', strict: false }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  if (isControlPlaneApiProfile(profile) || profile === 'execution') {
    app.use(RIVET_WEB_APPS_BASE_PATH, webAppOAuthRouter);
  }

  if (isControlPlaneApiProfile(profile)) {
    mountControlPlaneRoutes(app);
  }

  if (profile === 'combined' || profile === 'execution') {
    mountPublishedExecutionRoutes(app);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled API error:', err);
    const response = getApiErrorResponse(err);
    res.status(response.status).json(response.body);
  });

  return app;
}
