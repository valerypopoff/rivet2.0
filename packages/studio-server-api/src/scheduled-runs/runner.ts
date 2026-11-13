import {
  loadProjectAndAttachedDataFromString,
  type ExecutionRecorder,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type { ScheduledOccurrence } from '../../../studio-server-shared/scheduled-run-types.js';
import { getWorkflowRecordingCreatedAt } from '../../../studio-server-shared/workflow-recording-time.js';
import {
  createExecutionSubgraphProjectLoader,
  persistWorkflowExecutionRecordingWithBackend,
  getLLMProfileHealthStore,
} from '../routes/workflows/storage-backend.js';
import { createHostedProcessor } from '../routes/workflows/hosted-processor.js';
import { ExecutionSession } from '../routes/workflows/execution-session.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
  shouldSnapshotWorkflowRecordingDatasets,
} from '../routes/workflows/recordings-config.js';
import type { ClaimedRun, ScheduledRunStore } from './store.js';
import { awaitPreparation } from './cancellation.js';
import { reportRecordingFailure, type RecordingDiagnosticContext } from '../routes/workflows/recording-diagnostics.js';
import {
  executionRunEvidenceInput,
  beginRunEvidence,
  unavailableRunEvidence,
} from '../routes/workflows/run-evidence.js';
import type { RunEvidenceHandle } from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';

