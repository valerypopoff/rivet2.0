import type { StreamedFunctionCall } from '../chat/streamChatResponse.js';

export type LLMInvocationRoundDecision =
  | { kind: 'final-model-answer' }
  | { kind: 'delegate-tools' }
  | { kind: 'release-unresolved-calls' }
  | { kind: 'max-rounds-reached' }
  | { kind: 'direct-tool-response' };

/** Pure terminal/continuation policy, intentionally independent of scheduling. */
export function decideLLMInvocationRound(params: {
  autoContinue: boolean;
  completedRounds: number;
  maxToolRounds: number;
  calls: readonly StreamedFunctionCall[];
  knownToolNames: ReadonlySet<string>;
  isDirectReturn: boolean;
}): LLMInvocationRoundDecision {
  if (params.calls.length === 0) return { kind: 'final-model-answer' };
  if (!params.autoContinue || !params.calls.every((call) => params.knownToolNames.has(call.name))) {
    return { kind: 'release-unresolved-calls' };
  }
  if (params.completedRounds >= params.maxToolRounds) return { kind: 'max-rounds-reached' };
  return params.isDirectReturn ? { kind: 'direct-tool-response' } : { kind: 'delegate-tools' };
}
