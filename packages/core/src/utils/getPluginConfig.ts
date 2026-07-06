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

  const configSpec = plugin?.configSpec?.[name];

  if (!configSpec) {
    return undefined;
  }

  const pluginSettings = settings.pluginSettings?.[plugin.id];
  if (pluginSettings) {
    const value = pluginSettings[name];
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

  if (envFallbackName && settings.pluginEnv?.[envFallbackName]) {
    return settings.pluginEnv[envFallbackName];
  }

  return undefined;
}
