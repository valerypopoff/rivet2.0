import type { ChatMessageDataValue, GptFunction } from '../DataValue.js';
import type {
  ChatV2NormalizedUsage,
  ChatV2PipelineResult,
  ChatV2ReasoningOutput,
  RunChatV2PipelineOptions,
} from './chatV2Types.js';
import type { StreamedFunctionCall } from '../chat/streamChatResponse.js';
import { runChatV2Pipeline } from './chatV2Pipeline.js';
import type { DelegatedToolCallRecord } from '../nodes/toolCallDelegation.js';
import type { PortId } from '../NodeBase.js';

export type ToolContinuationOptions = RunChatV2PipelineOptions & {
  autoContinue: boolean;
  maxToolRounds: number;
  functions: GptFunction[] | undefined;
  delegateToolCall: (toolCall: StreamedFunctionCall) => Promise<ToolContinuationToolResult>;
  delegateToolCallRound?: (
    toolCalls: StreamedFunctionCall[],
    preToolMessage: string,
  ) => Promise<ToolContinuationToolResult[]>;
  runPipeline?: (options: RunChatV2PipelineOptions) => Promise<ChatV2PipelineResult>;
};

export type ToolContinuationToolResult = ChatMessageDataValue & {
  delegatedToolCall?: DelegatedToolCallRecord;
};

function getToolNames(functions: GptFunction[] | undefined): Set<string> {
  return new Set((functions ?? []).map((fn) => fn.name).filter((name) => name.trim().length > 0));
}

function canAutoContinue(functionCalls: StreamedFunctionCall[], toolNames: Set<string>): boolean {
  return functionCalls.length > 0 && functionCalls.every((call) => toolNames.has(call.name));
}

function shouldReturnToolResultDirectly(
  functionCalls: StreamedFunctionCall[],
  functions: GptFunction[] | undefined,
): boolean {
  if (functionCalls.length !== 1) {
    return false;
  }

  let tool: GptFunction | undefined;
  for (const candidate of functions ?? []) {
    if (candidate.name === functionCalls[0]!.name) {
      // Provider tool maps use the last declaration for duplicate names.
      tool = candidate;
    }
  }
  return tool?.resultHandling === 'return-direct';
}

function addUsage(
  accumulated: ChatV2NormalizedUsage | undefined,
  usage: ChatV2NormalizedUsage | undefined,
): ChatV2NormalizedUsage | undefined {
  if (usage == null) {
    return accumulated;
  }

  if (accumulated == null) {
    return { ...usage };
  }

  return {
    promptTokens: accumulated.promptTokens + usage.promptTokens,
    completionTokens: accumulated.completionTokens + usage.completionTokens,
    totalTokens: accumulated.totalTokens + usage.totalTokens,
    cachedTokens: accumulated.cachedTokens + usage.cachedTokens,
    reasoningTokens: accumulated.reasoningTokens + usage.reasoningTokens,
    totalCost:
      accumulated.totalCost == null || usage.totalCost == null ? undefined : accumulated.totalCost + usage.totalCost,
  };
}

function applyAccumulatedUsage(
  result: ChatV2PipelineResult,
  usage: ChatV2NormalizedUsage | undefined,
  outputUsage: boolean | undefined,
) {
  if (usage == null) {
    return;
  }

  result.usage = usage;
  result.commonOutputs['responseTokens' as PortId] = {
    type: 'number',
    value: usage.completionTokens,
  };

  if (outputUsage) {
    result.commonOutputs['usage' as PortId] = {
      type: 'object',
      value: usage,
    };
  }
}

function appendReasoningRound(accumulated: string[], reasoning: ChatV2ReasoningOutput | undefined) {
  const roundReasoning = Array.isArray(reasoning) ? reasoning : [reasoning];
  const nonEmptyReasoning = roundReasoning
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (nonEmptyReasoning.length === 0) {
    return;
  }

  accumulated.push(...nonEmptyReasoning);
}

