import { normalizeBasePath } from './normalize-base-path';

const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase = typeof window !== 'undefined' ? `${wsProtocol}//${window.location.host}` : 'ws://localhost';
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const RIVET_HOSTED_MODE = true;
export const RIVET_API_BASE_URL = '/api';
export const RIVET_EXECUTOR_WS_URL = `${wsBase}/ws/executor/internal`;
export const RIVET_REMOTE_DEBUGGER_DEFAULT_WS = `${wsBase}/ws/latest-debugger`;
export const RIVET_DEBUG_LOGS = viteEnv?.VITE_RIVET_DEBUG_LOGS === 'true';
export const RIVET_PUBLISHED_WORKFLOWS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  '/workflows',
);
export const RIVET_LATEST_WORKFLOWS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_LATEST_WORKFLOWS_BASE_PATH,
  '/workflows-latest',
);
export const RIVET_WEB_APPS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_WEB_APPS_BASE_PATH,
  '/apps',
);
export const RIVET_LATEST_WEB_APPS_BASE_PATH = normalizeBasePath(
  viteEnv?.RIVET_LATEST_WEB_APPS_BASE_PATH,
  '/apps-latest',
);

export function logHostedDebug(
  method: 'log' | 'info' | 'warn' | 'error' | 'debug',
  ...args: unknown[]
) {
  if (!RIVET_DEBUG_LOGS) {
    return;
  }

  console[method](...args);
}
