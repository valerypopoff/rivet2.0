import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
  RunRecordingsSettings,
  RunRecordingsSettingsDraft,
  RuntimeLimitSettingsDraft,
  WorkflowEndpointAuthSettingsDraft,
} from '../../../shared/app-settings-types.js';
import { readDeploymentStorageSettings, writeDeploymentStorageSettings } from '../deployment-storage-settings.js';
import {
  readExecutorUrlOverrideSettings,
  writeExecutorUrlOverrideSettings,
} from '../executor-url-override-settings.js';
import { getAppDataRoot } from '../security.js';
import { badRequest } from '../utils/httpError.js';
import {
  readPublicRouteSettings,
  readWebAppRouteSettings,
  writePublicRouteSettings,
  writeWebAppRouteSettings,
} from '../public-route-settings.js';
import { writePrivateJsonSettingsFile } from '../settings-file-writer.js';
import { readRuntimeLimitSettings, writeRuntimeLimitSettings } from '../runtime-limit-settings.js';
import { readWebAppAuthSettings, writeWebAppAuthSettings } from '../web-app-auth-settings.js';
import {
  readWorkflowEndpointAuthSettings,
  writeWorkflowEndpointAuthSettings,
} from '../workflow-endpoint-auth-settings.js';
import {
  DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS,
  getRunRecordingsSettingsPath,
  normalizeWorkflowRecordingLimitSettings,
} from './workflows/recordings-config.js';

export const appSettingsRouter = Router();

const NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH = path.join('settings', 'node-executor-proxy.json');
const MAX_PROXY_URL_LENGTH = 2048;
const MAX_NO_PROXY_LENGTH = 4096;
const MAX_RECORDING_SETTING_VALUE = 1_000_000;

type NodeExecutorProxySettingsReloader = () => Promise<unknown> | unknown;

type NodeExecutorProxySettingsGlobal = typeof globalThis & {
  __rivetReloadNodeExecutorProxySettings?: NodeExecutorProxySettingsReloader;
};

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPresent(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControlCharacters(value: string, fieldLabel: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }
}