function applyAccumulatedReasoning(
  result: ChatV2PipelineResult,
  reasoningRounds: string[],
  outputReasoning: boolean | undefined,
) {
  if (reasoningRounds.length === 0) {
    return;
  }

  const reasoning = [...reasoningRounds];
  result.reasoning = reasoning;

  if (outputReasoning) {
    result.commonOutputs['reasoning' as PortId] = {
      type: 'string[]',
      value: reasoning,
    };
  }
}

export async function runChatV2PipelineWithToolContinuation(
  options: ToolContinuationOptions,
): Promise<ChatV2PipelineResult> {
  const {
    autoContinue,
    maxToolRounds,
    functions,
    delegateToolCall,
    delegateToolCallRound,
    runPipeline = runChatV2Pipeline,
    ...pipelineOptions
  } = options;
  const toolNames = getToolNames(functions);
  const maxRounds = Math.max(1, Math.floor(Number.isFinite(maxToolRounds) ? maxToolRounds : 1));

  let currentPrompt = pipelineOptions.prompt;
  let currentSystemPrompt = pipelineOptions.systemPrompt;
  const delegatedToolCalls: DelegatedToolCallRecord[] = [];
  let accumulatedUsage: ChatV2NormalizedUsage | undefined;
  const reasoningRounds: string[] = [];

  for (let completedRounds = 0; ; completedRounds++) {
    const result = await runPipeline({
      ...pipelineOptions,
      functions,
      prompt: currentPrompt,
      systemPrompt: currentSystemPrompt,
    });
    accumulatedUsage = autoContinue ? addUsage(accumulatedUsage, result.usage) : undefined;
    if (autoContinue) {
      appendReasoningRound(reasoningRounds, result.reasoning);
    }

    if (!autoContinue || completedRounds >= maxRounds || !canAutoContinue(result.functionCalls, toolNames)) {
      if (result.functionCalls.length === 0 && delegatedToolCalls.length > 0 && pipelineOptions.includeFunctionCalls) {
        result.commonOutputs['function-calls' as PortId] = {
          type: 'object[]',
          value: delegatedToolCalls,
        };
      }

      if (autoContinue) {
        applyAccumulatedUsage(result, accumulatedUsage, pipelineOptions.outputUsage);
        applyAccumulatedReasoning(result, reasoningRounds, pipelineOptions.outputReasoning);
      }

      return result;
    }

    const toolResultMessages = delegateToolCallRound
      ? await delegateToolCallRound(result.functionCalls, result.response)
      : await Promise.all(result.functionCalls.map(delegateToolCall));
    delegatedToolCalls.push(
      ...toolResultMessages
        .map((message) => message.delegatedToolCall)
        .filter((record): record is DelegatedToolCallRecord => record != null),
    );

    if (shouldReturnToolResultDirectly(result.functionCalls, functions)) {
      const directResultMessage = toolResultMessages[0]?.value;
      if (directResultMessage?.type !== 'function' || typeof directResultMessage.message !== 'string') {
        throw new Error('Return directly requires the delegated tool handler to return a string output.');
      }

      result.response = directResultMessage.message;
      result.allMessages = [...result.allMessages, directResultMessage];
      result.functionCalls = [];
      result.commonOutputs['response' as PortId] = {
        type: 'string',
        value: result.response,
      };
      result.commonOutputs['all-messages' as PortId] = {
        type: 'chat-message[]',
        value: result.allMessages,
      };

      if (pipelineOptions.includeFunctionCalls) {
        result.commonOutputs['function-calls' as PortId] = {
          type: 'object[]',
          value: delegatedToolCalls,
        };
      }

      applyAccumulatedUsage(result, accumulatedUsage, pipelineOptions.outputUsage);
      applyAccumulatedReasoning(result, reasoningRounds, pipelineOptions.outputReasoning);
      return result;
    }

    currentPrompt = {
      type: 'chat-message[]',
      value: [...result.allMessages, ...toolResultMessages.map((message) => message.value)],
    };
    currentSystemPrompt = undefined;
  }
}
