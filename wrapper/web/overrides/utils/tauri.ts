// Override for rivet/packages/app/src/utils/tauri.ts
// Adds isHostedMode(), routes getEnvVar() through API backend

import { type RivetPlugin, type Settings, type StringPluginConfigurationSpec } from '@valerypopoff/rivet2-core';
import { entries } from '../../../../rivet/packages/core/src/utils/typeSafety';
import type { EnvironmentProvider, PathPolicyProvider } from '../../../../rivet/packages/app/src/providers/ProvidersContext.js';
import { RIVET_API_BASE_URL, RIVET_HOSTED_MODE } from '../../../shared/hosted-env';
import { ENVIRONMENT_VARIABLES_CHANGED_CHANNEL } from '../../../shared/environment-variable-events';

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

      const { contents } = await response.json() as { contents: string };
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

      const data = await response.json() as { value?: unknown };
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

export async function fillMissingSettingsFromEnvironmentVariables(
  settings: Partial<Settings>,
  plugins: RivetPlugin[],
  optionsOrExtraEnvVarNames: string[] | { extraEnvVarNames?: string[]; environmentProvider?: EnvironmentProvider } = [],
) {
  const options = Array.isArray(optionsOrExtraEnvVarNames)
    ? { extraEnvVarNames: optionsOrExtraEnvVarNames }
    : optionsOrExtraEnvVarNames;
  const environmentProvider = options.environmentProvider ?? getDefaultEnvironmentProvider();
  const getProviderEnvVar = (name: string) => environmentProvider.getEnvVar(name);
  const resolveSetting = (value: string | undefined, envVarName: string) =>
    value ? Promise.resolve(value) : getProviderEnvVar(envVarName);
  const pluginEnvVarNames = new Set<string>();

  for (const plugin of plugins) {
    const stringConfigs = entries(plugin.configSpec ?? {}).filter(([, c]) => c.type === 'string') as [
      string,
      StringPluginConfigurationSpec,
    ][];
    for (const [configName, config] of stringConfigs) {
      if (config.pullEnvironmentVariable) {
        const envVarName =
          typeof config.pullEnvironmentVariable === 'string'
            ? config.pullEnvironmentVariable
            : config.pullEnvironmentVariable === true
              ? configName
              : undefined;
        if (envVarName) {
          pluginEnvVarNames.add(envVarName);
        }
      }
    }
  }

  for (const envVarName of (options.extraEnvVarNames ?? []).map((name) => name.trim()).filter(Boolean)) {
    pluginEnvVarNames.add(envVarName);
  }

  const [openAiKey, openAiOrganization, openAiEndpoint, pluginEnvEntries] = await Promise.all([
    resolveSetting(settings.openAiKey, 'OPENAI_API_KEY'),
    resolveSetting(settings.openAiOrganization, 'OPENAI_ORG_ID'),
    resolveSetting(settings.openAiEndpoint, 'OPENAI_ENDPOINT'),
    Promise.all(
      [...pluginEnvVarNames].map(async (envVarName) => [envVarName, await getProviderEnvVar(envVarName)] as const),
    ),
  ]);

  const fullSettings: Settings = {
    ...settings,
    openAiKey: openAiKey ?? '',
    openAiOrganization: openAiOrganization ?? '',
    openAiEndpoint: openAiEndpoint ?? '',
    pluginSettings: settings.pluginSettings,
    pluginEnv: {},
  };

  for (const [envVarName, envVarValue] of pluginEnvEntries) {
    if (envVarValue) {
      fullSettings.pluginEnv![envVarName] = envVarValue;
    }
  }

  return fullSettings;
}

export async function allowDataFileNeighbor(projectFilePath: string): Promise<void> {
  if (isHostedMode()) {
    return;
  }

  void projectFilePath;
}
