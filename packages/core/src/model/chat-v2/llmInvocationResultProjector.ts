import type { Outputs } from '../GraphProcessor.js';
import type { PortId } from '../NodeBase.js';
import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import type { LLMAttempt } from './llmProfileFallback.js';
import { projectLLMInvocationUsage } from './llmInvocationProjections.js';
import { createChatV2CapturedBodyOutputs } from './chatV2Outputs.js';
import type { ChatV2PipelineResult, ChatV2PipelineRoundOptions } from './chatV2Types.js';

type LLMInvocationDiagnosticProjectionOptions = {
  runOptions: Pick<
    ChatV2PipelineRoundOptions,
    'requestBodies' | 'responseBodies' | 'outputRequestBody' | 'outputResponseBody'
  >;
  outputLLMAttempts: boolean | undefined;
  modelCalls: readonly ChatV2CallFinishedEvent[];
  outputUsage: boolean | undefined;
  llmAttempts: readonly LLMAttempt[];
  profileSummary?: string | undefined;
};

/**
 * Projects invocation facts that remain useful even when the node fails.
 * Captured HTTP bodies are emitted only through their opt-in ports, while
 * attempts and profile summaries retain the same public shapes as a success.
 */
export function projectLLMInvocationDiagnostics({
  runOptions,
  outputLLMAttempts,
  modelCalls,
  outputUsage,
  llmAttempts,
  profileSummary,
}: LLMInvocationDiagnosticProjectionOptions): Outputs {
  const capturedBodies = createChatV2CapturedBodyOutputs(runOptions);

  return {
    ...Object.fromEntries(
      Object.entries(capturedBodies).filter(([, output]) => output?.type !== 'control-flow-excluded'),
    ),
    ...projectLLMInvocationUsageOutput({ modelCalls, outputUsage }),
    ...projectLLMInvocationMetadata({ outputLLMAttempts, llmAttempts, profileSummary }),
  };
}

/** Combines streamed response state with terminal diagnostics without hiding either. */
export function mergeLLMInvocationFailureOutputs(
  partialOutputs: Outputs | undefined,
  diagnostics: Outputs,
): Outputs {
  return { ...partialOutputs, ...diagnostics };
}

function projectLLMInvocationMetadata(params: {
  outputLLMAttempts: boolean | undefined;
  llmAttempts: readonly LLMAttempt[];
  profileSummary?: string | undefined;
}): Outputs {
  const { outputLLMAttempts, llmAttempts, profileSummary } = params;
  const outputs: Outputs = {};

  if (outputLLMAttempts) {
    outputs['llmAttempts' as PortId] = {
      type: 'object[]',
      value: [...llmAttempts],
    };
  }

  if (profileSummary != null) {
    outputs['llmProfileSummary' as PortId] = {
      type: 'string',
      value: profileSummary,
    };
  }

  return outputs;
}

/** Applies existing public LLM Chat output shapes from invocation facts. */
export function projectLLMInvocationResult(params: {
  result: ChatV2PipelineResult;
  modelCalls: readonly ChatV2CallFinishedEvent[];
  outputUsage: boolean | undefined;
  outputLLMAttempts: boolean | undefined;
  llmAttempts: readonly LLMAttempt[];
  profileSummary?: string | undefined;
}): Outputs {
  const { result, modelCalls, outputUsage, outputLLMAttempts, llmAttempts, profileSummary } = params;

  const usage = getLLMInvocationUsage({ modelCalls, outputUsage });
  if (usage != null) {
    result.usage = usage;
    result.commonOutputs['usage' as PortId] = { type: 'object', value: usage };
  }

  Object.assign(
    result.commonOutputs,
    projectLLMInvocationMetadata({
      outputLLMAttempts,
      llmAttempts,
      profileSummary,
    }),
  );

  return result.commonOutputs;
}

function projectLLMInvocationUsageOutput({
  modelCalls,
  outputUsage,
}: Pick<LLMInvocationDiagnosticProjectionOptions, 'modelCalls' | 'outputUsage'>): Outputs {
  const usage = getLLMInvocationUsage({ modelCalls, outputUsage });
  return usage == null ? {} : { ['usage' as PortId]: { type: 'object', value: usage } };
}

function getLLMInvocationUsage({
  modelCalls,
  outputUsage,
}: Pick<LLMInvocationDiagnosticProjectionOptions, 'modelCalls' | 'outputUsage'>):
  | ReturnType<typeof projectLLMInvocationUsage>
  | undefined {
  if (!outputUsage || modelCalls.length === 0) {
    return undefined;
  }

  return projectLLMInvocationUsage(modelCalls) ?? undefined;
}
