import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import { getLLMProfileEditors } from '../chat-v2/llmChatV2NodeEditors.js';
import type { LLMChatV2ProfileData } from '../chat-v2/llmChatV2NodeData.js';
import { resolveLLMProfileNodeValue } from '../chat-v2/llmProfileNodeRuntime.js';
import { createLLMProfileNodeData } from '../chat-v2/llmProfileTypes.js';
import { getChatV2ProviderLabel } from '../chat-v2/providerOptions.js';

export type { LLMProfileValue } from '../chat-v2/llmProfileTypes.js';
export type LLMProfileNodeData = LLMChatV2ProfileData;
export type LLMProfileNode = ChartNode<'llmProfile', LLMProfileNodeData>;

export class LLMProfileNodeImpl extends NodeImpl<LLMProfileNode> {
  static create(): LLMProfileNode {
    return {
      type: 'llmProfile',
      title: 'LLM Profile',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 260,
      },
      data: createLLMProfileNodeData(),
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];

    if (this.data.useModelInput) {
      inputs.push({ id: 'model' as PortId, title: 'Model', dataType: 'string', required: false });
    }
    if (this.data.apiKeySource === 'input') {
      inputs.push({ id: 'apiKey' as PortId, title: 'API Key', dataType: 'string', required: true });
    }
    if (this.data.provider === 'custom' && this.data.useCustomProviderBaseURLInput) {
      inputs.push({
        id: 'customProviderBaseURL' as PortId,
        title: 'Provider base URL',
        dataType: 'string',
        required: false,
      });
    }
    if (this.data.provider === 'openai' && this.data.useOpenAIPreviousResponseIdInput) {
      inputs.push({
        id: 'previousResponseId' as PortId,
        title: 'Previous Response ID',
        dataType: 'string',
        required: false,
      });
    }
    if (this.data.useTemperatureInput) {
      inputs.push({ id: 'temperature' as PortId, title: 'Temperature', dataType: 'number' });
    }
    if (this.data.useMaxTokensInput) {
      inputs.push({ id: 'maxTokens' as PortId, title: 'Max output tokens', dataType: 'number' });
    }
    if (this.data.useTopPInput) {
      inputs.push({ id: 'topP' as PortId, title: 'Top P', dataType: 'number' });
    }
    if (this.data.useTopKInput) {
      inputs.push({ id: 'topK' as PortId, title: 'Top K', dataType: 'number' });
    }
    if (this.data.usePresencePenaltyInput) {
      inputs.push({ id: 'presencePenalty' as PortId, title: 'Presence Penalty', dataType: 'number' });
    }
    if (this.data.useFrequencyPenaltyInput) {
      inputs.push({ id: 'frequencyPenalty' as PortId, title: 'Frequency Penalty', dataType: 'number' });
    }
    if (this.data.useStopSequencesInput) {
      inputs.push({
        id: 'stopSequences' as PortId,
        title: 'Stop Sequences',
        dataType: ['string', 'string[]'],
        required: false,
        coerced: true,
      });
    }
    if (this.data.useSeedInput) {
      inputs.push({ id: 'seed' as PortId, title: 'Seed', dataType: 'number' });
    }
    if (this.data.useHeadersInput) {
      inputs.push({ id: 'headers' as PortId, title: 'Headers', dataType: 'object', required: false });
    }
    if (this.data.useExtraProviderOptionsInput) {
      inputs.push({
        id: 'extraProviderOptions' as PortId,
        title: 'Extra Provider Options',
        dataType: ['string', 'object'],
        required: false,
        coerced: true,
      });
    }
    if (this.data.provider === 'anthropic' && this.data.useAnthropicThinkingBudgetInput) {
      inputs.push({ id: 'anthropicThinkingBudget' as PortId, title: 'Thinking Budget', dataType: 'number' });
    }
    if (this.data.provider === 'google' && this.data.useGoogleThinkingBudgetInput) {
      inputs.push({ id: 'googleThinkingBudget' as PortId, title: 'Thinking Budget', dataType: 'number' });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'profile' as PortId, title: 'Profile', dataType: 'llm-config' }];
  }

  async getEditors(context: RivetUIContext): Promise<EditorDefinition<LLMProfileNode>[]> {
    return await getLLMProfileEditors(this.data, context);
  }

  getBody(): string {
    return dedent`
      Provider: ${getChatV2ProviderLabel(this.data.provider)}
      Model: ${this.data.useModelInput ? '(from input)' : this.data.model}
      Temperature: ${this.data.useTemperatureInput ? '(from input)' : this.data.temperature}
      Max output tokens: ${this.data.useMaxTokensInput ? '(from input)' : this.data.maxTokens}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody:
        'Creates a reusable LLM provider, model, credential, generation, reasoning, and provider-capability profile for LLM Chat.',
      contextMenuTitle: 'LLM Profile',
      infoBoxTitle: 'LLM Profile Node',
      group: ['Common', 'AI'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    return {
      ['profile' as PortId]: {
        type: 'llm-config',
        value: resolveLLMProfileNodeValue({
          data: this.data,
          inputs,
          context,
        }),
      },
    };
  }
}

export const llmProfileNode = nodeDefinition(LLMProfileNodeImpl, 'LLM Profile');
