import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  type SubgraphProjectRun,
} from '@valerypopoff/rivet2-node';
import { enqueueWorkflowExecutionRecordingPersistence } from './recordings.js';
import { isWorkflowRecordingEnabled } from './recordings-config.js';
import { persistWorkflowExecutionRecordingWithBackend } from './storage-backend.js';
import { getWorkflowRecordingCreatedAt } from '../../../../studio-server-shared/workflow-recording-time.js';
import { reportRecordingFailure, type RecordingDiagnosticContext } from './recording-diagnostics.js';

/** A called project owns its own replay, independently of the caller's run. */
export function enqueueSubgraphProjectRecording(run: SubgraphProjectRun): void {
  if (!isWorkflowRecordingEnabled()) return;
  const diagnostic: RecordingDiagnosticContext = {
    projectId: run.target.projectId,
    graphId: run.graphId,
    correlationId: run.correlationId,
    surface: 'subgraph_project',
    runKind: run.target.version,
    phase: 'serialization',
  };
  const { projectContents, datasetsContents, sourceProjectPath } = run.resolved;
  if (!projectContents || !sourceProjectPath) {
    reportRecordingFailure(new Error('Missing immutable Subgraph snapshot'), diagnostic);
    return;
  }
  const createdAt = run.createdAt ?? getWorkflowRecordingCreatedAt(run.recorder.events);
  enqueueWorkflowExecutionRecordingPersistence(async () => {
    const recordingSerialized = run.recorder.serialize();
    const [executedProject, executedAttachedData] = loadProjectAndAttachedDataFromString(projectContents);
    if (executedProject.metadata.id !== run.target.projectId) {
      throw new Error('Subgraph recording project identity changed.');
    }
    diagnostic.phase = 'persistence';
    await persistWorkflowExecutionRecordingWithBackend({
      createdAt,
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
  }, diagnostic);
}