function normalizeProxyUrl(value: unknown, fieldLabel: string, present = true): string {
  if (present && typeof value !== 'undefined' && typeof value !== 'string') {
    throw badRequest(`${fieldLabel} must be a string`);
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length > MAX_PROXY_URL_LENGTH) {
    throw badRequest(`${fieldLabel} is too long`);
  }

  rejectControlCharacters(normalized, fieldLabel);

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw badRequest(`${fieldLabel} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`${fieldLabel} must use http or https`);
  }

  return normalized;
}

function normalizeNoProxy(value: unknown, present = true): string {
  if (present && typeof value !== 'undefined' && typeof value !== 'string') {
    throw badRequest('NO_PROXY must be a string');
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length > MAX_NO_PROXY_LENGTH) {
    throw badRequest('NO_PROXY is too long');
  }

  rejectControlCharacters(normalized, 'NO_PROXY');
  return normalized;
}

function normalizeNodeExecutorProxySettingsDraft(value: unknown): Omit<NodeExecutorProxySettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object'
    ? value as NodeExecutorProxySettingsDraft
    : {};

  return {
    httpProxy: normalizeProxyUrl(raw.httpProxy, 'HTTP_PROXY', isPresent(raw, 'httpProxy')),
    httpsProxy: normalizeProxyUrl(raw.httpsProxy, 'HTTPS_PROXY', isPresent(raw, 'httpsProxy')),
    noProxy: normalizeNoProxy(raw.noProxy, isPresent(raw, 'noProxy')),
  };
}

function normalizeNonNegativeInteger(value: unknown, fieldLabel: string): number {
  if (value === '') {
    throw badRequest(`${fieldLabel} is required`);
  }

  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`${fieldLabel} must be a non-negative whole number`);
  }

  if (parsed > MAX_RECORDING_SETTING_VALUE) {
    throw badRequest(`${fieldLabel} is too large`);
  }

  return parsed;
}

function normalizeRunRecordingsSettingsDraft(value: unknown): Omit<RunRecordingsSettings, 'source' | 'updatedAt'> {
  const raw = value && typeof value === 'object'
    ? value as RunRecordingsSettingsDraft
    : {};

  return {
    maxPendingWrites: normalizeNonNegativeInteger(raw.maxPendingWrites, 'Queued recording writes'),
    maxRunsPerEndpoint: normalizeNonNegativeInteger(raw.maxRunsPerEndpoint, 'Runs kept per workflow endpoint'),
    retentionDays: normalizeNonNegativeInteger(raw.retentionDays, 'Days to keep recordings'),
  };
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
    'dockerWaitTimeoutSeconds',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      draft[key] = raw[key];
    }
  }

  return draft;
}

function getNodeExecutorProxySettingsPath(): string {
  return path.join(
    path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot()),
    NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH,
  );
}

export async function readNodeExecutorProxySettings(): Promise<NodeExecutorProxySettings> {
  const settingsPath = getNodeExecutorProxySettingsPath();

  try {
    const settingsText = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(settingsText) as unknown;
    const settings = normalizeNodeExecutorProxySettingsDraft(parsed);
    const raw = parsed && typeof parsed === 'object' ? parsed as { updatedAt?: unknown } : {};

    return {
      ...settings,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      source: 'app-settings',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        httpProxy: '',
        httpsProxy: '',
        noProxy: '',
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeNodeExecutorProxySettings(draft: unknown): Promise<NodeExecutorProxySettings> {
  const settings = normalizeNodeExecutorProxySettingsDraft(draft);
  const saved: NodeExecutorProxySettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  const settingsPath = getNodeExecutorProxySettingsPath();
  await writePrivateJsonSettingsFile(settingsPath, {
    version: 1,
    httpProxy: saved.httpProxy,
    httpsProxy: saved.httpsProxy,
    noProxy: saved.noProxy,
    updatedAt: saved.updatedAt,
  });

  return saved;
}

export async function readRunRecordingsSettings(): Promise<RunRecordingsSettings> {
  const settingsPath = getRunRecordingsSettingsPath();

  try {
    const settingsText = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(settingsText) as unknown;
    const settings = normalizeWorkflowRecordingLimitSettings(parsed);
    const raw = parsed && typeof parsed === 'object' ? parsed as { updatedAt?: unknown } : {};

    return {
      ...settings,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      source: 'app-settings',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_WORKFLOW_RECORDING_LIMIT_SETTINGS,
        updatedAt: null,
        source: 'default',
      };
    }

    throw error;
  }
}

export async function writeRunRecordingsSettings(draft: unknown): Promise<RunRecordingsSettings> {
  const settings = normalizeRunRecordingsSettingsDraft(draft);
  const saved: RunRecordingsSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  const settingsPath = getRunRecordingsSettingsPath();
  await writePrivateJsonSettingsFile(settingsPath, {
    version: 1,
    maxPendingWrites: saved.maxPendingWrites,
    maxRunsPerEndpoint: saved.maxRunsPerEndpoint,
    retentionDays: saved.retentionDays,
    updatedAt: saved.updatedAt,
  });

  return saved;
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

appSettingsRouter.get('/node-executor-proxy', async (_req, res, next) => {
  try {
    res.json(await readNodeExecutorProxySettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/node-executor-proxy', async (req, res, next) => {
  try {
    const settings = await writeNodeExecutorProxySettings(req.body);
    await reloadNodeExecutorProxySettingsInCurrentProcess();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/executor-url-overrides', async (_req, res, next) => {
  try {
    res.json(await readExecutorUrlOverrideSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/executor-url-overrides', async (req, res, next) => {
  try {
    res.json(await writeExecutorUrlOverrideSettings(req.body));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/run-recordings', async (_req, res, next) => {
  try {
    res.json(await readRunRecordingsSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/run-recordings', async (req, res, next) => {
  try {
    res.json(await writeRunRecordingsSettings(req.body));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/runtime-limits', async (_req, res, next) => {
  try {
    res.json(await readRuntimeLimitSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/runtime-limits', async (req, res, next) => {
  try {
    res.json(await writeRuntimeLimitSettings(normalizeRuntimeLimitSettingsDraft(req.body)));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/deployment-storage', async (_req, res, next) => {
  try {
    res.json(await readDeploymentStorageSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/deployment-storage', async (req, res, next) => {
  try {
    res.json(await writeDeploymentStorageSettings(req.body));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/web-app-routes', async (_req, res, next) => {
  try {
    res.json(await readWebAppRouteSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/web-app-routes', async (req, res, next) => {
  try {
    res.json(await writeWebAppRouteSettings(req.body));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/public-routes', async (_req, res, next) => {
  try {
    res.json(await readPublicRouteSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/public-routes', async (req, res, next) => {
  try {
    res.json(await writePublicRouteSettings(req.body));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/workflow-endpoint-auth', async (_req, res, next) => {
  try {
    res.json(await readWorkflowEndpointAuthSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/workflow-endpoint-auth', async (req, res, next) => {
  try {
    res.json(await writeWorkflowEndpointAuthSettings(req.body as WorkflowEndpointAuthSettingsDraft));
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.get('/web-app-auth', async (_req, res, next) => {
  try {
    res.json(await readWebAppAuthSettings());
  } catch (error) {
    next(error);
  }
});

appSettingsRouter.put('/web-app-auth', async (req, res, next) => {
  try {
    res.json(await writeWebAppAuthSettings(req.body));
  } catch (error) {
    next(error);
  }
});
