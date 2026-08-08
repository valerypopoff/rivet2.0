import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { cleanHeaders, getInputOrData } from '../../utils/inputs.js';
import type { Inputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { ResolvedChatV2ProviderConfig } from './providerOptions.js';
import { resolveChatV2Credential } from './chatV2ProviderProfile.js';
import type {
  ChatV2ProviderOptions,
  ChatV2ToolChoice,
  ChatV2ToolSet,
  RunChatV2PipelineOptions,
} from './chatV2Types.js';
import { applyLLMChatV2ParallelToolCallProviderOptions } from './parallelToolCalls.js';
import { getCustomProviderApiContract } from './customProviderApi.js';
import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';

export type LLMChatV2GenerationParameters = Pick<
  RunChatV2PipelineOptions,
  'maxTokens' | 'temperature' | 'topP' | 'topK' | 'presencePenalty' | 'frequencyPenalty' | 'stopSequences' | 'seed'
>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
type JsonObject = { [key: string]: JsonValue | undefined };

export function resolveLLMChatV2Headers(data: LLMChatV2NodeData, inputs: Inputs): Record<string, string> | undefined {
  const resolvedHeaders =
    data.useHeadersInput && inputs['headers' as PortId] != null
      ? (coerceTypeOptional(inputs['headers' as PortId], 'object') as Record<string, string> | undefined)
      : Object.fromEntries((data.headers ?? []).map(({ key, value }) => [key, value]));

  const cleaned = cleanHeaders(resolvedHeaders ?? {});
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function resolveLLMChatV2ApiKey(
  data: LLMChatV2NodeData,
  inputs: Inputs,
  context: Pick<InternalProcessContext, 'getPluginConfig' | 'settings'>,
): string | undefined {
  return resolveChatV2Credential({
    provider: data.provider,
    context,
    apiKeySource: data.apiKeySource === 'input' ? 'input' : 'configured',
    inputs,
    customProgrammaticName: data.customProviderApiKeyProgrammaticName,
    customEnvironmentName: data.customProviderApiKeyEnvVarName,
  }).value;
}

function parseExtraProviderOptionsText(rawText: string): JsonObject | undefined {
  const raw = rawText.trim();

  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Extra provider options must be valid JSON: ${message}`);
  }

  return normalizeExtraProviderOptions(parsed);
}

function normalizeExtraProviderOptions(value: unknown): JsonObject | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return parseExtraProviderOptionsText(value);
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extra provider options must be a JSON object.');
  }

  return value as JsonObject;
}

export function resolveLLMChatV2ExtraProviderOptions(data: LLMChatV2NodeData, inputs: Inputs): JsonObject | undefined {
  if (!data.useExtraProviderOptionsInput) {
    return parseExtraProviderOptionsText(data.extraProviderOptions ?? '');
  }

  return normalizeExtraProviderOptions(coerceTypeOptional(inputs['extraProviderOptions' as PortId], 'object'));
}

function resolveProviderOptions(data: LLMChatV2NodeData, inputs: Inputs): ChatV2ProviderOptions | undefined {
  const providerOptions: ChatV2ProviderOptions = {};
  const extraProviderOptions = resolveLLMChatV2ExtraProviderOptions(data, inputs);
  const providerOptionsKey =
    data.provider === 'custom'
      ? getCustomProviderApiContract(data.customProviderApi).providerOptionsKey
      : data.provider;

  if (extraProviderOptions) {
    providerOptions[providerOptionsKey] = extraProviderOptions;
  }

  if (data.provider === 'openai') {
    const previousResponseId =
      data.useOpenAIPreviousResponseIdInput && inputs['previousResponseId' as PortId] != null
        ? coerceTypeOptional(inputs['previousResponseId' as PortId], 'string')
        : data.openAIPreviousResponseId;

    const openAIOptions = {
      ...(data.openAIReasoningEffort ? { reasoningEffort: data.openAIReasoningEffort } : {}),
      ...(data.openAIReasoningSummary ? { reasoningSummary: data.openAIReasoningSummary } : {}),
      ...(previousResponseId?.trim() ? { previousResponseId: previousResponseId.trim() } : {}),
    };

    if (Object.keys(openAIOptions).length > 0) {
      providerOptions.openai = {
        ...(providerOptions.openai ?? {}),
        ...openAIOptions,
      };
    }
  }

  if (data.provider === 'anthropic') {
    const thinkingBudget =
      data.useAnthropicThinkingBudgetInput && inputs['anthropicThinkingBudget' as PortId] != null
        ? coerceTypeOptional(inputs['anthropicThinkingBudget' as PortId], 'number')
        : data.anthropicThinkingBudget;

    const anthropicOptions = {
      ...(data.anthropicEffort ? { effort: data.anthropicEffort } : {}),
      ...(data.anthropicThinkingMode === 'enabled'
        ? {
            thinking: {
              type: 'enabled',
              ...(thinkingBudget != null ? { budgetTokens: thinkingBudget } : {}),
            },
          }
        : data.anthropicThinkingMode === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : data.anthropicThinkingMode === 'adaptive'
            ? { thinking: { type: 'adaptive' } }
            : {}),
    };

    if (Object.keys(anthropicOptions).length > 0) {
      providerOptions.anthropic = {
        ...(providerOptions.anthropic ?? {}),
        ...anthropicOptions,
      };
    }
  }

  if (data.provider === 'google') {
    const thinkingBudget =
      data.useGoogleThinkingBudgetInput && inputs['googleThinkingBudget' as PortId] != null
        ? coerceTypeOptional(inputs['googleThinkingBudget' as PortId], 'number')
        : data.googleThinkingBudget;

    const thinkingConfig = {
      ...(thinkingBudget != null ? { thinkingBudget } : {}),
      ...(data.googleThinkingLevel ? { thinkingLevel: data.googleThinkingLevel } : {}),
      ...(data.googleIncludeThoughts ? { includeThoughts: true } : {}),
    };
    const googleOptions = {
      ...(Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}),
    };

    if (Object.keys(googleOptions).length > 0) {
      providerOptions.google = {
        ...(providerOptions.google ?? {}),
        ...googleOptions,
      };
    }
  }

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

export function resolveLLMChatV2RuntimeProviderOptions(
  data: LLMChatV2NodeData,
  inputs: Inputs,
): ChatV2ProviderOptions | undefined {
  const providerOptions = applyLLMChatV2ParallelToolCallProviderOptions({
    provider: data.provider,
    useToolCalling: data.useToolCalling,
    parallelToolCalls: data.parallelToolCalls,
    customProviderApi: data.customProviderApi,
    providerOptions: resolveProviderOptions(data, inputs),
  });

  return providerOptions != null && Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

export function resolveLLMChatV2ToolChoice(data: LLMChatV2NodeData): ChatV2ToolChoice | undefined {
  if (!data.useToolCalling || !data.toolChoice) {
    return undefined;
  }

  if (data.toolChoice === 'function') {
    const toolName = data.toolChoiceFunction?.trim();

    if (!toolName) {
      throw new Error('Tool name is required when Tool choice is Specific tool.');
    }

    return {
      type: 'tool',
      toolName,
    } as ChatV2ToolChoice;
  }

  return data.toolChoice;
}

function normalizeStopSequences(stopSequences: string[] | undefined): string[] | undefined {
  const normalized = (stopSequences ?? []).filter((sequence) => sequence.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveStopSequences(data: LLMChatV2NodeData, inputs: Inputs): string[] | undefined {
  const stopSequences =
    data.useStopSequencesInput && inputs['stopSequences' as PortId] != null
      ? coerceTypeOptional(inputs['stopSequences' as PortId], 'string[]')
      : data.stopSequences;

  return normalizeStopSequences(stopSequences);
}

export function resolveLLMChatV2GenerationParameters(
  data: LLMChatV2NodeData,
  inputs: Inputs,
): LLMChatV2GenerationParameters {
  return {
    maxTokens: getInputOrData(data, inputs, 'maxTokens', 'number'),
    temperature: getInputOrData(data, inputs, 'temperature', 'number'),
    topP: getInputOrData(data, inputs, 'topP', 'number'),
    topK: getInputOrData(data, inputs, 'topK', 'number'),
    presencePenalty: getInputOrData(data, inputs, 'presencePenalty', 'number'),
    frequencyPenalty: getInputOrData(data, inputs, 'frequencyPenalty', 'number'),
    stopSequences: resolveStopSequences(data, inputs),
    seed: getInputOrData(data, inputs, 'seed', 'number'),
  };
}

export function resolveLLMChatV2BuiltInTools(
  data: LLMChatV2NodeData,
  context: Pick<InternalProcessContext, 'getPluginConfig' | 'settings'>,
  config: ResolvedChatV2ProviderConfig,
  apiKey: string | undefined,
): ChatV2ToolSet | undefined {
  switch (data.provider) {
    case 'openai': {
      if (!data.enableOpenAIWebSearch && !data.enableOpenAICodeInterpreter) {
        return undefined;
      }

      const provider = createOpenAI({
        apiKey: apiKey || context.settings.openAiApiKey || context.settings.openAiKey || undefined,
        organization: context.settings.openAiOrganization || undefined,
        baseURL: undefined,
        headers: config.headers,
      });
      const tools: ChatV2ToolSet = {};

      if (data.enableOpenAIWebSearch) {
        tools.openaiWebSearch = provider.tools.webSearch({
          searchContextSize: data.openAIWebSearchContextSize,
        });
      }

      if (data.enableOpenAICodeInterpreter) {
        tools.openaiCodeInterpreter = provider.tools.codeInterpreter();
      }

      return tools;
    }

    case 'google': {
      if (!data.enableGoogleSearchGrounding && !data.enableGoogleUrlContext) {
        return undefined;
      }

      const provider = createGoogleGenerativeAI({
        apiKey: apiKey || context.settings.googleApiKey || context.getPluginConfig('googleApiKey') || undefined,
        baseURL: undefined,
        headers: config.headers,
      });
      const tools: ChatV2ToolSet = {};

      if (data.enableGoogleSearchGrounding) {
        tools.googleSearch = provider.tools.googleSearch({});
      }

      if (data.enableGoogleUrlContext) {
        tools.googleUrlContext = provider.tools.urlContext({});
      }

      return tools;
    }

    case 'anthropic':
      return undefined;

    case 'custom':
      return undefined;
  }
}
