import {
  resolveProcessSettings,
  type RivetPlugin,
  type RuntimeSettings,
  type Settings,
  type StringPluginConfigurationSpec,
} from '@valerypopoff/rivet2-core';
import { entries } from './typeSafety';
import { invokeNative, isInTauri as detectTauri } from './platform/core.js';
import type { EnvironmentProvider, PathPolicyProvider } from '../providers/ProvidersContext.js';

export function isInTauri(): boolean {
  return detectTauri();
}

const cachedEnvVars = new Map<string, string>();
const pendingEnvVars = new Map<string, Promise<string>>();

export function getDefaultEnvironmentProvider(): EnvironmentProvider {
  return {
    getEnvVar,
  };
}

export function getDefaultPathPolicyProvider(): PathPolicyProvider {
  return {
    allowDataFileNeighbor,
    async readRelativeProjectFile(currentProjectPath, projectFilePath) {
      return await invokeNative<string>('read_relative_project_file', {
        relativeFrom: currentProjectPath,
        projectFilePath,
      });
    },
  };
}

export async function getEnvVar(name: string): Promise<string | undefined> {
  if (isInTauri()) {
    if (cachedEnvVars.has(name)) {
      return cachedEnvVars.get(name);
    }

    const pendingValue = pendingEnvVars.get(name);
    if (pendingValue) {
      return pendingValue;
    }

    const loadValue = invokeNative<string>('get_environment_variable', { name }).then((value) => {
      cachedEnvVars.set(name, value);
      return value;
    });

    pendingEnvVars.set(name, loadValue);

    try {
      return await loadValue;
    } finally {
      pendingEnvVars.delete(name);
    }
  } else {
    if (typeof process !== 'undefined') {
      return process.env[name];
    }

    return undefined;
  }
}

export async function fillMissingSettingsFromEnvironmentVariables(
  settings: Partial<Settings>,
  plugins: RivetPlugin[],
  optionsOrExtraEnvVarNames: string[] | { extraEnvVarNames?: string[]; environmentProvider?: EnvironmentProvider } = [],
): Promise<RuntimeSettings> {
  const options = Array.isArray(optionsOrExtraEnvVarNames)
    ? { extraEnvVarNames: optionsOrExtraEnvVarNames }
    : optionsOrExtraEnvVarNames;
  const environmentProvider = options.environmentProvider ?? getDefaultEnvironmentProvider();
  const getProviderEnvVar = (name: string) => environmentProvider.getEnvVar(name);
  const resolveSetting = (value: string | undefined, envVarName: string) =>
    value ? Promise.resolve(value) : getProviderEnvVar(envVarName);
  const resolveSettingFromAnyEnv = async (value: string | undefined, envVarNames: string[]) => {
    if (value) {
      return value;
    }

    for (const envVarName of envVarNames) {
      const envValue = await getProviderEnvVar(envVarName);
      if (envValue) {
        return envValue;
      }
    }

    return undefined;
  };
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

  const [
    openAiApiKey,
    anthropicApiKey,
    googleApiKey,
    customAiApiKey,
    openAiOrganization,
    pluginEnvEntries,
  ] = await Promise.all([
      resolveSetting(settings.openAiApiKey || settings.openAiKey, 'OPENAI_API_KEY'),
      resolveSetting(settings.anthropicApiKey, 'ANTHROPIC_API_KEY'),
      resolveSetting(settings.googleApiKey, 'GOOGLE_GENERATIVE_AI_API_KEY'),
      resolveSettingFromAnyEnv(settings.customAiApiKey, ['CUSTOM_PROVIDER_API_KEY', 'CUSTOM_AI_API_KEY']),
      resolveSetting(settings.openAiOrganization, 'OPENAI_ORG_ID'),
      Promise.all(
        [...pluginEnvVarNames].map(async (envVarName) => [envVarName, await getProviderEnvVar(envVarName)] as const),
      ),
    ]);
  const fullSettings: Settings = {
    ...settings,
    openAiApiKey: openAiApiKey ?? '',
    openAiKey: openAiApiKey ?? '',
    anthropicApiKey: anthropicApiKey ?? '',
    googleApiKey: googleApiKey ?? '',
    customAiApiKey: customAiApiKey ?? '',
    openAiOrganization: openAiOrganization ?? '',
    openAiEndpoint: settings.openAiEndpoint ?? '',
    pluginSettings: settings.pluginSettings,
    pluginEnv: {},
  };

  for (const [envVarName, envVarValue] of pluginEnvEntries) {
    if (envVarValue) {
      fullSettings.pluginEnv![envVarName] = envVarValue;
    }
  }

  return resolveProcessSettings(fullSettings);
}

export async function allowDataFileNeighbor(projectFilePath: string): Promise<void> {
  await invokeNative('allow_data_file_scope', { projectFilePath });
}
