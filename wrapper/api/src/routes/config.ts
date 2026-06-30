import { Router, type Request } from 'express';
import path from 'node:path';
import { LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH, isLatestWorkflowRemoteDebuggerEnabled } from '../latestWorkflowRemoteDebugger.js';
import { getAppDataRoot, isEnvAllowed } from '../security.js';
import {
  LATEST_WORKFLOWS_BASE_PATH,
  PUBLISHED_WORKFLOWS_BASE_PATH,
  RIVET_LATEST_WEB_APPS_BASE_PATH,
  RIVET_WEB_APPS_BASE_PATH,
} from '../workflowEndpointPaths.js';
import { getWebAppAuthMode } from '../web-app-oauth.js';

export const configRouter = Router();

function getPublicOrigin(req: Request): string {
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  if (!host) {
    return 'http://localhost';
  }

  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
  return `${protocol}://${host}`;
}

function toWebSocketOrigin(origin: string): string {
  return origin.startsWith('https://') ? `wss://${origin.slice('https://'.length)}` : `ws://${origin.slice('http://'.length)}`;
}

// GET /api/config — return runtime configuration
configRouter.get('/config', (req, res) => {
  const publicOrigin = getPublicOrigin(req);
  const publicWsOrigin = toWebSocketOrigin(publicOrigin);

  res.json({
    hostedMode: true,
    executorWsUrl: process.env.RIVET_EXECUTOR_WS_URL ?? `${publicWsOrigin}/ws/executor/internal`,
    remoteDebuggerDefaultWs: isLatestWorkflowRemoteDebuggerEnabled()
      ? (process.env.RIVET_REMOTE_DEBUGGER_DEFAULT_WS ?? `${publicWsOrigin}${LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH}`)
      : '',
    apiBaseUrl: '/api',
    publishedWorkflowsBasePath: PUBLISHED_WORKFLOWS_BASE_PATH,
    latestWorkflowsBasePath: LATEST_WORKFLOWS_BASE_PATH,
    publishedAppsBasePath: RIVET_WEB_APPS_BASE_PATH,
    latestAppsBasePath: RIVET_LATEST_WEB_APPS_BASE_PATH,
    webAppsAuthMode: getWebAppAuthMode(),
  });
});

// GET /api/path/app-local-data-dir
configRouter.get('/path/app-local-data-dir', (_req, res) => {
  res.json({ path: getAppDataRoot() });
});

// GET /api/path/app-log-dir
configRouter.get('/path/app-log-dir', (_req, res) => {
  res.json({ path: path.join(getAppDataRoot(), 'logs') });
});

// GET /api/config/env/:name
configRouter.get('/config/env/:name', (req, res) => {
  const name = String(req.params.name ?? '');

  if (!name) {
    res.status(400).json({ error: 'Missing env var name' });
    return;
  }

  if (!isEnvAllowed(name)) {
    res.json({ value: '' });
    return;
  }

  res.json({ value: process.env[name] ?? '' });
});
