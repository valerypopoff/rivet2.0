import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai';
import type { StreamedFunctionCall } from './streamChatResponse.js';

export type AiSdkStreamResult = {
  responseText: string;
  functionCalls: StreamedFunctionCall[];
  usage: LanguageModelUsage | undefined;
  reasoning: string;
};

export type ConsumeAiSdkStreamOptions = {
  dedupeDuplicateTextBlocks?: boolean;
};

function buildResponseText(textBlocks: Map<string, string>, dedupeDuplicateTextBlocks: boolean): string {
  const blockTexts = Array.from(textBlocks.values()).filter((text) => text.length > 0);

  if (blockTexts.length === 0) {
    return '';
  }

  if (dedupeDuplicateTextBlocks && blockTexts.length > 1) {
    const longestText = blockTexts.reduce((longest, text) => (text.length > longest.length ? text : longest));

    if (blockTexts.every((text) => longestText.startsWith(text))) {
      return longestText;
    }
  }

  return blockTexts.join('');
}

export async function consumeAiSdkStream(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  onPartialOutputs: (text: string, functionCalls: StreamedFunctionCall[], reasoning: string) => void,
  options: ConsumeAiSdkStreamOptions = {},
): Promise<AiSdkStreamResult> {
  let responseText = '';
  let reasoning = '';
  const functionCalls: StreamedFunctionCall[] = [];
  let usage: LanguageModelUsage | undefined;
  const textBlocks = new Map<string, string>();

  for await (const part of fullStream) {
    switch (part.type) {
      case 'text-start': {
        if (!textBlocks.has(part.id)) {
          textBlocks.set(part.id, '');
        }
        break;
      }

      case 'text-delta': {
        textBlocks.set(part.id, `${textBlocks.get(part.id) ?? ''}${part.text}`);
        responseText = buildResponseText(textBlocks, !!options.dedupeDuplicateTextBlocks);
        onPartialOutputs(responseText, functionCalls, reasoning);
        break;
      }

      case 'reasoning-delta': {
        reasoning += part.text;
        onPartialOutputs(responseText, functionCalls, reasoning);
        break;
      }

      case 'tool-call': {
        functionCalls.push({
          type: 'function',
          id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input),
          lastParsedArguments: part.input,
        });
        onPartialOutputs(responseText, functionCalls, reasoning);
        break;
      }

      case 'finish': {
        usage = part.totalUsage;
        break;
      }

      case 'error': {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  }

  return { responseText, functionCalls, usage, reasoning };
}
