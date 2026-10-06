import { performance } from 'node:perf_hooks';
import { ExecutionRecorder, loadProjectAndAttachedDataFromString, type ProjectId } from '@valerypopoff/rivet2-node';
import type { ScheduledOccurrence } from '../../../studio-server-shared/scheduled-run-types.js';
import {
  createExecutionSubgraphProjectLoader,
  persistWorkflowExecutionRecordingWithBackend,
  getLLMProfileHealthStore,
} from '../routes/workflows/storage-backend.js';
import { createHostedProcessor } from '../routes/workflows/hosted-processor.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
} from '../routes/workflows/recordings-config.js';
import type { ClaimedRun, ScheduledRunStore } from './store.js';
import { awaitPreparation } from './cancellation.js';

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
  const controller = new AbortController();
  const started = performance.now();
  let status: ScheduledOccurrence['status'] = 'succeeded';
  let reason: string | undefined;
  let invoked = false;
  try {
    // Setup also belongs to the processor's cleanup scope. A recorder/listener
    // failure must not leak a processor prepared before durable acceptance.
    if (recording) {
      const prepared = new ExecutionRecorder(getWorkflowExecutionRecorderOptions());
      prepared.record(processor.processor);
      recorder = prepared;
    }
    // Interactive nodes have no browser owner in this execution surface.
    processor.processor.on('userInput', () => {
      controller.abort();
      void processor.processor.abort().catch(() => {});
    });
    if (!(await store.accept(occurrence.id, owner, { revisionKey: resolved.revisionKey, graphId })))
      return { status: 'cancelled' };
    signal.throwIfAborted();
    invoked = true;
    await processor.run();
    await processor.processor.waitForRunCompletion();
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
    processor.dispose();
  }
  let recordingId: string | undefined;
  let recordingStatus: ScheduledOccurrence['recordingStatus'] = draft.record ? 'unavailable' : 'off';
  if (recorder && invoked) {
    try {
      const [project, attached] = loadProjectAndAttachedDataFromString(resolved.projectContents);
      recordingId = await persistWorkflowExecutionRecordingWithBackend({
        sourceProject: project,
        sourceProjectPath: resolved.sourceProjectPath,
        executedProject: project,
        executedAttachedData: attached,
        executedDatasets: await resolved.datasetProvider.exportDatasetsForProject(project.metadata.id),
        endpointName: `Scheduled: ${occurrence.scheduleId}`,
        runKind: draft.version,
        recordingSerialized: recorder.serialize(),
        status: status === 'succeeded' ? 'succeeded' : 'failed',
        durationMs: performance.now() - started,
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
    } catch {
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
