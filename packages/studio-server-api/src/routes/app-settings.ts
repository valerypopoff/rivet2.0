import { Router, type Request, type Response } from 'express';
import {
  publishedExecutionSettingsRepository,
  readPublishedExecutionSettings,
  writePublishedExecutionSettings,
} from '../published-execution-settings.js';
import { requireVmMigrationOperatorAuth } from '../middleware/auth.js';
import { registerLocalUpgradeHttpRoutes } from './local-upgrade-http.js';
import type { RuntimeLimitSettingsDraft, ServerUiSession } from '../../../studio-server-shared/app-settings-types.js';
import {
  deploymentStorageSettingsRepository,
  readDeploymentStorageSettings,
  writeDeploymentStorageSettings,
} from '../deployment-storage-settings.js';
import {
  environmentVariableSettingsRepository,
  readEnvironmentVariableSettings,
  readEnvironmentVariableValue,
  writeEnvironmentVariableSettings,
} from '../environment-variable-settings.js';
import {
  executorUrlOverrideSettingsRepository,
  readExecutorUrlOverrideSettings,
  writeExecutorUrlOverrideSettings,
} from '../executor-url-override-settings.js';
import {
  nodeExecutorProxySettingsRepository,
  readNodeExecutorProxySettings,
  writeNodeExecutorProxySettings,
} from '../node-executor-proxy-settings.js';
import {
  publicRouteSettingsRepository,
  readPublicRouteSettings,
  readWebAppRouteSettings,
  writePublicRouteSettings,
  writeWebAppRouteSettings,
} from '../public-route-settings.js';
import {
  runtimeLimitSettingsRepository,
  readRuntimeLimitSettings,
  writeRuntimeLimitSettings,
} from '../runtime-limit-settings.js';
import {
  trustedClientSettingsRepository,
  readTrustedClientSettings,
  writeTrustedClientSettings,
} from '../trusted-client-settings.js';
import {
  webAppAuthSettingsRepository,
  readWebAppAuthSettings,
  writeWebAppAuthSettings,
} from '../web-app-auth-settings.js';
import {
  workflowEndpointAuthSettingsRepository,
  readWorkflowEndpointAuthSettings,
  writeWorkflowEndpointAuthSettings,
} from '../workflow-endpoint-auth-settings.js';
import { createHttpError } from '../utils/httpError.js';
import { getVerifiedClientAddress, isTrustedClientRequest } from '../auth.js';
import { getServerUiAuthMode, isServerUiOAuthSessionAllowed, readServerUiOAuthSession } from '../server-ui-auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createControlPlaneJsonBodyParser, createJsonBodyParser } from '../middleware/body-parsers.js';
import { registerVmMigrationHttpRoutes } from './vm-migration-http.js';
import {
  runRecordingsSettingsRepository,
  readRunRecordingsSettings,
  writeRunRecordingsSettings,
} from './workflows/recordings-config.js';

export { readNodeExecutorProxySettings, writeNodeExecutorProxySettings } from '../node-executor-proxy-settings.js';
export { readRunRecordingsSettings, writeRunRecordingsSettings } from './workflows/recordings-config.js';

export const appSettingsRouter = Router();
const migrationJsonBody = createJsonBodyParser(() => 16 * 1024);
// Ownership choices can include many history entries; still keep admission bounded.
const localPreparationJsonBody = createJsonBodyParser(() => 1024 * 1024);
appSettingsRouter.use('/vm-migration', requireVmMigrationOperatorAuth);
appSettingsRouter.get('/server-ui-session', (req, res) => {
  const mode = getServerUiAuthMode();
  const session = mode === 'oauth' ? readServerUiOAuthSession(req) : null;
  res.set('Cache-Control', 'no-store').json({
    mode,
    email: session && isServerUiOAuthSessionAllowed(session) ? session.email : null,
  } satisfies ServerUiSession);
});
registerLocalUpgradeHttpRoutes(appSettingsRouter, { migrationJsonBody, localPreparationJsonBody });
registerVmMigrationHttpRoutes(appSettingsRouter, migrationJsonBody);
appSettingsRouter.get('/trusted-clients/current-request', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    clientAddress: getVerifiedClientAddress(req),
    trusted: isTrustedClientRequest(req),
  });
});
const jsonBody = createControlPlaneJsonBodyParser();

type NodeExecutorProxySettingsReloader = () => Promise<unknown> | unknown;

type NodeExecutorProxySettingsGlobal = typeof globalThis & {
  __rivetReloadNodeExecutorProxySettings?: NodeExecutorProxySettingsReloader;
};

type SettingsRepositoryHandle = {
  readSync(): { revision: string };
};

type SettingsReader = () => Promise<unknown>;
type SettingsWriter = (draft: unknown, expectedRevision?: string) => Promise<unknown>;

