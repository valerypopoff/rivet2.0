import type { ChatMessageDataValue, GptFunction } from '../DataValue.js';
import type {
  ChatV2NormalizedUsage,
  ChatV2PipelineResult,
  ChatV2PipelineRoundOptions,
  ChatV2ReasoningOutput,
} from './chatV2Types.js';
import type { StreamedFunctionCall } from '../chat/streamChatResponse.js';
import type { DelegatedToolCallRecord } from '../nodes/toolCallDelegation.js';
import type { PortId } from '../NodeBase.js';
import { createRivetToolRegistry } from './rivetToolRegistry.js';
import { materializeLLMResponse } from './llmResponseMaterializer.js';
import { createCallbackToolRoundExecutor, type ToolRoundExecutor } from './toolRoundExecutor.js';
import { decideLLMInvocationRound } from './llmInvocationDecision.js';
import { isChatV2PipelineProviderFailureResult } from './chatV2Pipeline.js';

export type ToolContinuationOptions = ChatV2PipelineRoundOptions & {
  autoContinue: boolean;
  maxToolRounds: number;
  functions: GptFunction[] | undefined;
  delegateToolCall: (toolCall: StreamedFunctionCall) => Promise<ToolContinuationToolResult>;
  delegateToolCallRound?: (
    toolCalls: StreamedFunctionCall[],
    preToolMessage: string,
  ) => Promise<ToolContinuationToolResult[]>;
  runPipeline: (options: ChatV2PipelineRoundOptions) => Promise<ChatV2PipelineResult>;
};

export type ToolContinuationToolResult = ChatMessageDataValue & {
  delegatedToolCall?: DelegatedToolCallRecord;
};

function shouldReturnToolResultDirectly(
  functionCalls: StreamedFunctionCall[],
  registry: ReturnType<typeof createRivetToolRegistry>,
): boolean {
  if (functionCalls.length !== 1) {
    return false;
  }
  return registry.byName.get(functionCalls[0]!.name)?.resultHandling === 'return-direct';
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

function applyTerminalContinuationOutputs(
  result: ChatV2PipelineResult,
  delegatedToolCalls: readonly DelegatedToolCallRecord[],
  accumulatedUsage: ChatV2NormalizedUsage | undefined,
  reasoningRounds: string[],
  options: Pick<ToolContinuationOptions, 'autoContinue' | 'outputUsage' | 'outputReasoning' | 'includeFunctionCalls'>,
): void {
  if (result.functionCalls.length === 0 && delegatedToolCalls.length > 0 && options.includeFunctionCalls) {
    result.commonOutputs['function-calls' as PortId] = {
      type: 'object[]',
      value: [...delegatedToolCalls],
    };
  }

  if (options.autoContinue) {
    applyAccumulatedUsage(result, accumulatedUsage, options.outputUsage);
    applyAccumulatedReasoning(result, reasoningRounds, options.outputReasoning);
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
    runPipeline,
    ...pipelineOptions
  } = options;
  const toolRegistry = createRivetToolRegistry(functions);
  const toolRoundExecutor: ToolRoundExecutor = createCallbackToolRoundExecutor({
    delegateOne: delegateToolCall,
    delegateRound: delegateToolCallRound,
  });
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
      roundIndex: completedRounds,
      systemPrompt: currentSystemPrompt,
    });
    accumulatedUsage = autoContinue ? addUsage(accumulatedUsage, result.usage) : undefined;
    if (autoContinue) {
      appendReasoningRound(reasoningRounds, result.reasoning);
    }

    // Request diagnostics can preserve partial provider content on a failed
    // HTTP response. That content is for inspection only: it is not a valid
    // assistant tool request and must never trigger a handler side effect.
    if (isChatV2PipelineProviderFailureResult(result)) {
      applyTerminalContinuationOutputs(result, delegatedToolCalls, accumulatedUsage, reasoningRounds, {
        autoContinue,
        outputUsage: pipelineOptions.outputUsage,
        outputReasoning: pipelineOptions.outputReasoning,
        includeFunctionCalls: pipelineOptions.includeFunctionCalls,
      });
      return result;
    }

    const decision = decideLLMInvocationRound({
      autoContinue,
      completedRounds,
      maxToolRounds: maxRounds,
      calls: result.functionCalls,
      knownToolNames: toolRegistry.names,
      isDirectReturn: shouldReturnToolResultDirectly(result.functionCalls, toolRegistry),
    });
    if (
      decision.kind === 'final-model-answer' ||
      decision.kind === 'release-unresolved-calls' ||
      decision.kind === 'max-rounds-reached'
    ) {
      applyTerminalContinuationOutputs(result, delegatedToolCalls, accumulatedUsage, reasoningRounds, {
        autoContinue,
        outputUsage: pipelineOptions.outputUsage,
        outputReasoning: pipelineOptions.outputReasoning,
        includeFunctionCalls: pipelineOptions.includeFunctionCalls,
      });

      return result;
    }

    const toolResultMessages = await toolRoundExecutor.executeRound({
      calls: result.functionCalls,
      assistantMessage: result.response,
    });
    delegatedToolCalls.push(
      ...toolResultMessages
        .map((message) => message.delegatedToolCall)
        .filter((record): record is DelegatedToolCallRecord => record != null),
    );

    if (decision.kind === 'direct-tool-response') {
      const directResultMessage = toolResultMessages[0]?.value;
      if (directResultMessage?.type !== 'function' || typeof directResultMessage.message !== 'string') {
        throw new Error('Return directly requires the delegated tool handler to return a string output.');
      }

      result.response = directResultMessage.message;
      const materializedDirectResponse = materializeLLMResponse({
        rawText: result.response,
        structuredOutput: undefined,
        responseFormat: pipelineOptions.responseFormat,
      });
      if (materializedDirectResponse.validation === 'invalid') {
        throw new Error(
          'Return directly tool handler response validation failed.\n' +
            'Response format: JSON schema\n' +
            `Parsed Response type: ${materializedDirectResponse.value.type}\n` +
            'A direct tool result is terminal and is not retried or sent to another LLM profile.',
        );
      }
      result.allMessages = [...result.allMessages, directResultMessage];
      result.functionCalls = [];
      result.commonOutputs['response' as PortId] = {
        ...materializedDirectResponse.value,
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
