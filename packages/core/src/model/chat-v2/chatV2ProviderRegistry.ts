import type { ChatV2Provider } from './chatV2Types.js';

/** Closed, provider-neutral capability table for the providers Rivet ships. */
export type ChatV2ProviderCapabilities = {
  builtInTools: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
};

const providerCapabilities: Record<ChatV2Provider, ChatV2ProviderCapabilities> = {
  openai: { builtInTools: true, parallelToolCalls: true, structuredOutput: true },
  anthropic: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
  google: { builtInTools: true, parallelToolCalls: false, structuredOutput: true },
  custom: { builtInTools: false, parallelToolCalls: true, structuredOutput: true },
};

export function getChatV2ProviderCapabilities(provider: ChatV2Provider): ChatV2ProviderCapabilities {
  return providerCapabilities[provider];
}
