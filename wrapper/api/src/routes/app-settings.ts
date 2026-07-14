import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { RuntimeLimitSettingsDraft } from '../../../shared/app-settings-types.js';
import {
  deploymentStorageSettingsRepository,
  readDeploymentStorageSettings,
  writeDeploymentStorageSettings,
} from '../deployment-storage-settings.js';
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
  trustedHostSettingsRepository,
  readTrustedHostSettings,
  writeTrustedHostSettings,
} from '../trusted-host-settings.js';
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
import {
  runRecordingsSettingsRepository,
  readRunRecordingsSettings,
  writeRunRecordingsSettings,
} from './workflows/recordings-config.js';

export { readNodeExecutorProxySettings, writeNodeExecutorProxySettings } from '../node-executor-proxy-settings.js';
export { readRunRecordingsSettings, writeRunRecordingsSettings } from './workflows/recordings-config.js';

export const appSettingsRouter = Router();

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

  const writeHandler: RequestHandler = async (req, res, next) => {
    try {
      const draft = options.normalizeDraft?.(req.body) ?? req.body;
      const settings = await options.write(draft, getExpectedRevision(req));
      await options.afterWrite?.();
      sendSettingsResponse(res, options.repository, settings);
    } catch (error) {
      next(error);
    }
  };

  appSettingsRouter.put(options.path, writeHandler);
  appSettingsRouter.patch(options.path, writeHandler);
}

function normalizeRuntimeLimitSettingsDraft(value: unknown): RuntimeLimitSettingsDraft {
  const raw = value && typeof value === 'object'
    ? value as RuntimeLimitSettingsDraft
    : {};
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
  path: '/trusted-hosts',
  repository: trustedHostSettingsRepository,
  read: readTrustedHostSettings,
  write: writeTrustedHostSettings,
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
