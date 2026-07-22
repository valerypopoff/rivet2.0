import type { RivetPlugin, Settings, StringPluginConfigurationSpec } from '../index.js';

function getSharedLlmPluginConfig(plugin: RivetPlugin, settings: Settings, name: string) {
  if (plugin.id === 'anthropic' && name === 'anthropicApiKey') {
    return settings.anthropicApiKey;
  }

  if (plugin.id === 'google' && name === 'googleApiKey') {
    return settings.googleApiKey;
  }

  return undefined;
}

export function getPluginConfig(plugin: RivetPlugin | undefined, settings: Settings, name: string) {
  if (!plugin) {
    return undefined;
  }

  const configSpec = readOwnProperty(plugin.configSpec, name);

  if (!configSpec) {
    return undefined;
  }

  const pluginSettings = readOwnProperty(settings.pluginSettings, plugin.id);
  if (pluginSettings && typeof pluginSettings === 'object' && !Array.isArray(pluginSettings)) {
    const value = readOwnProperty(pluginSettings, name);
    if (value && typeof value === 'string') {
      return value;
    }
  }

  const sharedLlmValue = getSharedLlmPluginConfig(plugin, settings, name);
  if (sharedLlmValue) {
    return sharedLlmValue;
  }

  const envFallback = (configSpec as StringPluginConfigurationSpec).pullEnvironmentVariable;
  const envFallbackName = envFallback === true ? name : envFallback;

  const envValue = envFallbackName ? readOwnProperty(settings.pluginEnv, envFallbackName) : undefined;
  if (typeof envValue === 'string' && envValue) {
    return envValue;
  }

  return undefined;
}

function readOwnProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}
