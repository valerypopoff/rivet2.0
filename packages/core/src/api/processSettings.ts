import type { RuntimeSettings, Settings } from '../model/Settings.js';
import { DEFAULT_CHAT_NODE_TIMEOUT } from '../utils/defaults.js';

function definedRuntimeSettings(settings: Settings): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined && value !== ''),
  );
}

export function resolveProcessSettings(settings?: Settings, fallbacks?: Partial<RuntimeSettings>): RuntimeSettings;
export function resolveProcessSettings<T extends Record<string, unknown>>(
  settings?: Settings & T,
  fallbacks?: Partial<RuntimeSettings>,
): RuntimeSettings & T;
export function resolveProcessSettings(settings: Settings = {}, fallbacks: Partial<RuntimeSettings> = {}): RuntimeSettings {
  const openAiApiKey = settings.openAiApiKey || settings.openAiKey || fallbacks.openAiApiKey || fallbacks.openAiKey || '';

  return {
    ...fallbacks,
    ...definedRuntimeSettings(settings),
    openAiApiKey,
    openAiKey: openAiApiKey,
    anthropicApiKey: settings.anthropicApiKey || fallbacks.anthropicApiKey || '',
    googleApiKey: settings.googleApiKey || fallbacks.googleApiKey || '',
    customAiApiKey: settings.customAiApiKey || fallbacks.customAiApiKey || '',
    openAiOrganization: settings.openAiOrganization ?? fallbacks.openAiOrganization ?? '',
    openAiEndpoint: settings.openAiEndpoint ?? fallbacks.openAiEndpoint ?? '',
    pluginEnv: settings.pluginEnv ?? fallbacks.pluginEnv ?? {},
    pluginSettings: settings.pluginSettings ?? {},
    recordingPlaybackLatency: settings.recordingPlaybackLatency ?? 1000,
    defaultNodeColors: settings.defaultNodeColors ?? false,
    openNodeSettingsOnCreate: settings.openNodeSettingsOnCreate ?? true,
    chatNodeHeaders: settings.chatNodeHeaders ?? {},
    chatNodeTimeout: settings.chatNodeTimeout ?? DEFAULT_CHAT_NODE_TIMEOUT,
    throttleChatNode: settings.throttleChatNode ?? 100,
  };
}
