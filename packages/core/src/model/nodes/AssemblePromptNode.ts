import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeBody, type NodeUIData } from '../NodeImpl.js';
import { type ChatMessage, arrayizeDataValue, unwrapDataValue } from '../DataValue.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { coerceType } from '../../utils/coerceType.js';
import { orderBy } from 'lodash-es';
import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { getInputOrData } from '../../utils/inputs.js';
import { getNextVariadicPortIndex, parseVariadicPortIndex } from './variadicPortIndex.js';

export type AssemblePromptNode = ChartNode<'assemblePrompt', AssemblePromptNodeData>;

export type AssemblePromptNodeData = {
  computeTokenCount?: boolean;

  /** Remove messages that contain no meaningful text or rich content. */
  filterEmptyPrompts?: boolean;

  isLastMessageCacheBreakpoint?: boolean;
  useIsLastMessageCacheBreakpointInput?: boolean;
};

function isEmptyPromptMessage(message: ChatMessage): boolean {
  // Tool protocol messages remain meaningful even when their textual content is empty.
  if (message.type === 'function') {
    return false;
  }

  if (message.type === 'assistant' && (message.function_call != null || (message.function_calls?.length ?? 0) > 0)) {
    return false;
  }

  const parts = Array.isArray(message.message) ? message.message : [message.message];
  return !parts.some((part) => typeof part !== 'string' || part.trim().length > 0);
}

export class AssemblePromptNodeImpl extends NodeImpl<AssemblePromptNode> {
  static create(): AssemblePromptNode {
    const chartNode: AssemblePromptNode = {
      type: 'assemblePrompt',
      title: 'Assemble Prompt',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        filterEmptyPrompts: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    const messageCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'message', 'legacy');

    if (this.data.useIsLastMessageCacheBreakpointInput) {
      inputs.push({
        dataType: 'boolean',
        id: 'isLastMessageCacheBreakpoint' as PortId,
        title: 'Is Last Message Cache Breakpoint',
        description: 'Whether the last message in a multi-message prompt should be a cache breakpoint.',
      });
    }

    for (let i = 1; i <= messageCount; i++) {
      inputs.push({
        dataType: ['chat-message', 'chat-message[]'] as const,
        id: `message${i}` as PortId,
        title: `Message ${i}`,
        description: 'A message, or messages, to include in the full prompt.',
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [
      {
        dataType: 'chat-message[]',
        id: 'prompt' as PortId,
        title: 'Prompt',
        description: 'The assembled prompt, a list of chat messages.',
      },
    ];

    if (this.data.computeTokenCount) {
      outputs.push({
        dataType: 'number',
        id: 'tokenCount' as PortId,
        title: 'Token Count',
        description: 'The number of tokens in the full output prompt.',
      });
    }

    return outputs;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Assembles an array of chat messages for use with a Chat node. The inputs can be strings or chat messages.

        The number of inputs is dynamic based on the number of connections.

        Strings are converted to User type chat messages.
      `,
      infoBoxTitle: 'Assemble Prompt Node',
      contextMenuTitle: 'Assemble Prompt',
      group: ['AI'],
    };
  }

  getEditors(): EditorDefinition<AssemblePromptNode>[] {
    return [
      {
        type: 'toggle',
        label: 'Compute Token Count',
        dataKey: 'computeTokenCount',
      },
      {
        type: 'toggle',
        label: 'Filter empty prompts',
        dataKey: 'filterEmptyPrompts',
        defaultValue: false,
        helperMessage:
          'Removes text-only messages whose content is empty or whitespace. Rich-content and tool-protocol messages are preserved.',
      },
      {
        type: 'toggle',
        label: 'Is Last Message Cache Breakpoint',
        dataKey: 'isLastMessageCacheBreakpoint',
        useInputToggleDataKey: 'useIsLastMessageCacheBreakpointInput',
        helperMessage:
          'For Anthropic, marks the last message in a prompt containing at least two messages as a cache breakpoint. This message and every message before it will be cached using Prompt Caching.',
      },
    ];
  }

  getBody(): NodeBody | Promise<NodeBody> {
    return [
      this.data.filterEmptyPrompts ? 'Filter empty prompts: Enabled' : '',
      this.data.useIsLastMessageCacheBreakpointInput
        ? 'Last message cache breakpoint: From input'
        : this.data.isLastMessageCacheBreakpoint
          ? 'Last message is cache breakpoint'
          : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const output: Outputs = {};

    const isLastMessageCacheBreakpoint = getInputOrData(this.data, inputs, 'isLastMessageCacheBreakpoint', 'boolean');

    const outMessages: ChatMessage[] = [];

    const inputMessages = orderBy(
      Object.entries(inputs).filter(([key]) => key.startsWith('message')),
      ([key]) => parseVariadicPortIndex(key, 'message', 'legacy'),
      'asc',
    );

    for (const [, inputMessage] of inputMessages) {
      if (!inputMessage || inputMessage.type === 'control-flow-excluded' || !inputMessage.value) {
        continue;
      }

      const inMessages = arrayizeDataValue(unwrapDataValue(inputMessage));
      for (const message of inMessages) {
        const outMessage = message.type === 'chat-message' ? message.value : coerceType(message, 'chat-message');

        if (this.data.filterEmptyPrompts && isEmptyPromptMessage(outMessage)) {
          continue;
        }

        outMessages.push(outMessage);
      }
    }

    if (isLastMessageCacheBreakpoint && outMessages.length > 1) {
      outMessages[outMessages.length - 1] = {
        ...outMessages[outMessages.length - 1]!,
        isCacheBreakpoint: true,
      };
    }

    output['prompt' as PortId] = {
      type: 'chat-message[]',
      value: outMessages,
    };

    if (this.data.computeTokenCount) {
      const tokenCount = await context.tokenizer.getTokenCountForMessages(outMessages, undefined, {
        node: this.chartNode,
      });
      output['tokenCount' as PortId] = {
        type: 'number',
        value: tokenCount,
      };
    }

    return output;
  }
}

export const assemblePromptNode = nodeDefinition(AssemblePromptNodeImpl, 'Assemble Prompt');
