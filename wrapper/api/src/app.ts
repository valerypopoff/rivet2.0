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
import { runtimeLibrariesRouter } from './routes/runtime-libraries.js';
import {
  LATEST_WORKFLOWS_BASE_PATH,
  PUBLISHED_WORKFLOWS_BASE_PATH,
  RIVET_LATEST_WEB_APPS_BASE_PATH,
  RIVET_WEB_APPS_BASE_PATH,
} from './workflowEndpointPaths.js';
import { requireAuth } from './middleware/auth.js';
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

export function getApiRouteExposureMatrix(profile = getApiRuntimeProfile()): string[] {
  const surfaces: string[] = [];

  if (isControlPlaneApiProfile(profile)) {
    surfaces.push(
      '/ui-auth',
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
      `${PUBLISHED_WORKFLOWS_BASE_PATH}/:endpointName`,
      `${RIVET_WEB_APPS_BASE_PATH}/:slug`,
      '/internal/workflows/:endpointName',
    );
  }

  return surfaces;
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

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '100mb', strict: false }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

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
