import {
  coerceTypeOptional,
  createChatV2Model,
  type ChartNode,
  type ChatMessageMessagePart,
  type DataValue,
  type GptFunction,
  type Inputs,
  type InternalProcessContext,
  NodeImpl,
  nodeDefinition,
  type NodeConnection,
  type NodeDefinition,
  type NodeDefinitionContext,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
  resolveChatV2ProviderConfig,
  runChatV2Pipeline,
} from '@valerypopoff/rivet2-core';
import type { ResolvedAiAssistModelSettings } from './aiAssistModelSettings.js';

const AI_ASSIST_GENERATOR_CHAT_NODE_TYPE = 'aiAssistGeneratorChatV2';
const TAGGED_GENERATOR_RESPONSE_TAGS = ['answer', 'Instructions'] as const;

type AiAssistGeneratorChatBranch = 'openaiCompatible' | 'anthropic';

type AiAssistGeneratorChatNodeData = Record<string, unknown> & {
  aiAssistGeneratorChatBranch: AiAssistGeneratorChatBranch;
};

type AiAssistGeneratorChatNode = ChartNode<typeof AI_ASSIST_GENERATOR_CHAT_NODE_TYPE, AiAssistGeneratorChatNodeData>;

const CONTROL_FLOW_EXCLUDED = { type: 'control-flow-excluded', value: undefined } as const;

function createFallbackNodeId(): NodeId {
  return AI_ASSIST_GENERATOR_CHAT_NODE_TYPE as NodeId;
}

function createPortId(id: string): PortId {
  return id as PortId;
}

const RESPONSE_PORT_ID = createPortId('response');

function getDataNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' ? value : undefined;
}

