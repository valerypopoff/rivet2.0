import { normalizeBasePath, normalizeBasePathFromAliases } from './normalize-base-path';

const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase = typeof window !== 'undefined' ? `${wsProtocol}//${window.location.host}` : 'ws://localhost';
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const RIVET_HOSTED_MODE = true;
export const RIVET_API_BASE_URL = '/api';
export let RIVET_EXECUTOR_WS_URL = `${wsBase}/ws/executor/internal`;
export let RIVET_REMOTE_DEBUGGER_DEFAULT_WS = `${wsBase}/ws/latest-debugger`;
export const RIVET_DEBUG_LOGS = viteEnv?.VITE_RIVET_DEBUG_LOGS === 'true';
export let RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  '/workflows',
);
export let RIVET_LATEST_WORKFLOWS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_LATEST_WORKFLOWS_BASE_PATH,
  '/workflows-latest',
);
export let RIVET_WEB_APPS_BASE_PATH = normalizeBasePathFromAliases(
  [
    viteEnv?.RIVET_PUBLISHED_APPS_BASE_PATH,
    viteEnv?.RIVET_WEB_APPS_BASE_PATH,
  ],
  '/apps',
);
export let RIVET_LATEST_WEB_APPS_BASE_PATH = normalizeBasePathFromAliases(
  [
    viteEnv?.RIVET_LATEST_APPS_BASE_PATH,
    viteEnv?.RIVET_LATEST_WEB_APPS_BASE_PATH,
  ],
  '/apps-latest',
);

type HostedRuntimeConfig = {
  executorWsUrl?: unknown;
  remoteDebuggerDefaultWs?: unknown;
  publishedWorkflowsBasePath?: unknown;
  latestWorkflowsBasePath?: unknown;
  publishedAppsBasePath?: unknown;
  latestAppsBasePath?: unknown;
};

type BrowserLocation = {
  host: string;
  protocol: string;
};

function applyString(value: unknown, currentValue: string): string {
  return typeof value === 'string' ? value : currentValue;
}

function getBrowserLocation(): BrowserLocation | undefined {
  return typeof window !== 'undefined' ? window.location : undefined;
}

export function normalizeRuntimeWebSocketUrl(value: string): string {
  const location = getBrowserLocation();
  if (location?.protocol !== 'https:') {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.protocol === 'ws:' && url.host === location.host) {
      url.protocol = 'wss:';
      return url.toString();
    }
  } catch {
    return value;
  }

  return value;
}

export function normalizeHostedRuntimeConfig(config: HostedRuntimeConfig): HostedRuntimeConfig {
  return {
    ...config,
    executorWsUrl: typeof config.executorWsUrl === 'string'
      ? normalizeRuntimeWebSocketUrl(config.executorWsUrl)
      : config.executorWsUrl,
    remoteDebuggerDefaultWs: typeof config.remoteDebuggerDefaultWs === 'string'
      ? normalizeRuntimeWebSocketUrl(config.remoteDebuggerDefaultWs)
      : config.remoteDebuggerDefaultWs,
  };
}

export function applyHostedRuntimeConfig(config: HostedRuntimeConfig): void {
  const normalizedConfig = normalizeHostedRuntimeConfig(config);

  RIVET_EXECUTOR_WS_URL = applyString(normalizedConfig.executorWsUrl, RIVET_EXECUTOR_WS_URL);
  RIVET_REMOTE_DEBUGGER_DEFAULT_WS = applyString(
    normalizedConfig.remoteDebuggerDefaultWs,
    RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
  );
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = normalizeBasePath(
    applyString(config.publishedWorkflowsBasePath, RIVET_PUBLISHED_WORKFLOWS_BASE_PATH),
    RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  );
  RIVET_LATEST_WORKFLOWS_BASE_PATH = normalizeBasePath(
    applyString(config.latestWorkflowsBasePath, RIVET_LATEST_WORKFLOWS_BASE_PATH),
    RIVET_LATEST_WORKFLOWS_BASE_PATH,
  );
  RIVET_WEB_APPS_BASE_PATH = normalizeBasePath(
    applyString(config.publishedAppsBasePath, RIVET_WEB_APPS_BASE_PATH),
    RIVET_WEB_APPS_BASE_PATH,
  );
  RIVET_LATEST_WEB_APPS_BASE_PATH = normalizeBasePath(
    applyString(config.latestAppsBasePath, RIVET_LATEST_WEB_APPS_BASE_PATH),
    RIVET_LATEST_WEB_APPS_BASE_PATH,
  );
}

export async function loadHostedRuntimeConfig(): Promise<void> {
  if (typeof fetch === 'undefined') {
    return;
  }

  const response = await fetch(`${RIVET_API_BASE_URL}/config`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load hosted runtime config: ${response.status}`);
  }

  applyHostedRuntimeConfig(await response.json() as HostedRuntimeConfig);
}

export function logHostedDebug(
  method: 'log' | 'info' | 'warn' | 'error' | 'debug',
  ...args: unknown[]
) {
  if (!RIVET_DEBUG_LOGS) {
    return;
  }

  console[method](...args);
}
