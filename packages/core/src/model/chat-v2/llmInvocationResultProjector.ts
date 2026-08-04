import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import type { LLMAttempt } from './llmProfileFallback.js';
import { projectLLMInvocationUsage } from './llmInvocationProjections.js';
import type { ChatV2PipelineResult } from './chatV2Types.js';

/** Applies existing public LLM Chat output shapes from invocation facts. */
export function projectLLMInvocationResult(params: {
  result: ChatV2PipelineResult;
  modelCalls: readonly ChatV2CallFinishedEvent[];
  outputUsage: boolean | undefined;
  outputLLMAttempts: boolean | undefined;
  llmAttempts: readonly LLMAttempt[];
  profileSummary?: string | undefined;
}): Outputs {
  const {
    result,
    modelCalls,
    outputUsage,
    outputLLMAttempts,
    llmAttempts,
    profileSummary,
  } = params;

  if (outputUsage && modelCalls.length > 0) {
    const physicalUsage = projectLLMInvocationUsage(modelCalls);
    if (physicalUsage != null) {
      result.usage = physicalUsage;
      result.commonOutputs['usage' as PortId] = { type: 'object', value: physicalUsage };
    }
  }

  if (outputLLMAttempts) {
    result.commonOutputs['llmAttempts' as PortId] = {
      type: 'object[]',
      value: [...llmAttempts],
    };
  }

  if (profileSummary != null) {
    result.commonOutputs['llmProfileSummary' as PortId] = {
      type: 'string',
      value: profileSummary,
    };
  }

  return result.commonOutputs;
}
