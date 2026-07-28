import type { EditorDefinition } from '../EditorDefinition.js';
import type { ChartNode, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';

export type ChatV2CommonNodeData = {
  model: string;
  useModelInput: boolean;
  temperature: number;
  useTemperatureInput: boolean;
  topP?: number;
  useTopPInput: boolean;
  topK?: number;
  useTopKInput: boolean;
  presencePenalty?: number;
  usePresencePenaltyInput: boolean;
  frequencyPenalty?: number;
  useFrequencyPenaltyInput: boolean;
  stopSequences?: string[];
  useStopSequencesInput: boolean;
  seed?: number;
  useSeedInput: boolean;
  maxTokens: number;
  useMaxTokensInput: boolean;
  useToolCalling: boolean;
  outputUsage: boolean;
  outputReasoning: boolean;
  cache: boolean;
  useAsGraphPartialOutput?: boolean;
};

type ChatV2SharedNode = ChartNode<string, ChatV2CommonNodeData>;

export type CommonChatV2InputOptions = {
  systemPromptPortId?: PortId;
  promptPortId?: PortId;
  functionsPortId?: PortId;
  includeTopP?: boolean;
  includeTopK?: boolean;
  includeFunctions?: boolean;
};

export type CommonChatV2OutputOptions = {
  responsePortId?: PortId;
  inMessagesPortId?: PortId;
  allMessagesPortId?: PortId;
  functionCallsPortId?: PortId;
  usagePortId?: PortId;
  reasoningPortId?: PortId;
  includeFunctionCalls?: boolean;
  includeUsage?: boolean;
  includeReasoning?: boolean;
};

export function createChatV2CommonNodeData(overrides: Partial<ChatV2CommonNodeData> = {}): ChatV2CommonNodeData {
  return {
    model: 'gpt-4o',
    useModelInput: false,
    temperature: 0.5,
    useTemperatureInput: false,
    topP: undefined,
    useTopPInput: false,
    topK: undefined,
    useTopKInput: false,
    presencePenalty: undefined,
    usePresencePenaltyInput: false,
    frequencyPenalty: undefined,
    useFrequencyPenaltyInput: false,
    stopSequences: [],
    useStopSequencesInput: false,
    seed: undefined,
    useSeedInput: false,
    maxTokens: 1024,
    useMaxTokensInput: false,
    useToolCalling: false,
    outputUsage: false,
    outputReasoning: false,
    cache: false,
    useAsGraphPartialOutput: true,
    ...overrides,
  };
}

export function getCommonChatV2Inputs(
  data: ChatV2CommonNodeData,
  options: CommonChatV2InputOptions = {},
): NodeInputDefinition[] {
  const {
    systemPromptPortId = 'systemPrompt' as PortId,
    promptPortId = 'prompt' as PortId,
    functionsPortId = 'functions' as PortId,
    includeTopP = true,
    includeTopK = true,
    includeFunctions = data.useToolCalling,
  } = options;

  const inputs: NodeInputDefinition[] = [
    {
      id: systemPromptPortId,
      title: 'System Prompt',
      dataType: 'string',
      required: false,
      coerced: true,
    },
  ];

  if (data.useModelInput) {
    inputs.push({
      id: 'model' as PortId,
      title: 'Model',
      dataType: 'string',
      required: false,
    });
  }

  if (data.useTemperatureInput) {
    inputs.push({
      id: 'temperature' as PortId,
      title: 'Temperature',
      dataType: 'number',
    });
  }

  if (includeTopP && data.useTopPInput) {
    inputs.push({
      id: 'topP' as PortId,
      title: 'Top P',
      dataType: 'number',
    });
  }

  if (includeTopK && data.useTopKInput) {
    inputs.push({
      id: 'topK' as PortId,
      title: 'Top K',
      dataType: 'number',
    });
  }

  if (data.usePresencePenaltyInput) {
    inputs.push({
      id: 'presencePenalty' as PortId,
      title: 'Presence Penalty',
      dataType: 'number',
    });
  }

  if (data.useFrequencyPenaltyInput) {
    inputs.push({
      id: 'frequencyPenalty' as PortId,
      title: 'Frequency Penalty',
      dataType: 'number',
    });
  }

  if (data.useStopSequencesInput) {
    inputs.push({
      id: 'stopSequences' as PortId,
      title: 'Stop Sequences',
      dataType: ['string', 'string[]'] as const,
      required: false,
      coerced: true,
    });
  }

  if (data.useSeedInput) {
    inputs.push({
      id: 'seed' as PortId,
      title: 'Seed',
      dataType: 'number',
    });
  }

  if (data.useMaxTokensInput) {
    inputs.push({
      id: 'maxTokens' as PortId,
      title: 'Max output tokens',
      dataType: 'number',
    });
  }

  if (includeFunctions) {
    inputs.push({
      id: functionsPortId,
      title: 'Tools',
      dataType: ['gpt-function', 'gpt-function[]'] as const,
      required: false,
      coerced: false,
    });
  }

  inputs.push({
    id: promptPortId,
    title: 'Prompt',
    dataType: ['chat-message', 'chat-message[]', 'string', 'string[]'] as const,
    coerced: true,
  });

  return inputs;
}

export function getCommonChatV2Outputs(
  data: ChatV2CommonNodeData,
  options: CommonChatV2OutputOptions = {},
): NodeOutputDefinition[] {
  const {
    responsePortId = 'response' as PortId,
    inMessagesPortId = 'in-messages' as PortId,
    allMessagesPortId = 'all-messages' as PortId,
    functionCallsPortId = 'function-calls' as PortId,
    usagePortId = 'usage' as PortId,
    reasoningPortId = 'reasoning' as PortId,
    includeFunctionCalls = data.useToolCalling,
    includeUsage = data.outputUsage,
    includeReasoning = data.outputReasoning,
  } = options;

  const outputs: NodeOutputDefinition[] = [
    {
      id: responsePortId,
      title: 'Response',
      dataType: 'string',
    },
    {
      id: inMessagesPortId,
      title: 'Messages Sent',
      dataType: 'chat-message[]',
    },
    {
      id: allMessagesPortId,
      title: 'All Messages',
      dataType: 'chat-message[]',
    },
  ];

  if (includeFunctionCalls) {
    outputs.push({
      id: functionCallsPortId,
      title: 'Tool Calls',
      dataType: 'object[]',
    });
  }

  if (includeUsage) {
    outputs.push({
      id: usagePortId,
      title: 'Usage',
      dataType: 'object',
    });
  }

  if (includeReasoning) {
    outputs.push({
      id: reasoningPortId,
      title: 'Reasoning',
      dataType: ['string', 'string[]'] as const,
    });
  }

  return outputs;
}

export function getCommonChatV2Editors<T extends ChatV2SharedNode>(
  modelOptions: { value: string; label: string }[],
): EditorDefinition<T>[] {
  const editors = [
    {
      type: 'dropdown',
      label: 'Model',
      dataKey: 'model',
      useInputToggleDataKey: 'useModelInput',
      options: modelOptions,
    },
    {
      type: 'group',
      label: 'Parameters',
      editors: [
        {
          type: 'number',
          label: 'Temperature',
          helperMessage: 'Provider-dependent; some reasoning models may ignore this setting.',
          dataKey: 'temperature',
          useInputToggleDataKey: 'useTemperatureInput',
          min: 0,
          max: 2,
          step: 0.1,
        },
        {
          type: 'number',
          label: 'Max output tokens',
          dataKey: 'maxTokens',
          useInputToggleDataKey: 'useMaxTokensInput',
          min: 1,
          step: 1,
        },
        {
          type: 'number',
          label: 'Top P',
          dataKey: 'topP',
          useInputToggleDataKey: 'useTopPInput',
          allowEmpty: true,
          min: 0,
          max: 1,
          step: 0.1,
        },
        {
          type: 'number',
          label: 'Top K',
          helperMessage: 'Provider-dependent; some providers or models may ignore this setting.',
          dataKey: 'topK',
          useInputToggleDataKey: 'useTopKInput',
          allowEmpty: true,
          min: 1,
          step: 1,
        },
        {
          type: 'number',
          label: 'Presence penalty',
          dataKey: 'presencePenalty',
          useInputToggleDataKey: 'usePresencePenaltyInput',
          allowEmpty: true,
          min: -1,
          max: 1,
          step: 0.1,
        },
        {
          type: 'number',
          label: 'Frequency penalty',
          dataKey: 'frequencyPenalty',
          useInputToggleDataKey: 'useFrequencyPenaltyInput',
          allowEmpty: true,
          min: -1,
          max: 1,
          step: 0.1,
        },
        {
          type: 'stringList',
          label: 'Stop sequences',
          dataKey: 'stopSequences',
          useInputToggleDataKey: 'useStopSequencesInput',
          placeholder: 'Stop sequence',
          newItemDefault: '',
        },
        {
          type: 'number',
          label: 'Seed',
          dataKey: 'seed',
          useInputToggleDataKey: 'useSeedInput',
          allowEmpty: true,
          min: 0,
          step: 1,
        },
      ],
    },
    {
      type: 'group',
      label: 'Outputs',
      editors: [
        {
          type: 'toggle',
          label: 'Enable Tool Calling',
          dataKey: 'useToolCalling',
        },
        {
          type: 'toggle',
          label: 'Output usage details',
          dataKey: 'outputUsage',
          helperMessage:
            'Adds a Usage output built from Vercel AI SDK usage metadata: prompt, completion, total, cached, reasoning tokens, and estimated cost when available.',
        },
        {
          type: 'toggle',
          label: 'Stream response',
          dataKey: 'useAsGraphPartialOutput',
          helperMessage:
            'Shows streamed response updates in the node output while running in the editor. Other nodes only receive the final response after it is complete.',
        },
      ],
    },
  ] satisfies EditorDefinition<ChatV2SharedNode>[];

  return editors as unknown as EditorDefinition<T>[];
}
