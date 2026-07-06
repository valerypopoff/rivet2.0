import type { Settings } from '../model/Settings.js';
import { DEFAULT_CHAT_NODE_TIMEOUT } from '../utils/defaults.js';

type ProcessSettingsFallbacks = Pick<
  Settings,
  | 'openAiApiKey'
  | 'openAiKey'
  | 'anthropicApiKey'
  | 'googleApiKey'
  | 'customAiApiKey'
  | 'openAiOrganization'
  | 'openAiEndpoint'
  | 'pluginEnv'
>;

export function resolveProcessSettings(
  settings: Settings = {},
  fallbacks: Partial<ProcessSettingsFallbacks> = {},
): Required<Settings> {
  const openAiApiKey = settings.openAiApiKey || settings.openAiKey || fallbacks.openAiApiKey || fallbacks.openAiKey || '';

  return {
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
