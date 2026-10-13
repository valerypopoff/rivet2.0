import { randomUUID } from 'node:crypto';
import {
  createHostedRuntimeOptions,
  type HostedRuntimeDependencies,
} from '../routes/workflows/hosted-runtime-policy.js';
import { ExecutionSession } from '../routes/workflows/execution-session.js';

import {
  createProcessor,
  deserializeDatasets,
  type ExecutionRecorder,
  NodeDatasetProvider,
  type LooseDataValue,
} from '@valerypopoff/rivet2-node';
import {
  assertPortableJson,
  createEvaluationEventCollector,
  EvaluationGraphExecutionError,
  type EvaluationRecordingReference,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';

import type { RivetStudioLLMProfileHealthStore } from '../llm-profile-health/store.js';
import type { RivetStudioEvaluationStore } from './store.js';
import type { HostedEvaluationGraphRunner } from './hosted-coordinator.js';

type HostedEvaluationExecutionDependencies = {
  evaluationStore: Pick<RivetStudioEvaluationStore, 'putRecording'>;
  llmProfileHealthStore: RivetStudioLLMProfileHealthStore | undefined;
  createSubgraphProjectLoader?: HostedRuntimeDependencies['createSubgraphProjectLoader'];
  createProjectReferenceLoader(): Promise<NonNullable<Parameters<typeof createProcessor>[1]['projectReferenceLoader']>>;
};

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
    const captured = createEvaluationEventCollector('full');
    let recorder: ExecutionRecorder | undefined;
    const reference = createTemporaryReference();
    let persistedReference: EvaluationRecordingReference | undefined;
    let processor: ReturnType<typeof createProcessor> | undefined;
    let session: ExecutionSession | undefined;

    const persistRecording = async (): Promise<EvaluationRecordingReference | undefined> => {
      if (!recorder || recorder.events.length === 0) return undefined;
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
      const runtime = await createHostedRuntimeOptions(
        {
          abortSignal: signal,
          projectPath,
          datasetProvider: new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []),
        },
        {
          createProjectReferenceLoader: dependencies.createProjectReferenceLoader,
          createSubgraphProjectLoader: dependencies.createSubgraphProjectLoader,
          getProfileHealth: async () => dependencies.llmProfileHealthStore,
        },
      );
      processor = createProcessor(project, {
        ...runtime,
        graph: graphId,
        inputs: toLooseInputValues(inputs),
        context: toLooseContextValues(contextValues),
        evaluation: metadata,
      });
      processor.processor.on('llmCallFinished', captured.llmCallFinished);
      processor.processor.on('llmProfileAttempt', captured.llmProfileAttempt);
      processor.processor.on('toolCallFinished', captured.toolCallFinished);
      session = new ExecutionSession(processor, { recording: true });
      recorder = session.recorder!;
      const outcome = await session.run();
      if (outcome.failure) throw outcome.failure.error;
      const outputs = outcome.outputs!;
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
      // The session owns disposal once constructed, including late failures.
      if (!session) processor?.dispose();
    }
  };
}
