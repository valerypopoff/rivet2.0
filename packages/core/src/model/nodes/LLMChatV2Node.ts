import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeRunActivityDescriptor, type NodeUIData } from '../NodeImpl.js';
import type { ChatV2CallFinishedEvent, InternalProcessContext } from '../ProcessContext.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import { getCommonChatV2Inputs, getCommonChatV2Outputs } from '../chat-v2/chatV2Shared.js';
import { getLLMChatV2Editors } from '../chat-v2/llmChatV2NodeEditors.js';
import {
  createLLMChatV2NodeData,
  shouldIncludeLLMChatV2ToolCalls,
  type LLMChatV2Node,
} from '../chat-v2/llmChatV2NodeData.js';
import { isLLMChatV2StructuredResponseFormat } from '../chat-v2/chatV2FeatureCompatibility.js';
import { getChatV2ModelInfo } from '../chat-v2/modelRegistry.js';
import { LLMInvocationJournal } from '../chat-v2/llmInvocationJournal.js';
import { executeLLMInvocation } from '../chat-v2/llmInvocationCoordinator.js';
import { projectLLMInvocationResult } from '../chat-v2/llmInvocationResultProjector.js';
import { isChatV2PipelineProviderFailureResult } from '../chat-v2/chatV2Pipeline.js';
import {
  shouldOutputChatV2RequestBody,
  shouldOutputChatV2ResponseBody,
} from '../chat-v2/chatV2Types.js';
import {
  buildLLMChatV2EditorCacheKey,
  resolveLLMChatV2RuntimeConfig,
  resolveLLMChatV2RuntimeProviderOptions,
} from '../chat-v2/llmChatV2NodeRuntime.js';
import { projectLLMChatV2EditorCacheHit, writeLLMChatV2EditorCache } from '../chat-v2/llmChatV2CacheBoundary.js';
import {
  anthropicEffortOptions,
  getChatV2ProviderLabel,
  googleThinkingLevelOptions,
  openAIReasoningEffortOptions,
} from '../chat-v2/providerOptions.js';

export type {
  LLMChatV2ApiKeySource,
  LLMChatV2EditorCacheKeyParts,
  LLMChatV2Node,
  LLMChatV2NodeConfigData,
  LLMChatV2NodeData,
} from '../chat-v2/llmChatV2NodeData.js';

export { buildLLMChatV2EditorCacheKey, resolveLLMChatV2RuntimeProviderOptions };

function usesBaseURLInput(data: LLMChatV2Node['data']): boolean {
  return data.provider === 'custom' && data.useCustomProviderBaseURLInput;
}

function getCustomProviderBaseURLBodyValue(data: LLMChatV2Node['data']): string | undefined {
  if (data.provider !== 'custom') {
    return undefined;
  }

  if (data.useCustomProviderBaseURLInput) {
    return '(Using Input)';
  }

  const baseURL = data.customProviderBaseURL.trim();
  return baseURL || undefined;
}

function getOptionLabel(options: readonly { value: string; label: string }[], value: string | undefined): string {
  return options.find((option) => option.value === (value ?? ''))?.label ?? value ?? 'Default';
}

function getProviderBodyLabel(data: LLMChatV2Node['data']): string {
  return data.provider === 'custom' ? 'Custom' : getChatV2ProviderLabel(data.provider);
}