export async function runScheduledGraph(
  job: ClaimedRun,
  store: ScheduledRunStore,
  owner: string,
  signal: AbortSignal,
): Promise<Partial<ScheduledOccurrence>> {
  const { draft, occurrence } = job;
  signal.throwIfAborted();
  const resolved = await awaitPreparation(
    createExecutionSubgraphProjectLoader().loadTarget({
      projectId: draft.projectId as ProjectId,
      version: draft.version,
    }),
    signal,
  );
  signal.throwIfAborted();
  const graphId = resolved.project.metadata.mainGraphId;
  if (!graphId || !resolved.project.graphs[graphId]) throw new Error('Saved project has no valid main graph.');
  if (!resolved.sourceProjectPath || !resolved.projectContents || !resolved.datasetProvider)
    throw new Error('Saved project snapshot is incomplete.');
  const recording = draft.record && isWorkflowRecordingEnabled();
  const processor = await awaitPreparation(
    createHostedProcessor({
      project: resolved.project,
      datasetProvider: resolved.datasetProvider,
      projectPath: resolved.sourceProjectPath,
      inputs: draft.input === undefined ? {} : { input: { type: 'any', value: draft.input } },
      context: {
        headers: { type: 'any', value: {} },
        schedule: {
          type: 'any',
          value: {
            id: occurrence.scheduleId,
            occurrenceId: occurrence.id,
            scheduledAt: new Date(occurrence.scheduledAt).toISOString(),
          },
        },
      },
      recording,
      correlationId: occurrence.id,
      abortSignal: signal,
    }),
    signal,
    (late) => late.dispose(),
  );
  let recorder: ExecutionRecorder | null = null;
  let createdAt: string | undefined;
  let evidenceHandle: RunEvidenceHandle | undefined;
  let evidenceCompletion: Promise<void> | undefined;
  let executionDurationMs = 0;
  const controller = new AbortController();
  let status: ScheduledOccurrence['status'] = 'succeeded';
  let graphRecordingStatus: 'succeeded' | 'failed' | 'suspicious' = 'failed';
  let reason: string | undefined;
  let invoked = false;
  try {
    // Setup also belongs to the processor's cleanup scope. A recorder/listener
    // failure must not leak a processor prepared before durable acceptance.
    const session = new ExecutionSession(processor, {
      recording,
      recorderOptions: getWorkflowExecutionRecorderOptions(),
      beginEvidence: beginRunEvidence,
      evidence: {
        ...executionRunEvidenceInput(
          { project: resolved.project, projectVirtualPath: resolved.sourceProjectPath },
          { surface: 'scheduled', graphId, correlationId: occurrence.id },
          draft.name,
          draft.version,
        ),
        sourceRunId: occurrence.id,
      },
    });
    recorder = session.recorder;
    // Interactive nodes have no browser owner in this execution surface.
    processor.processor.on('userInput', () => {
      controller.abort();
      void processor.processor.abort().catch(() => {});
    });
    if (!(await store.accept(occurrence.id, owner, { revisionKey: resolved.revisionKey, graphId })))
      return { status: 'cancelled' };
    signal.throwIfAborted();
    const outcome = await session.run();
    invoked = outcome.invoked;
    recorder = outcome.recorder;
    graphRecordingStatus = outcome.status;
    evidenceHandle = outcome.evidenceHandle;
    evidenceCompletion = outcome.evidenceCompletion;
    executionDurationMs = outcome.durationMs;
    createdAt = outcome.createdAt;
    if (outcome.failure) throw outcome.failure.error;
    if (controller.signal.aborted) throw new Error('Interactive input is not supported for scheduled runs.');
  } catch (error) {
    status = signal.aborted ? 'interrupted' : 'failed';
    // Do not expose exception text: providers and Code nodes may include secrets.
    reason = controller.signal.aborted
      ? 'This graph requested interactive input.'
      : signal.aborted
        ? 'Execution cancelled, timed out or worker ownership lost; check side effects before retrying.'
        : invoked
          ? 'Graph execution failed. Inspect its recording when available.'
          : 'Execution preparation or acceptance failed; the graph was not invoked.';
  } finally {
    if (!invoked) processor.dispose();
  }
  let recordingId: string | undefined;
  let recordingStatus: ScheduledOccurrence['recordingStatus'] = draft.record ? 'unavailable' : 'off';
  if (recorder && invoked) {
    const diagnostic: RecordingDiagnosticContext = {
      projectId: draft.projectId,
      graphId,
      correlationId: occurrence.id,
      surface: 'scheduled',
      runKind: draft.version,
      phase: 'serialization',
    };
    try {
      await evidenceCompletion;
      const [project, attached] = loadProjectAndAttachedDataFromString(resolved.projectContents);
      const recordingSerialized = recorder.serialize();
      diagnostic.phase = 'persistence';
      recordingId = await persistWorkflowExecutionRecordingWithBackend({
        evidenceHandle,
        createdAt: createdAt ?? getWorkflowRecordingCreatedAt(recorder.events),
        sourceProject: project,
        sourceProjectPath: resolved.sourceProjectPath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: shouldSnapshotWorkflowRecordingDatasets()
          ? await resolved.datasetProvider.exportDatasetsForProject(project.metadata.id)
          : [],
        endpointName: `Scheduled: ${occurrence.scheduleId}`,
        runKind: draft.version,
        recordingSerialized,
        status: graphRecordingStatus,
        durationMs: executionDurationMs,
        errorMessage: reason,
        executionIdentity: {
          surface: 'scheduled',
          scheduleId: occurrence.scheduleId,
          scheduleName: draft.name,
          occurrenceId: occurrence.id,
          graphId,
          graphName: project.graphs[graphId]?.metadata?.name,
          revisionKey: resolved.revisionKey,
          correlationId: occurrence.id,
        },
      });
      if (recordingId) recordingStatus = 'saved';
    } catch (error) {
      await unavailableRunEvidence(
        evidenceHandle,
        diagnostic.phase === 'serialization' ? 'serialization_failed' : 'persistence_failed',
      );
      reportRecordingFailure(error, diagnostic);
      /* Recording failure must never cause graph retry. */
    }
  }
  try {
    const health = await getLLMProfileHealthStore();
    await health.recordRecordingOutcome({
      correlationId: occurrence.id,
      availability: recordingId ? 'available' : draft.record ? 'persistence-failed' : 'disabled',
      recordingId,
    });
  } catch {
    /* Observability failure does not change the execution result. */
  }
  return { status, reason, recordingId, recordingStatus, revisionKey: resolved.revisionKey, graphId };
}
