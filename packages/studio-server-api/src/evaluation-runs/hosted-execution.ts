import { randomUUID } from 'node:crypto';

import {
  createProcessor,
  deserializeDatasets,
  ExecutionRecorder,
  NodeDatasetProvider,
  type LooseDataValue,
  type ProcessEventMessageMap,
} from '@valerypopoff/rivet2-node';
import {
  assertPortableJson,
  EvaluationGraphExecutionError,
  type EvaluationExecutionMetrics,
  type EvaluationRecordingReference,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';

import { readExecutionEnvironmentVariables } from '../environment-variable-settings.js';
import { ManagedCodeRunner } from '../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../runtime-libraries/manifest.js';
import type { PostgresRivetLLMProfileHealthStore } from '../llm-profile-health/managed-store.js';
import type { PostgresRivetEvaluationStore } from './managed-store.js';
import type { HostedEvaluationGraphRunner } from './hosted-coordinator.js';

type HostedEvaluationExecutionDependencies = {
  evaluationStore: PostgresRivetEvaluationStore;
  llmProfileHealthStore: PostgresRivetLLMProfileHealthStore;
  createProjectReferenceLoader(): Promise<NonNullable<Parameters<typeof createProcessor>[1]['projectReferenceLoader']>>;
};

type CapturedMetrics = {
  metrics: EvaluationExecutionMetrics;
  providerAttempts: PortableJson[];
};

function createCapturedMetrics(): CapturedMetrics {
  return {
    metrics: { durationMs: 0, modelCallCount: 0, toolCallCount: 0, toolFailureCount: 0 },
    providerAttempts: [],
  };
}

function captureEvent(
  captured: CapturedMetrics,
  message: 'llmCallFinished' | 'llmProfileAttempt' | 'toolCallFinished',
  data: unknown,
): void {
  if (message === 'llmCallFinished') {
    const event = data as ProcessEventMessageMap['llmCallFinished'];
    captured.metrics.modelCallCount = (captured.metrics.modelCallCount ?? 0) + 1;
    captured.metrics.inputTokens = (captured.metrics.inputTokens ?? 0) + (event.normalizedUsage?.promptTokens ?? 0);
    captured.metrics.outputTokens =
      (captured.metrics.outputTokens ?? 0) + (event.normalizedUsage?.completionTokens ?? 0);
    captured.metrics.cachedInputTokens =
      (captured.metrics.cachedInputTokens ?? 0) + (event.normalizedUsage?.cachedTokens ?? 0);
    captured.metrics.reasoningTokens =
      (captured.metrics.reasoningTokens ?? 0) + (event.normalizedUsage?.reasoningTokens ?? 0);
    if (event.pricing.status === 'known')
      captured.metrics.costUsd = (captured.metrics.costUsd ?? 0) + (event.pricing.costUsd ?? 0);
    else captured.metrics.hasUnknownCost = true;
    captured.providerAttempts.push({
      kind: 'provider-call',
      provider: event.provider,
      model: event.model,
      customProviderApi: event.customProviderApi ?? null,
      outcome: event.outcome,
      finishReason: event.finishReason ?? null,
      profileIndex: event.profileIndex ?? null,
      profileName: event.profileName ?? null,
      attemptIndex: event.attemptIndex,
      roundIndex: event.roundIndex ?? null,
      durationMs: event.durationMs ?? null,
    });
    return;
  }
  if (message === 'llmProfileAttempt') {
    const event = data as ProcessEventMessageMap['llmProfileAttempt'];
    captured.providerAttempts.push({
      kind: 'profile-decision',
      provider: event.provider,
      model: event.model,
      customProviderApi: event.customProviderApi ?? null,
      stage: event.stage,
      outcome: event.outcome,
      profileIndex: event.profileIndex ?? null,
      profileName: event.profileName ?? null,
      attemptIndex: event.attemptIndex ?? null,
      roundIndex: event.roundIndex,
      status: event.status ?? null,
      healthState: event.healthState ?? null,
      healthDisposition: event.healthDisposition ?? null,
      timeoutKind: event.timeoutKind ?? null,
    });
    return;
  }
  const event = data as ProcessEventMessageMap['toolCallFinished'];
  captured.metrics.toolCallCount = (captured.metrics.toolCallCount ?? 0) + 1;
  if (event.outcome !== 'success') captured.metrics.toolFailureCount = (captured.metrics.toolFailureCount ?? 0) + 1;
}

function toLooseInputValues(values: Record<string, PortableJson>): Record<string, LooseDataValue> {
  // Evaluation datasets carry raw portable values. Always wrap them, even when
  // a user value happens to look like a Rivet DataValue object.
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'any', value }]));
}

