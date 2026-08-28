import { Router, type Request } from 'express';
import path from 'node:path';
import { LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH, isLatestWorkflowRemoteDebuggerEnabled } from '../latestWorkflowRemoteDebugger.js';
import { getAppDataRoot, isEnvAllowed, isProtectedBrowserEnvName } from '../security.js';
import { resolveBrowserEnvironmentVariable } from '../environment-variable-settings.js';
import {
  getLatestWebAppsBasePath,
  getLatestWorkflowsBasePath,
  getPublishedWebAppsBasePath,
  getPublishedWorkflowsBasePath,
} from '../workflowEndpointPaths.js';
import { getWebAppAuthMode } from '../web-app-oauth.js';
import { readDeploymentStorageRuntimeSettingsSync } from '../deployment-storage-settings.js';
import { readExecutorUrlOverrideSettingsSync } from '../executor-url-override-settings.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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
  const deploymentStorageSettings = readDeploymentStorageRuntimeSettingsSync();
  const executorUrlOverrides = readExecutorUrlOverrideSettingsSync();

  res.json({
    hostedMode: true,
    executorWsUrl: executorUrlOverrides.executorWsUrl || `${publicWsOrigin}/ws/executor/internal`,
    remoteDebuggerDefaultWs: isLatestWorkflowRemoteDebuggerEnabled()
      ? (executorUrlOverrides.remoteDebuggerDefaultWs || `${publicWsOrigin}${LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH}`)
      : '',
    apiBaseUrl: '/api',
    publishedWorkflowsBasePath: getPublishedWorkflowsBasePath(),
    latestWorkflowsBasePath: getLatestWorkflowsBasePath(),
    publishedAppsBasePath: getPublishedWebAppsBasePath(),
    latestAppsBasePath: getLatestWebAppsBasePath(),
    webAppsAuthMode: getWebAppAuthMode(),
    storageMode: deploymentStorageSettings.storageMode,
    databaseMode: deploymentStorageSettings.databaseMode,
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
configRouter.get('/config/env/:name', asyncHandler(async (req, res) => {
  const name = String(req.params.name ?? '');

  if (!name) {
    res.status(400).json({ error: 'Missing env var name' });
    return;
  }

  if (isProtectedBrowserEnvName(name)) {
    res.json({ value: '' });
    return;
  }

  const managed = await resolveBrowserEnvironmentVariable(name);
  if (managed.configured) {
    res.json({ value: managed.value ?? '' });
    return;
  }

  res.json({ value: isEnvAllowed(name) ? process.env[name] ?? '' : '' });
}));
