import type { ChatV2Provider, ChatV2ProviderOptions } from './chatV2Types.js';
import { getCustomProviderApiContract, type CustomProviderApi } from './customProviderApi.js';
import { getChatV2ProviderCapabilities } from './chatV2ProviderRegistry.js';

export const LLM_CHAT_V2_PARALLEL_TOOL_CALLS_HELPER_MESSAGE =
  'Allows the model to request multiple tool calls in one round.';

export function supportsLLMChatV2ParallelToolCalls(provider: ChatV2Provider): boolean {
  return getChatV2ProviderCapabilities(provider).parallelToolCalls;
}

function mergeProviderOptions(
  providerOptions: ChatV2ProviderOptions | undefined,
  provider: ChatV2Provider,
  options: Record<string, unknown>,
): ChatV2ProviderOptions {
  return {
    ...providerOptions,
    [provider]: {
      ...(providerOptions?.[provider] ?? {}),
      ...options,
    },
  } as ChatV2ProviderOptions;
}

export function applyLLMChatV2ParallelToolCallProviderOptions(params: {
  provider: ChatV2Provider;
  useToolCalling: boolean | undefined;
  parallelToolCalls: boolean | undefined;
  customProviderApi?: CustomProviderApi | undefined;
  providerOptions: ChatV2ProviderOptions | undefined;
}): ChatV2ProviderOptions | undefined {
  const { provider, useToolCalling, parallelToolCalls, providerOptions } = params;

  if (!useToolCalling) {
    return providerOptions;
  }

  switch (provider) {
    case 'openai':
      return mergeProviderOptions(providerOptions, provider, {
        parallelToolCalls: !!parallelToolCalls,
      });

    case 'anthropic':
      return mergeProviderOptions(providerOptions, provider, {
        disableParallelToolUse: !parallelToolCalls,
      });

    case 'custom':
      if (getCustomProviderApiContract(params.customProviderApi).parallelToolCalls === 'openai-option') {
        return mergeProviderOptions(providerOptions, 'openai', {
          parallelToolCalls: !!parallelToolCalls,
        });
      }

      // OpenAI-compatible endpoints vary widely. Do not send an unsupported
      // field to existing/default Custom-provider graphs unless the user
      // explicitly opts in to requesting parallel calls.
      return parallelToolCalls
        ? mergeProviderOptions(providerOptions, provider, { parallel_tool_calls: true })
        : providerOptions;

    case 'google':
      return providerOptions;
  }
}
