import type { ChatV2PipelineResult } from './chatV2Types.js';
import type { LLMChatV2RuntimeConfig } from './llmChatV2NodeRuntime.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { ToolCallContinuation } from '../ToolCallContinuation.js';
import { delegateToolCall } from '../nodes/toolCallDelegation.js';
import {
  runChatV2PipelineWithToolContinuation,
  type LLMChatOutputSnapshotDescriptor,
} from './toolContinuation.js';
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
}): Promise<{ result: ChatV2PipelineResult; terminalSnapshot?: LLMChatOutputSnapshotDescriptor }> {
  const { context, journal, runtime, toolCallContinuation } = params;
  try {
    let terminalSnapshot: LLMChatOutputSnapshotDescriptor | undefined;
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
          onCompletedModelRound: (snapshot) => {
            try {
              const observerResult = context.onLLMChatOutputSnapshot?.({
                ...snapshot,
                nodeId: context.node.id,
                processId: context.processId,
                splitIndex: context.splitIndex ?? 0,
              });
              // GraphProcessor already isolates its own observer. Preserve the
              // same guarantee for direct node callers that provide an async
              // observer themselves.
              void Promise.resolve(observerResult).catch(() => undefined);
            } catch {
              // History is observational; snapshot delivery cannot affect a graph run.
            }
          },
          onTerminalRound: (snapshot) => {
            terminalSnapshot = snapshot;
          },
        })
      : await runtime.runPipeline(runtime.runOptions);

    if (!runtime.shouldAutoContinueToolCalls && !isChatV2PipelineProviderFailureResult(result)) {
      terminalSnapshot = {
        entryId: 'model-round:0',
        roundIndex: 0,
        kind: 'model-round',
        outcome: result.functionCalls.length > 0 ? 'unresolved-tool-calls' : 'final-answer',
      };
    }

    journal.recordTerminal({
      kind: isChatV2PipelineProviderFailureResult(result)
        ? 'failed'
        : result.functionCalls.length > 0
          ? 'released-unresolved-calls'
          : 'final-model-answer',
    });
    return { result, terminalSnapshot };
  } catch (error) {
    journal.recordTerminal({ kind: context.signal.aborted ? 'cancelled' : 'failed' });
    throw error;
  }
}
