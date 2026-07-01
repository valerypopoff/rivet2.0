import fs from 'node:fs/promises';
import path from 'node:path';

export const NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH = path.join('settings', 'node-executor-proxy.json');

const proxyEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

const settingsEnvPairs = [
  ['HTTP_PROXY', 'http_proxy', 'httpProxy'],
  ['HTTPS_PROXY', 'https_proxy', 'httpsProxy'],
  ['NO_PROXY', 'no_proxy', 'noProxy'],
];

const dispatcherSignatureEnvKeys = [
  ...proxyEnvKeys,
  'NO_PROXY',
  'no_proxy',
];

let lastDispatcherSignature = '';
let lastSettingsFileContent = undefined;
let hasObservedSettingsFile = false;
let settingsPollTimer = undefined;
let undiciModulePromise = undefined;

function loadUndici() {
  undiciModulePromise ??= import('undici');
  return undiciModulePromise;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasProxyEnvValue() {
  return proxyEnvKeys.some((key) => Boolean(process.env[key]?.trim()));
}

function createDispatcherSignature() {
  return dispatcherSignatureEnvKeys
    .map((key) => `${key}=${process.env[key] ?? ''}`)
    .join('\n');
}

function applyProxySettingEnvPair(upperKey, lowerKey, value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    delete process.env[upperKey];
    delete process.env[lowerKey];
    return;
  }

  process.env[upperKey] = normalized;
  process.env[lowerKey] = normalized;
}

function clearNodeExecutorProxyEnvironment() {
  applyNodeExecutorProxySettingsToEnv({});
}

export function normalizeNodeExecutorProxySettings(value) {
  const raw = value && typeof value === 'object' ? value : {};

  return {
    httpProxy: normalizeString(raw.httpProxy ?? raw.HTTP_PROXY),
    httpsProxy: normalizeString(raw.httpsProxy ?? raw.HTTPS_PROXY),
    noProxy: normalizeString(raw.noProxy ?? raw.NO_PROXY),
  };
}

export function getNodeExecutorProxySettingsPath() {
  const explicitPath = process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const appDataRoot = process.env.RIVET_APP_DATA_ROOT?.trim();
  if (appDataRoot) {
    return path.join(appDataRoot, NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH);
  }

  const home = process.env.HOME?.trim();
  if (!home) {
    return '';
  }

  return path.join(home, '.local', 'share', 'com.valerypopoff.rivet2', NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH);
}

async function readNodeExecutorProxySettings(settingsPath = getNodeExecutorProxySettingsPath()) {
  if (!settingsPath) {
    return null;
  }

  let settingsText;
  try {
    settingsText = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  return normalizeNodeExecutorProxySettings(JSON.parse(settingsText));
}

export function applyNodeExecutorProxySettingsToEnv(settings) {
  const normalized = normalizeNodeExecutorProxySettings(settings);
  for (const [upperKey, lowerKey, fieldName] of settingsEnvPairs) {
    applyProxySettingEnvPair(upperKey, lowerKey, normalized[fieldName]);
  }
  applyProxySettingEnvPair('ALL_PROXY', 'all_proxy', '');
}

async function configureProxyDispatcherFromEnv(options = {}) {
  const signature = createDispatcherSignature();
  if (!options.force && signature === lastDispatcherSignature) {
    return false;
  }

  lastDispatcherSignature = signature;
  const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
  setGlobalDispatcher(hasProxyEnvValue() ? new EnvHttpProxyAgent() : new Agent());
  return true;
}

export async function loadAndApplyNodeExecutorProxySettings(options = {}) {
  if (options.clearBeforeLoad) {
    clearNodeExecutorProxyEnvironment();
  }

  let settings;
  try {
    settings = await readNodeExecutorProxySettings();
  } catch (error) {
    console.error('[node-executor-proxy] Failed to read proxy settings:', error);
    return false;
  }

  if (!settings) {
    if (options.clearWhenMissing) {
      applyNodeExecutorProxySettingsToEnv({});
      if (options.configureDispatcher !== false) {
        await configureProxyDispatcherFromEnv({ force: true });
      }
      return true;
    }

    return false;
  }

  applyNodeExecutorProxySettingsToEnv(settings);
  if (options.configureDispatcher !== false) {
    await configureProxyDispatcherFromEnv({ force: true });
  }

  if (!options.quiet) {
    console.log('[node-executor-proxy] Applied saved Node executor proxy settings.');
  }

  return true;
}

function normalizePollIntervalMs(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 5000;
}

async function readSettingsFileContent(settingsPath) {
  try {
    return await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export function setupNodeExecutorProxySettingsPolling() {
  const settingsPath = getNodeExecutorProxySettingsPath();
  if (!settingsPath || settingsPollTimer) {
    return () => {};
  }

  const intervalMs = normalizePollIntervalMs(process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_POLL_INTERVAL_MS);

  const poll = async () => {
    let content;
    try {
      content = await readSettingsFileContent(settingsPath);
    } catch (error) {
      console.error('[node-executor-proxy] Failed to poll proxy settings:', error);
      return;
    }

    if (content === lastSettingsFileContent) {
      return;
    }

    if (content == null && !hasObservedSettingsFile) {
      lastSettingsFileContent = null;
      return;
    }

    lastSettingsFileContent = content;
    hasObservedSettingsFile = content != null;
    await loadAndApplyNodeExecutorProxySettings({
      clearBeforeLoad: true,
      clearWhenMissing: content == null,
      quiet: true,
    });
  };

  settingsPollTimer = setInterval(() => {
    void poll();
  }, intervalMs);
  settingsPollTimer.unref?.();

  void poll();

  return () => {
    if (settingsPollTimer) {
      clearInterval(settingsPollTimer);
      settingsPollTimer = undefined;
    }
  };
}
