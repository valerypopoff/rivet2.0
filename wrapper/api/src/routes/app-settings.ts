import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  NodeExecutorProxySettings,
  NodeExecutorProxySettingsDraft,
} from '../../../shared/app-settings-types.js';
import { getAppDataRoot } from '../security.js';
import { badRequest } from '../utils/httpError.js';

export const appSettingsRouter = Router();

const NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH = path.join('settings', 'node-executor-proxy.json');
const MAX_PROXY_URL_LENGTH = 2048;
const MAX_NO_PROXY_LENGTH = 4096;

type NodeExecutorProxySettingsReloader = () => Promise<unknown> | unknown;

type NodeExecutorProxySettingsGlobal = typeof globalThis & {
  __rivetReloadNodeExecutorProxySettings?: NodeExecutorProxySettingsReloader;
};

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rejectControlCharacters(value: string, fieldLabel: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw badRequest(`${fieldLabel} must be a single-line value`);
  }
}

function normalizeProxyUrl(value: unknown, fieldLabel: string): string {
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

function normalizeNoProxy(value: unknown): string {
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
    httpProxy: normalizeProxyUrl(raw.httpProxy, 'HTTP_PROXY'),
    httpsProxy: normalizeProxyUrl(raw.httpsProxy, 'HTTPS_PROXY'),
    noProxy: normalizeNoProxy(raw.noProxy),
  };
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
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });

  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify({
    version: 1,
    httpProxy: saved.httpProxy,
    httpsProxy: saved.httpsProxy,
    noProxy: saved.noProxy,
    updatedAt: saved.updatedAt,
  }, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, settingsPath);

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
