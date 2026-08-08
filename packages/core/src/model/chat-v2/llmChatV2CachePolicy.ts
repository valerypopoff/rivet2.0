import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';

export type LLMChatV2EditorCacheEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'disabled' | 'rivet-tools' | 'provider-native-tools';
    };

/**
 * Editor-cache replay is safe only for ordinary deterministic model calls.
 * Tool-capable calls can have side effects or live Delegate run shapes that a
 * cached final output cannot reproduce.
 */
export function getLLMChatV2EditorCacheEligibility(data: LLMChatV2NodeData): LLMChatV2EditorCacheEligibility {
  if (!data.cache) {
    return { eligible: false, reason: 'disabled' };
  }
  if (data.useToolCalling) {
    return { eligible: false, reason: 'rivet-tools' };
  }
  if (
    data.enableOpenAIWebSearch ||
    data.enableOpenAICodeInterpreter ||
    data.enableGoogleSearchGrounding ||
    data.enableGoogleUrlContext
  ) {
    return { eligible: false, reason: 'provider-native-tools' };
  }
  return { eligible: true };
}
