import { nanoid } from 'nanoid/non-secure';
import {
  LLMChatV2NodeImpl,
  type ChatMessage,
  type InternalProcessContext,
  type LLMChatV2NodeData,
  type NodeId,
  type PortId,
  coerceTypeOptional,
} from '@valerypopoff/rivet2-core';

/** The Prompt Designer's one-off preview. Repeatable checks belong to
 * Evaluations, which executes complete graphs rather than a private Chat loop. */
export async function runAdHocChat(messages: ChatMessage[], data: LLMChatV2NodeData, context: InternalProcessContext) {
  if (data.configurationMode === 'profile') {
    throw new Error('Prompt Designer previews inline LLM Chat settings. Open Evaluations to run a graph that uses an LLM Profile.');
  }

  const chatNode = new LLMChatV2NodeImpl({
    data: {
      ...data,
      cache: false,
      configurationMode: 'inline',
      useToolCalling: false,
      autoContinueToolCalls: false,
    },
    id: nanoid() as NodeId,
    title: 'Prompt Designer preview',
    type: 'llmChatV2',
    visualData: { x: 0, y: 0 },
  });

  const result = await chatNode.process(
    { ['prompt' as PortId]: { type: 'chat-message[]', value: messages } },
    { ...context, node: chatNode.chartNode },
  );

  return coerceTypeOptional(result['response' as PortId], 'string') ?? '';
}
