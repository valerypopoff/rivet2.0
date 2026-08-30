import { performance } from 'node:perf_hooks';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express';
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
import { appSettingsRouter } from './routes/app-settings.js';
import { uiAuthRouter } from './routes/ui-auth.js';
import { webAppOAuthRouter } from './web-app-oauth.js';
import { runtimeLibrariesRouter } from './routes/runtime-libraries.js';
import {
  getLatestWebAppsBasePath,
  getLatestWorkflowsBasePath,
  getPublishedWebAppsBasePath,
  getPublishedWorkflowsBasePath,
} from './workflowEndpointPaths.js';
import { getWorkflowStorageBackendMode } from './routes/workflows/storage-config.js';
import { requireAuth } from './middleware/auth.js';
import { createProxySettingsSnapshot } from './proxy-settings-snapshot.js';
import { isTrustedProxyRequest } from './auth.js';
import {
  getApiRuntimeProfile,
  isControlPlaneApiProfile,
  isExecutionOnlyApiProfile,
  isPublishedExecutionApiProfile,
} from './runtime-profile.js';
import type { RuntimeHealthReader } from './runtime-health.js';
import { readRuntimeLimitSettingsSync } from './runtime-limit-settings.js';
import { captureAppSettingsSnapshot } from './middleware/app-settings-snapshot.js';
import { getManagedPostgresPoolMetrics } from './managed-postgres-pool.js';
import { getStudioMetrics, type MetricsHttpRoute, type StudioMetrics } from './metrics.js';
import { getWorkflowExecutionRecordingPersistenceMetrics } from './routes/workflows/recordings.js';

type RuntimeExpressRouter = {
  handle: (req: Request, res: Response, next: NextFunction) => void;
};

const DEFAULT_JSON_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

type ApiAppOptions = {
  health?: RuntimeHealthReader;
  metrics?: StudioMetrics;
};

function isWebAppActionRequest(req: Request): boolean {
  const requestPath = req.path.replace(/\/+$/, '');

  if (req.method !== 'POST' || !requestPath.endsWith('/actions/run')) {
    return false;
  }

  return [getPublishedWebAppsBasePath(), getLatestWebAppsBasePath()].some((basePath) => {
    const prefix = `${basePath}/`;
    const slug = requestPath.slice(prefix.length, -'/actions/run'.length);
    return requestPath.startsWith(prefix) && slug.length > 0 && !slug.includes('/');
  });
}

function matchesPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function getMetricsHttpRoute(req: Request): MetricsHttpRoute {
  const pathname = req.path.replace(/\/+$/, '') || '/';
  if (matchesPath(pathname, getPublishedWorkflowsBasePath())) return 'published_workflow';
  if (matchesPath(pathname, getPublishedWebAppsBasePath())) return 'published_web_app';
  if (matchesPath(pathname, getLatestWorkflowsBasePath())) return 'latest_workflow';
  if (matchesPath(pathname, getLatestWebAppsBasePath())) return 'latest_web_app';
  if (matchesPath(pathname, '/internal/workflows')) return 'internal_workflow';
  if (matchesPath(pathname, '/api')) return 'api';
  return 'other';
}

function createMetricsRequestObserver(metrics: StudioMetrics): RequestHandler {
  return (req, res, next) => {
    if (!metrics.enabled) {
      next();
      return;
    }

    const startedAt = performance.now();
    const route = getMetricsHttpRoute(req);
    res.once('finish', () => {
      metrics.observeHttpRequest({
        durationMs: performance.now() - startedAt,
        method: req.method,
        route,
        status: res.statusCode,
      });
    });
    next();
  };
}

function collectMetricsSnapshot(collect: () => void): void {
  try {
    collect();
  } catch {
    // Scrapes can race a subsystem starting or stopping. Keep every remaining
    // process-local metric available and never surface dependency details.
  }
}

function sendMetrics(metrics: StudioMetrics, health: RuntimeHealthReader, res: Response): void {
  collectMetricsSnapshot(() => metrics.setRuntimeHealth(health.getLiveness(), health.getReadiness()));
  collectMetricsSnapshot(() => metrics.setPostgresPool(getManagedPostgresPoolMetrics()));
  collectMetricsSnapshot(() =>
    metrics.setWorkflowRecordingPersistence(getWorkflowExecutionRecordingPersistenceMetrics()),
  );

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(metrics.render());
}
function createJsonBodyParser(): RequestHandler {
  const defaultParser = express.json({ limit: DEFAULT_JSON_BODY_LIMIT_BYTES, strict: false });

  return (req, res, next) => {
    if (!isWebAppActionRequest(req)) {
      defaultParser(req, res, next);
      return;
    }

    express.json({
      limit: readRuntimeLimitSettingsSync().webAppActionRequestLimitBytes,
      strict: false,
    })(req, res, next);
  };
}

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
  const publishedAppsBasePath = getPublishedWebAppsBasePath();
  const latestAppsBasePath = getLatestWebAppsBasePath();
  const publishedWorkflowsBasePath = getPublishedWorkflowsBasePath();
  const latestWorkflowsBasePath = getLatestWorkflowsBasePath();

  if (isControlPlaneApiProfile(profile)) {
    surfaces.push(
      '/ui-auth',
      '/ui-auth/check',
      '/ui-auth/prompt',
      '/ui-auth/oauth/*',
      `${publishedAppsBasePath}/auth/callback`,
      `${publishedAppsBasePath}/auth/dummy`,
      `${publishedAppsBasePath}/auth/logout`,
      `${latestWorkflowsBasePath}/:endpointName`,
      `${latestAppsBasePath}/:slug`,
      `${latestAppsBasePath}/:slug/actions/ws`,
      '/api/native/*',
      '/api/shell/*',
      '/api/plugins/*',
      '/api/projects/*',
      '/api/workflows/*',
      '/api/runtime-libraries/*',
      '/api/app-settings/*',
      '/api/config*',
      '/internal/app-settings/proxy-config',
    );
  }

  if (isPublishedExecutionApiProfile(profile)) {
    surfaces.push(
      `${publishedAppsBasePath}/auth/callback`,
      `${publishedAppsBasePath}/auth/dummy`,
      `${publishedAppsBasePath}/auth/logout`,
      `${publishedWorkflowsBasePath}/:endpointName`,
      `${publishedAppsBasePath}/:slug`,
      `${publishedAppsBasePath}/:slug/actions/ws`,
      '/internal/workflows/:endpointName',
    );
  }

  return [...new Set(surfaces)];
}