function toLooseContextValues(values: Record<string, PortableJson>): Record<string, LooseDataValue> {
  // Project context is serialized from actual Rivet DataValues. Preserve that
  // envelope rather than accidentally wrapping it a second time.
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value as LooseDataValue]));
}

function createTemporaryReference(): EvaluationRecordingReference {
  return {
    id: `evaluation-hosted-${randomUUID()}`,
    retention: 'temporary',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Runs an immutable snapshot with exactly the same Node GraphProcessor used by
 * published workflows. The only persistence it owns is the per-graph replay
 * artifact; the coordinator owns durable trial state and quality projection.
 */
export function createHostedEvaluationGraphRunner(
  dependencies: HostedEvaluationExecutionDependencies,
): HostedEvaluationGraphRunner {
  return async ({ project, graphId, inputs, signal, metadata, projectPath, datasetsContents, contextValues }) => {
    const startedAt = Date.now();
    const captured = createCapturedMetrics();
    const recorder = new ExecutionRecorder();
    const reference = createTemporaryReference();
    let persistedReference: EvaluationRecordingReference | undefined;
    let processor: ReturnType<typeof createProcessor> | undefined;

    const persistRecording = async (): Promise<EvaluationRecordingReference | undefined> => {
      if (recorder.events.length === 0) return undefined;
      await dependencies.evaluationStore.putRecording({
        projectId: project.metadata.id,
        runId: metadata.evaluationRunId,
        trialId: `${metadata.caseId}:${metadata.trialIndex}:${metadata.phase}`,
        reference,
        serialized: recorder.serialize(),
        createdAt: new Date().toISOString(),
      });
      persistedReference = reference;
      return reference;
    };

    try {
      signal?.throwIfAborted();
      processor = createProcessor(project, {
        graph: graphId,
        inputs: toLooseInputValues(inputs),
        context: toLooseContextValues(contextValues),
        abortSignal: signal,
        codeRunner: new ManagedCodeRunner(getRootPath(), {
          executionEnvironment: await readExecutionEnvironmentVariables(),
        }) as any,
        projectPath,
        projectReferenceLoader: await dependencies.createProjectReferenceLoader(),
        datasetProvider: new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []),
        llmProfileHealthStore: dependencies.llmProfileHealthStore,
        evaluation: metadata,
      });
      processor.processor.on('llmCallFinished', (event) => captureEvent(captured, 'llmCallFinished', event));
      processor.processor.on('llmProfileAttempt', (event) => captureEvent(captured, 'llmProfileAttempt', event));
      processor.processor.on('toolCallFinished', (event) => captureEvent(captured, 'toolCallFinished', event));
      recorder.record(processor.processor);

      const outputs = await processor.run();
      captured.metrics.durationMs = Date.now() - startedAt;
      const portableOutputs = Object.fromEntries(
        Object.entries(outputs).map(([key, value]) => {
          assertPortableJson(value.value, `graph output ${key}`);
          return [key, value.value];
        }),
      );
      await persistRecording();
      return {
        outputs: portableOutputs,
        metrics: captured.metrics,
        ...(persistedReference === undefined ? {} : { recording: persistedReference }),
        ...(captured.providerAttempts.length === 0 ? {} : { providerAttempts: captured.providerAttempts }),
      };
    } catch (error) {
      captured.metrics.durationMs = Math.max(captured.metrics.durationMs, Date.now() - startedAt);
      await persistRecording().catch((recordingError) => {
        console.warn('[hosted-evaluations] Failed to persist graph recording:', recordingError);
      });
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new EvaluationGraphExecutionError(error instanceof Error ? error.message : String(error), {
        metrics: captured.metrics,
        ...(persistedReference === undefined ? {} : { recording: persistedReference }),
        ...(captured.providerAttempts.length === 0 ? {} : { providerAttempts: captured.providerAttempts }),
      });
    } finally {
      processor?.dispose();
    }
  };
}