function getReasoningEffortBodyValue(data: LLMChatV2Node['data']): string | undefined {
  switch (data.provider) {
    case 'openai':
      return getOptionLabel(openAIReasoningEffortOptions, data.openAIReasoningEffort);
    case 'anthropic':
      return getOptionLabel(anthropicEffortOptions, data.anthropicEffort);
    case 'google':
      return getOptionLabel(googleThinkingLevelOptions, data.googleThinkingLevel);
    case 'custom':
      return undefined;
  }
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/([\\`*_[\]{}()#+\-.!|])/g, '\\$1');
}

function getBodyLine(label: string, value: string): string {
  return `<span style="opacity: 0.55">${label}:</span> ${escapeMarkdownInline(value)}`;
}

function getOptionalNumberBodyLine(label: string, value: number | undefined, usesInput: boolean): string | undefined {
  if (usesInput) {
    return getBodyLine(label, '(Using Input)');
  }

  return value === undefined ? undefined : getBodyLine(label, `${value}`);
}

function getStopSequencesBodyLine(data: LLMChatV2Node['data']): string | undefined {
  if (data.useStopSequencesInput) {
    return getBodyLine('Stop sequences', '(Using Input)');
  }

  const stopSequences = (data.stopSequences ?? []).filter((sequence) => sequence.length > 0);
  return stopSequences.length === 0
    ? undefined
    : getBodyLine('Stop sequences', stopSequences.map((sequence) => JSON.stringify(sequence)).join(', '));
}

export class LLMChatV2NodeImpl extends NodeImpl<LLMChatV2Node> {
  static create(): LLMChatV2Node {
    return {
      type: 'llmChatV2',
      title: 'LLM Chat',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 260,
      },
      data: createLLMChatV2NodeData(),
    };
  }

  getRunActivityDescriptor(): NodeRunActivityDescriptor {
    return {
      category: 'model',
      primaryOutputPortId: 'response' as PortId,
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const usesProfile = this.data.configurationMode === 'profile';
    const commonInputData = usesProfile
      ? {
          ...this.data,
          useModelInput: false,
          useTemperatureInput: false,
          useTopPInput: false,
          useTopKInput: false,
          usePresencePenaltyInput: false,
          useFrequencyPenaltyInput: false,
          useStopSequencesInput: false,
          useSeedInput: false,
          useMaxTokensInput: false,
        }
      : this.data;
    const inputs = getCommonChatV2Inputs(commonInputData, {
      includeFunctions: this.data.useToolCalling,
    });

    if (usesProfile) {
      inputs.unshift({
        id: 'llmProfile' as PortId,
        title: 'LLM Profiles',
        dataType: ['llm-config', 'llm-config[]'] as const,
        required: true,
        coerced: true,
        splitRunBehavior: 'preserve-array',
        description: 'One LLM Profile or an ordered fallback chain. Profiles are tried left to right.',
      });
    }

    if (!usesProfile && this.data.apiKeySource === 'input') {
      inputs.push({
        id: 'apiKey' as PortId,
        title: 'API Key',
        dataType: 'string',
        required: false,
      });
    }

    if (!usesProfile && usesBaseURLInput(this.data)) {
      inputs.unshift({
        id: 'customProviderBaseURL' as PortId,
        title: 'Provider base URL',
        dataType: 'string',
        required: false,
      });
    }

    if (!usesProfile && this.data.useHeadersInput) {
      inputs.push({
        id: 'headers' as PortId,
        title: 'Headers',
        dataType: 'object',
        required: false,
      });
    }

    if (!usesProfile && this.data.useExtraProviderOptionsInput) {
      inputs.push({
        id: 'extraProviderOptions' as PortId,
        title: 'Extra Provider Options',
        dataType: ['string', 'object'] as const,
        required: false,
        coerced: true,
      });
    }

    if (!usesProfile && this.data.useOpenAIPreviousResponseIdInput && this.data.provider === 'openai') {
      inputs.push({
        id: 'previousResponseId' as PortId,
        title: 'Previous Response ID',
        dataType: 'string',
        required: false,
      });
    }

    if (!usesProfile && this.data.provider === 'anthropic' && this.data.useAnthropicThinkingBudgetInput) {
      inputs.push({
        id: 'anthropicThinkingBudget' as PortId,
        title: 'Thinking Budget',
        dataType: 'number',
        required: false,
      });
    }

    if (!usesProfile && this.data.provider === 'google' && this.data.useGoogleThinkingBudgetInput) {
      inputs.push({
        id: 'googleThinkingBudget' as PortId,
        title: 'Thinking Budget',
        dataType: 'number',
        required: false,
      });
    }

    if (this.data.responseFormat === 'json_schema') {
      inputs.push({
        id: 'responseSchema' as PortId,
        title: 'Response Schema',
        dataType: ['object', 'gpt-function'] as const,
        required: true,
        coerced: true,
      });
    }

    if (
      (this.data.responseFormat === 'json' || this.data.responseFormat === 'json_schema') &&
      this.data.useResponseSchemaNameInput
    ) {
      inputs.push({
        id: 'responseSchemaName' as PortId,
        title: 'Schema Name',
        dataType: 'string',
        required: false,
      });
    }

    if (
      (this.data.responseFormat === 'json' || this.data.responseFormat === 'json_schema') &&
      this.data.useResponseSchemaDescriptionInput
    ) {
      inputs.push({
        id: 'responseSchemaDescription' as PortId,
        title: 'Schema Description',
        dataType: 'string',
        required: false,
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs = getCommonChatV2Outputs(this.data, {
      includeFunctionCalls: shouldIncludeLLMChatV2ToolCalls(this.data),
      includeUsage: this.data.outputUsage,
      includeReasoning: this.data.outputReasoning,
    });
    const responseOutput = outputs.find((output) => output.id === ('response' as PortId));

    if (responseOutput != null && isLLMChatV2StructuredResponseFormat(this.data.responseFormat)) {
      responseOutput.dataType =
        this.data.responseFormat === 'json_schema'
          ? 'object'
          : ([
              'object',
              'object[]',
              'any',
              'any[]',
              'string',
              'string[]',
              'number',
              'number[]',
              'boolean',
              'boolean[]',
            ] as const);
    }

    if (shouldOutputChatV2RequestBody(this.data)) {
      outputs.push({
        id: 'requestBody' as PortId,
        title: 'LLM request body',
        dataType: ['object', 'object[]', 'string', 'string[]', 'any', 'any[]'] as const,
      });
    }

    if (shouldOutputChatV2ResponseBody(this.data)) {
      outputs.push({
        id: 'responseBody' as PortId,
        title: 'LLM response body',
        dataType: ['object', 'object[]', 'string', 'string[]', 'any', 'any[]'] as const,
      });
    }

    if (this.data.outputLLMAttempts) {
      outputs.push({
        id: 'llmAttempts' as PortId,
        title: 'LLM Attempts',
        dataType: 'object[]',
        description:
          'Chronological provider configuration, request, and response-validation attempts for this LLM Chat run.',
      });
    }

    if (this.data.configurationMode === 'profile') {
      outputs.push(
        {
          id: 'llmProfileSummary' as PortId,
          title: 'LLM Profile Summary',
          dataType: 'string',
          description: 'Human-readable profile fallback outcome for this LLM Chat run.',
        },
      );
    }

    return outputs;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Vendor-agnostic chat node built on the Vercel AI SDK.

        Choose OpenAI, Anthropic, Google, or a custom OpenAI-compatible provider inside the node without rewiring the graph.
        Common behavior stays shared; provider-specific settings only appear in advanced sections when relevant.
      `,
      contextMenuTitle: 'LLM Chat',
      infoBoxTitle: 'LLM Chat Node',
      group: ['Common', 'AI'],
    };
  }

  async getEditors(context: RivetUIContext): Promise<EditorDefinition<LLMChatV2Node>[]> {
    return getLLMChatV2Editors(this.data, context);
  }

  getBody(): NodeBodySpec {
    if (this.data.configurationMode === 'profile') {
      return {
        type: 'markdown',
        disableLinks: true,
        text: [
          getBodyLine('Configuration', 'From LLM Profiles input'),
          ...(this.data.useToolCalling ? [getBodyLine('Tools', 'Enabled')] : []),
          ...(this.data.responseFormat ? [getBodyLine('Response format', this.data.responseFormat)] : []),
        ].join('\n'),
      };
    }

    const modelInfo = getChatV2ModelInfo(this.data.provider, this.data.model);
    const providerLabel = getProviderBodyLabel(this.data);
    const baseURLValue = getCustomProviderBaseURLBodyValue(this.data);
    const modelLine = modelInfo?.displayName ?? this.data.model;
    const providerDetails = [
      getBodyLine('Provider', providerLabel),
      ...(baseURLValue ? [getBodyLine('Base URL', baseURLValue)] : []),
      getBodyLine('Model', modelLine),
    ];
    const reasoningEffortValue = getReasoningEffortBodyValue(this.data);

    return {
      type: 'markdown',
      disableLinks: true,
      text: [
        ...providerDetails,
        ...(reasoningEffortValue ? [getBodyLine('Reasoning effort', reasoningEffortValue)] : []),
        getBodyLine('Temperature', this.data.useTemperatureInput ? '(Using Input)' : `${this.data.temperature}`),
        getBodyLine('Max output tokens', this.data.useMaxTokensInput ? '(Using Input)' : `${this.data.maxTokens}`),
        getOptionalNumberBodyLine('Top P', this.data.topP, this.data.useTopPInput),
        getOptionalNumberBodyLine('Top K', this.data.topK, this.data.useTopKInput),
        getOptionalNumberBodyLine('Presence penalty', this.data.presencePenalty, this.data.usePresencePenaltyInput),
        getOptionalNumberBodyLine('Frequency penalty', this.data.frequencyPenalty, this.data.useFrequencyPenaltyInput),
        getStopSequencesBodyLine(this.data),
        getOptionalNumberBodyLine('Seed', this.data.seed, this.data.useSeedInput),
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const invocationJournal = new LLMInvocationJournal();
    // Retries, fallback profiles, and tool continuation produce several
    // physical provider calls underneath one node invocation. Always observe
    // them locally so every later output projection shares one truthful
    // boundary; whether Usage is exposed remains an output-setting decision.
    const usageTrackingContext = {
      ...context,
      onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => {
        try {
          invocationJournal.recordModelCall(event);
        } catch {
          // Accounting is observational and must never affect a provider call.
        }
        return context.onChatV2CallFinished?.(event);
      },
    };
    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: this.data,
      nodeId: this.chartNode.id,
      inputs,
      context: usageTrackingContext,
      onLLMAttempt: (attempt) => invocationJournal.recordLLMAttempt(attempt),
    });
    const toolCallContinuation = context.toolCallContinuation;

    const cacheHit = projectLLMChatV2EditorCacheHit(runtime);
    if (cacheHit != null) {
      context.markResultAsEditorCacheHit?.();
      return cacheHit;
    }

    const result = await executeLLMInvocation({
      context,
      journal: invocationJournal,
      runtime,
      toolCallContinuation,
    });

    projectLLMInvocationResult({
      result,
      modelCalls: invocationJournal.modelCalls,
      outputUsage: this.data.outputUsage,
      outputLLMAttempts: this.data.outputLLMAttempts,
      llmAttempts: invocationJournal.llmAttempts,
      profileSummary: runtime.getProfileSummary?.(),
    });

    if (toolCallContinuation && !isChatV2PipelineProviderFailureResult(result) && result.functionCalls.length > 0) {
      toolCallContinuation.release();
    }

    writeLLMChatV2EditorCache({ runtime, result });

    return result.commonOutputs;
  }
}

export const llmChatV2Node = nodeDefinition(LLMChatV2NodeImpl, 'LLM Chat');
