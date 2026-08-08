import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2PipelineResult } from './chatV2Types.js';
import { isChatV2PipelineProviderFailureResult } from './chatV2Pipeline.js';
import type { LLMChatV2RuntimeConfig } from './llmChatV2NodeRuntime.js';
import { cloneLLMChatV2EditorCacheOutputs } from './chatV2EditorCache.js';

/** Projects cache hits as current-run output without inventing provider work. */
export function projectLLMChatV2EditorCacheHit(runtime: LLMChatV2RuntimeConfig): Outputs | undefined {
  const outputs = runtime.cachedOutputs;
  if (outputs == null) return undefined;

  if (runtime.getProfileSummary != null) {
    outputs['llmProfileSummary' as PortId] = {
      type: 'string',
      value: 'Editor cache hit — no LLM Profile calls were made for this run.',
    };
  }
  if (runtime.outputLLMAttempts) {
    outputs['llmAttempts' as PortId] = { type: 'object[]', value: [] };
  }
  return outputs;
}

/** Caches only final model answers; failed invocations never reach this boundary. */
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
  delete cacheOutputs['llmAttempts' as PortId];
  delete cacheOutputs['llmProfileSummary' as PortId];
  runtime.editorCache.set(runtime.cacheKey, cacheOutputs);
}
