// Override for packages/app/src/utils/tauri.ts
// Adds isHostedMode(), routes getEnvVar() through API backend

import type { RivetPlugin, RuntimeSettings, Settings } from '@valerypopoff/rivet2-core';
import { resolveEnvironmentSettings } from '../../../app/src/utils/resolveEnvironmentSettings';
import type { EnvironmentProvider, PathPolicyProvider } from '../../../app/src/providers/ProvidersContext.js';
import { RIVET_API_BASE_URL, RIVET_HOSTED_MODE } from '../../../studio-server-shared/hosted-env';
import { ENVIRONMENT_VARIABLES_CHANGED_CHANNEL } from '../../../studio-server-shared/environment-variable-events';

export function isInTauri(): boolean {
  return false;
}

export function isHostedMode(): boolean {
  return RIVET_HOSTED_MODE;
}

const cachedEnvVars = new Map<string, string>();
const pendingEnvVars = new Map<string, Promise<string | undefined>>();

export function invalidateHostedEnvironmentVariableCache(): void {
  cachedEnvVars.clear();
  pendingEnvVars.clear();
}

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  const environmentVariablesChannel = new BroadcastChannel(ENVIRONMENT_VARIABLES_CHANGED_CHANNEL);
  environmentVariablesChannel.addEventListener('message', () => {
    invalidateHostedEnvironmentVariableCache();
  });
}

export function getDefaultEnvironmentProvider(): EnvironmentProvider {
  return {
    getEnvVar,
  };
}

export function getDefaultPathPolicyProvider(): PathPolicyProvider {
  return {
    allowDataFileNeighbor,
    async readRelativeProjectFile(currentProjectPath, projectFilePath) {
      const response = await fetch(`${RIVET_API_BASE_URL}/native/read-relative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativeFrom: currentProjectPath,
          projectFilePath,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to read relative project file: ${response.status} ${response.statusText}`);
      }

      const { contents } = (await response.json()) as { contents: string };
      return contents;
    },
  };
}

export async function getEnvVar(name: string): Promise<string | undefined> {
  if (cachedEnvVars.has(name)) {
    return cachedEnvVars.get(name) || undefined;
  }

  if (isHostedMode()) {
    const pendingValue = pendingEnvVars.get(name);
    if (pendingValue) {
      return pendingValue;
    }

    const loadValue = (async () => {
      const response = await fetch(`${RIVET_API_BASE_URL}/config/env/${encodeURIComponent(name)}`);
      if (!response.ok) {
        return undefined;
      }

      const data = (await response.json()) as { value?: unknown };
      if (typeof data.value !== 'string') {
        return undefined;
      }

      const value = data.value;
      cachedEnvVars.set(name, value);
      return value || undefined;
    })().catch(() => undefined);

    pendingEnvVars.set(name, loadValue);

    try {
      return await loadValue;
    } finally {
      pendingEnvVars.delete(name);
    }
  }

  if (typeof process !== 'undefined') {
    return process.env[name];
  }

  return undefined;
}

export function fillMissingSettingsFromEnvironmentVariables(
  settings: Partial<Settings>,
  plugins: RivetPlugin[],
  options: string[] | { extraEnvVarNames?: string[]; environmentProvider?: EnvironmentProvider } = [],
): Promise<RuntimeSettings> {
  return resolveEnvironmentSettings(settings, plugins, getDefaultEnvironmentProvider(), options);
}

export async function allowDataFileNeighbor(projectFilePath: string): Promise<void> {
  if (isHostedMode()) {
    return;
  }

  void projectFilePath;
}