function getDataBoolean(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

function getDataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function getInputString(inputs: Inputs, id: string): string | undefined {
  return coerceTypeOptional(inputs[createPortId(id)], 'string')?.trim() || undefined;
}

function getInputRawString(inputs: Inputs, id: string): string | undefined {
  return coerceTypeOptional(inputs[createPortId(id)], 'string');
}

function getInputNumber(inputs: Inputs, id: string): number | undefined {
  return coerceTypeOptional(inputs[createPortId(id)], 'number');
}

function getOptionalSystemPrompt(inputs: Inputs): DataValue | undefined {
  return inputs[createPortId('systemPrompt')] ?? inputs[createPortId('system')];
}

function getOptionalFunctions(inputs: Inputs): GptFunction[] | undefined {
  return (
    coerceTypeOptional(inputs[createPortId('functions')], 'gpt-function[]') ??
    coerceTypeOptional(inputs[createPortId('tools')], 'gpt-function[]') ??
    undefined
  );
}

function getOptionalStopSequences(data: Record<string, unknown>, inputs: Inputs): string[] | undefined {
  const stop = getDataBoolean(data, 'useStopInput') ? getInputRawString(inputs, 'stop') : getDataString(data, 'stop');
  return getDataBoolean(data, 'useStop') && stop ? [stop] : undefined;
}

function getTemperature(data: Record<string, unknown>, inputs: Inputs): number | undefined {
  return getDataBoolean(data, 'useTemperatureInput')
    ? (getInputNumber(inputs, 'temperature') ?? getDataNumber(data, 'temperature'))
    : getDataNumber(data, 'temperature');
}

function getTopP(data: Record<string, unknown>, inputs: Inputs): number | undefined {
  const useTopP = getDataBoolean(data, 'useUseTopPInput')
    ? (coerceTypeOptional(inputs[createPortId('useTopP')], 'boolean') ?? getDataBoolean(data, 'useTopP'))
    : getDataBoolean(data, 'useTopP');

  if (!useTopP) {
    return undefined;
  }

  return getDataBoolean(data, 'useTopPInput')
    ? (getInputNumber(inputs, 'top_p') ?? getDataNumber(data, 'top_p'))
    : getDataNumber(data, 'top_p');
}

function getMaxTokens(data: Record<string, unknown>, inputs: Inputs): number | undefined {
  return getDataBoolean(data, 'useMaxTokensInput')
    ? (getInputNumber(inputs, 'maxTokens') ?? getDataNumber(data, 'maxTokens'))
    : getDataNumber(data, 'maxTokens');
}

function pickGeneratorOutputs(outputs: Outputs): Outputs {
  return {
    [createPortId('response')]: outputs[createPortId('response')] ?? CONTROL_FLOW_EXCLUDED,
    [createPortId('function-calls')]: outputs[createPortId('function-calls')] ?? CONTROL_FLOW_EXCLUDED,
    [createPortId('all-messages')]: outputs[createPortId('all-messages')] ?? CONTROL_FLOW_EXCLUDED,
  };
}

function getProviderForGeneratorNode(branch: AiAssistGeneratorChatBranch, modelSettings: ResolvedAiAssistModelSettings) {
  return branch === 'anthropic' ? 'anthropic' : modelSettings.provider;
}

function getCustomProviderBaseURL(
  provider: ResolvedAiAssistModelSettings['provider'],
  modelSettings: ResolvedAiAssistModelSettings,
): string | undefined {
  return provider === 'custom' ? modelSettings.customProviderBaseURL : undefined;
}

function getCustomProviderApiKey(
  provider: ResolvedAiAssistModelSettings['provider'],
  context: InternalProcessContext,
): string | undefined {
  return provider === 'custom' ? context.settings.customAiApiKey || undefined : undefined;
}

const inputDefinitions: NodeInputDefinition[] = [
  { id: createPortId('systemPrompt'), title: 'System Prompt', dataType: 'string', required: false, coerced: true },
  { id: createPortId('system'), title: 'System Prompt', dataType: 'string', required: false, coerced: true },
  { id: createPortId('model'), title: 'Model', dataType: 'string', required: false },
  { id: createPortId('temperature'), title: 'Temperature', dataType: 'number', required: false },
  { id: createPortId('top_p'), title: 'Top P', dataType: 'number', required: false },
  { id: createPortId('useTopP'), title: 'Use Top P', dataType: 'boolean', required: false },
  { id: createPortId('maxTokens'), title: 'Max Tokens', dataType: 'number', required: false },
  { id: createPortId('stop'), title: 'Stop', dataType: 'string', required: false },
  {
    id: createPortId('prompt'),
    title: 'Prompt',
    dataType: ['chat-message', 'chat-message[]'],
    coerced: true,
  },
  {
    id: createPortId('functions'),
    title: 'Functions',
    dataType: ['gpt-function', 'gpt-function[]'],
    coerced: false,
  },
  {
    id: createPortId('tools'),
    title: 'Tools',
    dataType: ['gpt-function', 'gpt-function[]'],
    coerced: false,
  },
];

const outputDefinitions: NodeOutputDefinition[] = [
  { id: RESPONSE_PORT_ID, title: 'Response', dataType: 'string' },
  { id: createPortId('function-calls'), title: 'Function Calls', dataType: 'object[]' },
  { id: createPortId('all-messages'), title: 'All Messages', dataType: 'chat-message[]' },
];

function getMessagePartText(part: ChatMessageMessagePart): string {
  if (typeof part === 'string') {
    return part;
  }

  if (part.type === 'url') {
    return part.url;
  }

  if (part.type === 'document') {
    return [part.title, part.context].filter(Boolean).join('\n');
  }

  return '';
}

function getDataValueText(value: DataValue | undefined): string {
  if (value == null) {
    return '';
  }

  if (value.type === 'string') {
    return value.value;
  }

  if (value.type === 'chat-message') {
    const parts = Array.isArray(value.value.message) ? value.value.message : [value.value.message];
    return parts.map(getMessagePartText).join('\n');
  }

  if (value.type === 'chat-message[]') {
    return value.value
      .flatMap((message) => (Array.isArray(message.message) ? message.message : [message.message]))
      .map(getMessagePartText)
      .join('\n');
  }

  return '';
}

function getRequiredResponseTag(promptText: string): (typeof TAGGED_GENERATOR_RESPONSE_TAGS)[number] | undefined {
  return TAGGED_GENERATOR_RESPONSE_TAGS.find(
    (tag) => promptText.includes(`<${tag}>`) && promptText.includes(`</${tag}>`),
  );
}

function responseHasTag(response: string, tag: string): boolean {
  return new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).test(response);
}

