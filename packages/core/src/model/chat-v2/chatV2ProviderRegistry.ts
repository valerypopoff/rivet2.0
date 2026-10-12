import type { ChatV2Provider } from './chatV2ProviderTypes.js';
import { CHAT_V2_DEFAULT_CREDENTIAL_NAMES } from './chatV2CredentialNames.js';

/** Closed, provider-neutral capability table for the providers Rivet ships. */
export type ChatV2ProviderCapabilities = {
  builtInTools: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
};

/** Adapter metadata, not a promise about every model served by that adapter.
 * SDKs, credential resolution and provider-native options have separate owners. */
export const chatV2ProviderDescriptors = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5',
    catalog: 'registry',
    credentialNames: CHAT_V2_DEFAULT_CREDENTIAL_NAMES.openai,
    capabilities: { builtInTools: true, parallelToolCalls: true, structuredOutput: true },
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    catalog: 'registry',
    credentialNames: CHAT_V2_DEFAULT_CREDENTIAL_NAMES.anthropic,
    capabilities: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
  },
  google: {
    label: 'Google',
    defaultModel: 'gemini-2.5-flash',
    catalog: 'registry',
    credentialNames: CHAT_V2_DEFAULT_CREDENTIAL_NAMES.google,
    capabilities: { builtInTools: true, parallelToolCalls: false, structuredOutput: true },
  },
  openrouter: {
    label: 'OpenRouter',
    defaultModel: 'openrouter/auto',
    catalog: [{ value: 'openrouter/auto', label: 'OpenRouter Auto' }],
    credentialNames: CHAT_V2_DEFAULT_CREDENTIAL_NAMES.openrouter,
    capabilities: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
  },
  custom: {
    label: 'Custom provider',
    defaultModel: 'model-id',
    catalog: 'registry',
    capabilities: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
  },
} as const satisfies Record<
  ChatV2Provider,
  {
    label: string;
    defaultModel: string;
    catalog: 'registry' | ReadonlyArray<{ value: string; label: string }>;
    credentialNames?: { programmaticName: string; environmentVariableName: string };
    capabilities: ChatV2ProviderCapabilities;
  }
>;

export const chatV2ProviderOptions = (Object.keys(chatV2ProviderDescriptors) as ChatV2Provider[]).map((value) => ({
  value,
  label: chatV2ProviderDescriptors[value].label,
}));

export function isChatV2Provider(value: string): value is ChatV2Provider {
  return Object.hasOwn(chatV2ProviderDescriptors, value);
}

export function getChatV2ProviderCapabilities(provider: ChatV2Provider): ChatV2ProviderCapabilities {
  return chatV2ProviderDescriptors[provider].capabilities;
}
