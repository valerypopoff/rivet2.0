import type { RivetPlugin, RuntimeSettings, Settings } from '@valerypopoff/rivet2-core';
import { resolveEnvironmentSettings } from './resolveEnvironmentSettings';
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

export function fillMissingSettingsFromEnvironmentVariables(
  settings: Partial<Settings>,
  plugins: RivetPlugin[],
  options: string[] | { extraEnvVarNames?: string[]; environmentProvider?: EnvironmentProvider } = [],
): Promise<RuntimeSettings> {
  return resolveEnvironmentSettings(settings, plugins, getDefaultEnvironmentProvider(), options);
}

export async function allowDataFileNeighbor(projectFilePath: string): Promise<void> {
  await invokeNative('allow_data_file_scope', { projectFilePath });
}
