import type { ChatV2PipelineResult } from './chatV2Types.js';
import type { LLMChatV2RuntimeConfig } from './llmChatV2NodeRuntime.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { ToolCallContinuation } from '../ToolCallContinuation.js';
import type { PortId } from '../NodeBase.js';
import { delegateToolCall } from '../nodes/toolCallDelegation.js';
import { runChatV2PipelineWithToolContinuation } from './toolContinuation.js';
import type { LLMInvocationJournal } from './llmInvocationJournal.js';
import { isChatV2PipelineProviderFailureResult } from './chatV2Pipeline.js';

/**
 * Owns the LLM-level recovery and continuation decision boundary. The node
 * boundary provides a resolved runtime and GraphProcessor supplies only the
 * connected Delegate host; no graph scheduling policy lives here.
 */
export async function executeLLMInvocation(params: {
  context: InternalProcessContext;
  journal: LLMInvocationJournal;
  runtime: LLMChatV2RuntimeConfig;
  toolCallContinuation: ToolCallContinuation | undefined;
}): Promise<ChatV2PipelineResult> {
  const { context, journal, runtime, toolCallContinuation } = params;
  try {
    const result = runtime.shouldAutoContinueToolCalls
      ? await runChatV2PipelineWithToolContinuation({
          ...runtime.runOptions,
          autoContinue: true,
          maxToolRounds: runtime.maxToolRounds,
          functions: runtime.functions,
          delegateToolCallRound: toolCallContinuation
            ? async (toolCalls, preToolMessage) => {
                const results = await toolCallContinuation.run(toolCalls, preToolMessage);
                journal.recordToolRound({ kind: 'connected', count: results.length });
                return results.map((entry) => ({
                  type: 'chat-message' as const,
                  value: entry.message,
                  delegatedToolCall: entry.record,
                }));
              }
            : undefined,
          delegateToolCall: async (toolCall) => {
            const delegated = await delegateToolCall(toolCall, context, {
              handlers: [],
              unknownHandler: undefined,
              autoDelegate: true,
              fallBackToExternalCall: true,
              passthroughErrors: true,
            });
            journal.recordToolRound({ kind: 'internal', count: 1 });
            return {
              type: 'chat-message',
              value: delegated.message,
              delegatedToolCall: delegated.record,
            };
          },
          runPipeline: runtime.runPipeline,
        })
      : await runtime.runPipeline(runtime.runOptions);

    journal.recordTerminal({
      kind:
        isChatV2PipelineProviderFailureResult(result) ||
        // Keep pre-refactor result fixtures and third-party callers that use
        // the established excluded-output failure surface observable too.
        result.commonOutputs['response' as PortId]?.type === 'control-flow-excluded'
          ? 'failed'
          : result.functionCalls.length > 0
            ? 'released-unresolved-calls'
            : 'final-model-answer',
    });
    return result;
  } catch (error) {
    journal.recordTerminal({ kind: context.signal.aborted ? 'cancelled' : 'failed' });
    throw error;
  }
}