export function assertApiRuntimeProfileStartupPreconditions(profile = getApiRuntimeProfile()): void {
  if (isExecutionOnlyApiProfile(profile) && getWorkflowStorageBackendMode() !== 'managed') {
    throw new Error(`RIVET_API_PROFILE=${profile} requires Settings -> Storage to use Object storage`);
  }
}

function dispatchDynamicBasePath(getBasePath: () => string, router: ExpressRouter): RequestHandler {
  const runtimeRouter = router as unknown as RuntimeExpressRouter;

  return (req, res, next) => {
    const basePath = getBasePath();
    const requestPath = req.path;

    if (requestPath !== basePath && !requestPath.startsWith(`${basePath}/`)) {
      next();
      return;
    }

    const originalUrl = req.url;
    const queryIndex = originalUrl.indexOf('?');
    const pathOnly = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
    const trimmedPath = pathOnly.slice(basePath.length) || '/';
    req.url = `${trimmedPath}${query}`;

    runtimeRouter.handle(req, res, (error?: unknown) => {
      req.url = originalUrl;
      next(error);
    });
  };
}

function mountControlPlaneRoutes(app: Express): void {
  app.get('/internal/app-settings/proxy-config', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(createProxySettingsSnapshot());
  });
  app.use('/', uiAuthRouter);
  app.use(dispatchDynamicBasePath(getLatestWorkflowsBasePath, latestWorkflowsRouter));
  app.use(dispatchDynamicBasePath(getLatestWebAppsBasePath, latestWebAppsRouter));
  app.use('/api', requireAuth);
  app.use('/api/native', nativeRouter);
  app.use('/api/shell', shellRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use('/api/runtime-libraries', runtimeLibrariesRouter);
  app.use('/api/app-settings', appSettingsRouter);
  app.use('/api', configRouter);
}

function mountPublishedExecutionRoutes(app: Express): void {
  app.use(dispatchDynamicBasePath(getPublishedWorkflowsBasePath, publishedWorkflowsRouter));
  app.use(dispatchDynamicBasePath(getPublishedWebAppsBasePath, publishedWebAppsRouter));
  app.use('/internal/workflows', internalPublishedWorkflowsRouter);
}

export function createApiApp(profile = getApiRuntimeProfile(), options: ApiAppOptions = {}): Express {
  const app = express();
  const metrics = options.metrics ?? getStudioMetrics();

  const fallbackHealth: RuntimeHealthReader = {
    getLiveness: () => ({ ok: true, profile, state: 'ready', checkedAt: null, checks: [] }),
    getReadiness: () => ({ ok: true, profile, state: 'ready', checkedAt: null, checks: [] }),
  };
  const health = options.health ?? fallbackHealth;
  const sendHealth = (snapshot: ReturnType<RuntimeHealthReader['getLiveness']>, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(snapshot.ok ? 200 : 503).json(snapshot);
  };

  app.use(
    cors((req, callback) => {
      callback(null, createCorsOptions(req));
    }),
  );

  if (metrics.enabled) {
    app.get('/metrics', (_req, res) => sendMetrics(metrics, health, res));
  }

  app.get('/healthz', (_req, res) => {
    const snapshot = health.getLiveness();
    res.setHeader('Cache-Control', 'no-store');
    res.status(snapshot.ok ? 200 : 503).json({ ok: snapshot.ok });
  });
  app.get('/livez', (_req, res) => sendHealth(health.getLiveness(), res));
  app.get('/readyz', (_req, res) => sendHealth(health.getReadiness(), res));

  // Do not count platform probes or Prometheus scrapes as application traffic.
  app.use(createMetricsRequestObserver(metrics));

  app.use(captureAppSettingsSnapshot);
  app.use(createJsonBodyParser());
  app.use(express.urlencoded({ extended: false }));

  if (isControlPlaneApiProfile(profile) || profile === 'execution') {
    app.use(dispatchDynamicBasePath(getPublishedWebAppsBasePath, webAppOAuthRouter));
  }

  if (isControlPlaneApiProfile(profile)) {
    mountControlPlaneRoutes(app);
  }

  if (isPublishedExecutionApiProfile(profile)) {
    mountPublishedExecutionRoutes(app);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const response = getApiErrorResponse(err);
    if (response.status >= 500) {
      console.error('Unhandled API error:', err);
    }
    res.status(response.status).json(response.body);
  });

  return app;
}
