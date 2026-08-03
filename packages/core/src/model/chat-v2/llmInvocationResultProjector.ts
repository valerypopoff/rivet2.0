import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import type { LLMProfileAttempt } from './llmProfileFallback.js';
import { projectLLMInvocationUsage, projectLLMProfileRequestDiagnostics } from './llmInvocationProjections.js';
import type { ChatV2PipelineResult } from './chatV2Types.js';

/** Applies existing public LLM Chat output shapes from invocation facts. */
export function projectLLMInvocationResult(params: {
  result: ChatV2PipelineResult;
  modelCalls: readonly ChatV2CallFinishedEvent[];
  outputUsage: boolean | undefined;
  outputRequestStatus: boolean | undefined;
  outputRequestError: boolean;
  profileAttempts?: readonly LLMProfileAttempt[] | undefined;
  profileChainLength?: number | undefined;
  profileChainUsesArray: boolean;
  profileSummary?: string | undefined;
}): Outputs {
  const {
    result,
    modelCalls,
    outputUsage,
    outputRequestStatus,
    outputRequestError,
    profileAttempts,
    profileChainLength,
    profileChainUsesArray,
    profileSummary,
  } = params;

  if (outputUsage && modelCalls.length > 0) {
    const physicalUsage = projectLLMInvocationUsage(modelCalls);
    if (physicalUsage != null) {
      result.usage = physicalUsage;
      result.commonOutputs['usage' as PortId] = { type: 'object', value: physicalUsage };
    }
  }

  if (profileAttempts == null) {
    return result.commonOutputs;
  }

  result.commonOutputs['llmProfileAttempts' as PortId] = {
    type: 'object[]',
    value: [...profileAttempts],
  };
  result.commonOutputs['llmProfileSummary' as PortId] = {
    type: 'string',
    value: profileSummary ?? '',
  };

  if (profileChainUsesArray && profileChainLength != null) {
    const diagnostics = projectLLMProfileRequestDiagnostics({
      profileCount: profileChainLength,
      attempts: profileAttempts,
    });
    if (outputRequestStatus) {
      result.commonOutputs['requestStatus' as PortId] = { type: 'any', value: diagnostics.statuses };
    }
    if (outputRequestError) {
      result.commonOutputs['requestError' as PortId] = { type: 'any', value: diagnostics.errors };
    }
  }

  return result.commonOutputs;
}