function getExpectedRevision(req: Request): string | undefined {
  const ifMatch = req.get('if-match')?.trim();
  if (!ifMatch || ifMatch === '*') {
    return undefined;
  }
  return ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function sendSettingsResponse(res: Response, repository: SettingsRepositoryHandle, settings: unknown): void {
  res.set('ETag', `"${repository.readSync().revision}"`);
  res.json(settings);
}

function registerSettingsResource(options: {
  path: string;
  repository: SettingsRepositoryHandle;
  read: SettingsReader;
  write: SettingsWriter;
  normalizeDraft?: (draft: unknown) => unknown;
  afterWrite?: () => Promise<void>;
}): void {
  appSettingsRouter.get(options.path, async (_req, res, next) => {
    try {
      sendSettingsResponse(res, options.repository, await options.read());
    } catch (error) {
      next(error);
    }
  });

  const writeHandler = asyncHandler(async (req, res) => {
    const draft = options.normalizeDraft?.(req.body) ?? req.body;
    const settings = await options.write(draft, getExpectedRevision(req));
    await options.afterWrite?.();
    sendSettingsResponse(res, options.repository, settings);
  });

  appSettingsRouter.put(options.path, jsonBody, writeHandler);
  appSettingsRouter.patch(options.path, jsonBody, writeHandler);
}

registerSettingsResource({
  path: '/published-execution',
  repository: publishedExecutionSettingsRepository,
  read: readPublishedExecutionSettings,
  write: writePublishedExecutionSettings,
});

function normalizeRuntimeLimitSettingsDraft(value: unknown): RuntimeLimitSettingsDraft {
  const raw = value && typeof value === 'object' ? (value as RuntimeLimitSettingsDraft) : {};
  const draft: RuntimeLimitSettingsDraft = {};

  for (const key of [
    'commandTimeoutSeconds',
    'maxOutputBytes',
    'proxyReadTimeoutSeconds',
    'webAppActionRequestLimitBytes',
    'dockerWaitTimeoutSeconds',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      draft[key] = raw[key];
    }
  }

  return draft;
}

async function reloadNodeExecutorProxySettingsInCurrentProcess(): Promise<void> {
  const reloader = (globalThis as NodeExecutorProxySettingsGlobal).__rivetReloadNodeExecutorProxySettings;
  if (!reloader) {
    return;
  }

  try {
    await reloader();
  } catch (error) {
    console.error('[app-settings] Failed to apply Node executor proxy settings in the current process:', error);
  }
}

registerSettingsResource({
  path: '/environment-variables',
  repository: environmentVariableSettingsRepository,
  read: readEnvironmentVariableSettings,
  write: writeEnvironmentVariableSettings,
});
appSettingsRouter.get('/environment-variables/:id/value', async (req, res, next) => {
  try {
    const value = await readEnvironmentVariableValue(req.params.id);
    if (value === undefined) {
      throw createHttpError(404, 'Environment variable not found');
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ id: req.params.id, value });
  } catch (error) {
    next(error);
  }
});
registerSettingsResource({
  path: '/node-executor-proxy',
  repository: nodeExecutorProxySettingsRepository,
  read: readNodeExecutorProxySettings,
  write: writeNodeExecutorProxySettings,
  afterWrite: reloadNodeExecutorProxySettingsInCurrentProcess,
});
registerSettingsResource({
  path: '/executor-url-overrides',
  repository: executorUrlOverrideSettingsRepository,
  read: readExecutorUrlOverrideSettings,
  write: writeExecutorUrlOverrideSettings,
});
registerSettingsResource({
  path: '/run-recordings',
  repository: runRecordingsSettingsRepository,
  read: readRunRecordingsSettings,
  write: writeRunRecordingsSettings,
});
registerSettingsResource({
  path: '/runtime-limits',
  repository: runtimeLimitSettingsRepository,
  read: readRuntimeLimitSettings,
  write: writeRuntimeLimitSettings,
  normalizeDraft: normalizeRuntimeLimitSettingsDraft,
});
registerSettingsResource({
  path: '/trusted-clients',
  repository: trustedClientSettingsRepository,
  read: readTrustedClientSettings,
  write: writeTrustedClientSettings,
});
registerSettingsResource({
  path: '/deployment-storage',
  repository: deploymentStorageSettingsRepository,
  read: readDeploymentStorageSettings,
  write: writeDeploymentStorageSettings,
});
registerSettingsResource({
  path: '/web-app-routes',
  repository: publicRouteSettingsRepository,
  read: readWebAppRouteSettings,
  write: writeWebAppRouteSettings,
});
registerSettingsResource({
  path: '/public-routes',
  repository: publicRouteSettingsRepository,
  read: readPublicRouteSettings,
  write: writePublicRouteSettings,
});
registerSettingsResource({
  path: '/workflow-endpoint-auth',
  repository: workflowEndpointAuthSettingsRepository,
  read: readWorkflowEndpointAuthSettings,
  write: writeWorkflowEndpointAuthSettings,
});
registerSettingsResource({
  path: '/web-app-auth',
  repository: webAppAuthSettingsRepository,
  read: readWebAppAuthSettings,
  write: writeWebAppAuthSettings,
});
