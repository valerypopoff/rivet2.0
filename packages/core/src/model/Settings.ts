export interface Settings<PluginSettings = Record<string, Record<string, unknown>>> {
  recordingPlaybackLatency?: number;

  /** Apply predefined colors to supported newly added node types in the editor UI. */
  defaultNodeColors?: boolean;

  /** Automatically open the node settings panel after creating a new node in the editor UI. */
  openNodeSettingsOnCreate?: boolean;

  /** Configurable settings that a plugin can get and set. Settings can be available in the settings modal and are stored  */
  pluginSettings?: PluginSettings;

  /** A plugin can request environment variables to configure itself. Those can be populated here. */
  pluginEnv?: {
    [key: string]: string | undefined;
  };

  // Shared LLM provider settings. Legacy OpenAI-backed nodes still consume the OpenAI fields directly.
  openAiApiKey?: string;
  openAiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  customAiApiKey?: string;
  openAiOrganization?: string;
  openAiEndpoint?: string;

  /** Timeout in milliseconds before retrying a chat node call. */
  chatNodeTimeout?: number;

  chatNodeHeaders?: Record<string, string>;

  throttleChatNode?: number;
}
