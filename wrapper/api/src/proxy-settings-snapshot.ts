import { createHash } from 'node:crypto';

import { getAppSettingsBackendKind } from './app-settings/settings-repository.js';
import {
  getLatestWebAppsBasePath,
  getLatestWorkflowsBasePath,
  getPublishedWebAppsBasePath,
  getPublishedWorkflowsBasePath,
  publicRouteSettingsRepository,
} from './public-route-settings.js';
import {
  readRuntimeLimitSettingsSync,
  runtimeLimitSettingsRepository,
} from './runtime-limit-settings.js';
import {
  readTrustedHostSettingsSync,
  trustedHostSettingsRepository,
} from './trusted-host-settings.js';

export type ProxySettingsSnapshot = {
  revision: string;
  backend: 'file' | 'postgres';
  publishedWorkflowsBasePath: string;
  latestWorkflowsBasePath: string;
  publishedAppsBasePath: string;
  latestAppsBasePath: string;
  proxyReadTimeoutSeconds: number;
  webAppActionRequestLimitBytes: number;
  trustedHostsCsv: string;
};

export function createProxySettingsSnapshot(): ProxySettingsSnapshot {
  const limits = readRuntimeLimitSettingsSync();
  const trustedHosts = readTrustedHostSettingsSync();
  const revisions = [
    publicRouteSettingsRepository.readSync().revision,
    runtimeLimitSettingsRepository.readSync().revision,
    trustedHostSettingsRepository.readSync().revision,
  ];
  return {
    revision: createHash('sha256').update(revisions.join(':')).digest('base64url'),
    backend: getAppSettingsBackendKind(),
    publishedWorkflowsBasePath: getPublishedWorkflowsBasePath(),
    latestWorkflowsBasePath: getLatestWorkflowsBasePath(),
    publishedAppsBasePath: getPublishedWebAppsBasePath(),
    latestAppsBasePath: getLatestWebAppsBasePath(),
    proxyReadTimeoutSeconds: limits.proxyReadTimeoutSeconds,
    webAppActionRequestLimitBytes: limits.webAppActionRequestLimitBytes,
    trustedHostsCsv: trustedHosts.trustedHosts.join(','),
  };
}
