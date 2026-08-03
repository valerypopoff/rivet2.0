import type { StreamedFunctionCall } from '../chat/streamChatResponse.js';
import type { ToolContinuationToolResult } from './toolContinuation.js';

/** Provider-neutral contract for one complete model tool-call round. */
export type ToolRoundExecutor = {
  executeRound(params: {
    calls: readonly StreamedFunctionCall[];
    assistantMessage: string;
  }): Promise<readonly ToolContinuationToolResult[]>;
};

/**
 * Adapts the legacy individual/round callbacks without changing their
 * concurrency semantics: a connected host owns a full round; internal
 * delegation starts independent calls in parallel.
 */
export function createCallbackToolRoundExecutor(params: {
  delegateOne: (call: StreamedFunctionCall) => Promise<ToolContinuationToolResult>;
  delegateRound?:
    | ((calls: StreamedFunctionCall[], assistantMessage: string) => Promise<ToolContinuationToolResult[]>)
    | undefined;
}): ToolRoundExecutor {
  return {
    executeRound: ({ calls, assistantMessage }) =>
      params.delegateRound
        ? params.delegateRound([...calls], assistantMessage)
        : Promise.all(calls.map((call) => params.delegateOne(call))),
  };
}
