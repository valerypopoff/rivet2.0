import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  type SubgraphProjectRun,
} from '@valerypopoff/rivet2-node';
import { enqueueWorkflowExecutionRecordingPersistence } from './recordings.js';
import { isWorkflowRecordingEnabled } from './recordings-config.js';
import { persistWorkflowExecutionRecordingWithBackend } from './storage-backend.js';

/** A called project owns its own replay, independently of the caller's run. */
export function enqueueSubgraphProjectRecording(run: SubgraphProjectRun): void {
  if (!isWorkflowRecordingEnabled()) return;
  const { projectContents, datasetsContents, sourceProjectPath } = run.resolved;
  if (!projectContents || !sourceProjectPath) {
    console.error('Subgraph recording is missing its immutable execution snapshot or source path.');
    return;
  }
  const recordingSerialized = run.recorder.serialize();
  const accepted = enqueueWorkflowExecutionRecordingPersistence(async () => {
    const [executedProject, executedAttachedData] = loadProjectAndAttachedDataFromString(projectContents);
    if (executedProject.metadata.id !== run.target.projectId) {
      throw new Error('Subgraph recording project identity changed.');
    }
    await persistWorkflowExecutionRecordingWithBackend({
      sourceProject: executedProject,
      sourceProjectPath,
      executedProject,
      executedAttachedData,
      executedDatasets: datasetsContents ? deserializeDatasets(datasetsContents) : [],
      endpointName: `Subgraph: ${executedProject.graphs[run.graphId]?.metadata?.name ?? run.graphId}`,
      recordingSerialized,
      runKind: run.target.version,
      status: run.status,
      durationMs: run.durationMs,
      errorMessage: run.errorMessage,
      executionIdentity: {
        surface: 'subgraph_project',
        graphId: run.graphId,
        graphName: executedProject.graphs[run.graphId]?.metadata?.name,
        revisionKey: run.resolved.revisionKey,
        correlationId: run.correlationId,
      },
    });
  });
  if (!accepted) console.error('Subgraph project recording queue is full.');
}
