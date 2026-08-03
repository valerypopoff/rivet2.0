import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2PipelineResult } from './chatV2Types.js';
import { isChatV2PipelineProviderFailureResult } from './chatV2Pipeline.js';
import type { LLMChatV2RuntimeConfig } from './llmChatV2NodeRuntime.js';
import { cloneLLMChatV2EditorCacheOutputs } from './chatV2EditorCache.js';
import { compactLLMProfileRequestErrors, compactLLMProfileRequestStatuses } from './llmProfileFallback.js';

/** Projects cache hits as current-run output without inventing provider work. */
export function projectLLMChatV2EditorCacheHit(runtime: LLMChatV2RuntimeConfig): Outputs | undefined {
  const outputs = runtime.cachedOutputs;
  if (outputs == null) return undefined;
  // Normalize entries created before compact profile diagnostics were
  // introduced. This is presentation-only and leaves the cached Response
  // payload intact.
  if (runtime.profileChainUsesArray) {
    const status = outputs['requestStatus' as PortId];
    if (status?.type === 'any' && Array.isArray(status.value)) {
      status.value = compactLLMProfileRequestStatuses(status.value);
    }
    const error = outputs['requestError' as PortId];
    if (error?.type === 'any' && Array.isArray(error.value)) {
      error.value = compactLLMProfileRequestErrors(error.value);
    }
  }
  if (runtime.profileAttempts != null) {
    outputs['llmProfileAttempts' as PortId] = { type: 'object[]', value: [] };
    outputs['llmProfileSummary' as PortId] = {
      type: 'string',
      value: 'Editor cache hit — no LLM Profile calls were made for this run.',
    };
  }
  return outputs;
}

/**
 * Caches only final model answers. Provider failures can deliberately be
 * returned as ordinary diagnostic outputs, but replaying one would turn a
 * transient outage into stale editor state and prevent the next run from
 * reaching the provider or a now-healthy fallback profile.
 */
export function writeLLMChatV2EditorCache(params: {
  runtime: LLMChatV2RuntimeConfig;
  result: ChatV2PipelineResult;
}): void {
  const { runtime, result } = params;
  if (
    runtime.cacheKey == null ||
    runtime.editorCache == null ||
    runtime.isProfileFallbackExhausted() ||
    isChatV2PipelineProviderFailureResult(result)
  ) {
    return;
  }
  const cacheOutputs = cloneLLMChatV2EditorCacheOutputs(result.commonOutputs);
  delete cacheOutputs['llmProfileAttempts' as PortId];
  delete cacheOutputs['llmProfileSummary' as PortId];
  runtime.editorCache.set(runtime.cacheKey, cacheOutputs);
}