export function normalizeAiAssistGeneratorResponseForTaggedHelper(response: string, inputs: Inputs): string {
  const tag = getRequiredResponseTag(getDataValueText(inputs[createPortId('prompt')]));
  const trimmed = response.trim();

  if (!tag || !trimmed || responseHasTag(response, tag)) {
    return response;
  }

  return `<${tag}>${trimmed}</${tag}>`;
}

export function createAiAssistVercelGeneratorChatNodeDefinition(
  modelSettings: ResolvedAiAssistModelSettings,
): NodeDefinition<AiAssistGeneratorChatNode> {
  class AiAssistGeneratorChatNodeImpl extends NodeImpl<AiAssistGeneratorChatNode> {
    static create(): AiAssistGeneratorChatNode {
      return {
        type: AI_ASSIST_GENERATOR_CHAT_NODE_TYPE,
        id: createFallbackNodeId(),
        title: 'AI Assist Chat V2',
        visualData: { x: 0, y: 0 },
        data: {
          aiAssistGeneratorChatBranch: 'openaiCompatible',
        },
      };
    }

    static getUIData() {
      return {
        contextMenuTitle: 'AI Assist Chat V2',
        group: ['AI'],
      };
    }

    getInputDefinitions(
      _connections: NodeConnection[],
      _nodes: Record<NodeId, ChartNode>,
      _project: Project,
      _referencedProjects: Record<ProjectId, Project>,
      _definitionContext?: NodeDefinitionContext,
    ): NodeInputDefinition[] {
      return inputDefinitions;
    }

    getOutputDefinitions(
      _connections: NodeConnection[],
      _nodes: Record<NodeId, ChartNode>,
      _project: Project,
      _referencedProjects: Record<ProjectId, Project>,
      _definitionContext?: NodeDefinitionContext,
    ): NodeOutputDefinition[] {
      return outputDefinitions;
    }

    async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
      const provider = getProviderForGeneratorNode(this.data.aiAssistGeneratorChatBranch, modelSettings);
      const modelId = getInputString(inputs, 'model') ?? modelSettings.model;
      const providerConfig = await resolveChatV2ProviderConfig(provider, modelId, context, {
        baseURL: getCustomProviderBaseURL(provider, modelSettings),
      });
      const model = createChatV2Model(provider, modelId, context, {
        ...providerConfig,
        apiKey: getCustomProviderApiKey(provider, context),
      });
      const result = await runChatV2Pipeline({
        provider,
        model,
        modelId,
        prompt: inputs[createPortId('prompt')],
        systemPrompt: getOptionalSystemPrompt(inputs),
        functions: getOptionalFunctions(inputs),
        maxTokens: getMaxTokens(this.data, inputs),
        temperature: getTemperature(this.data, inputs),
        topP: getTopP(this.data, inputs),
        stopSequences: getOptionalStopSequences(this.data, inputs),
        includeFunctionCalls: true,
        emitPartialOutputs: false,
        context,
      });
      const response = result.commonOutputs[RESPONSE_PORT_ID];

      if (response?.type === 'string') {
        result.commonOutputs[RESPONSE_PORT_ID] = {
          ...response,
          value: normalizeAiAssistGeneratorResponseForTaggedHelper(response.value, inputs),
        };
      }

      return pickGeneratorOutputs(result.commonOutputs);
    }
  }

  return nodeDefinition(AiAssistGeneratorChatNodeImpl, 'AI Assist Chat V2');
}
