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
import {
  rootRunEvidence,
  beginChildEvidence,
  incompleteChildEvidence,
  unavailableRunEvidence,
} from './run-evidence.js';
import { getManagedWorkflowRelativePathFromVirtualPath } from '../../../../studio-server-shared/workflow-types.js';
import type { RunEvidenceHandle } from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';

/** A called project owns its own replay, independently of the caller's run. */
export function enqueueSubgraphProjectRecording(run: SubgraphProjectRun): void {
  const root = rootRunEvidence(run.correlationId);
  if (!root && !isWorkflowRecordingEnabled()) return;
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
    void incompleteChildEvidence(root);
    reportRecordingFailure(new Error('Missing immutable Subgraph snapshot'), diagnostic);
    return;
  }
  const createdAt = run.createdAt ?? getWorkflowRecordingCreatedAt(run.recorder.events);
  const accepted = enqueueWorkflowExecutionRecordingPersistence(
    async () => {
      let evidenceHandle: RunEvidenceHandle | undefined;
      try {
        const recordingSerialized = run.recorder.serialize();
        const [executedProject, executedAttachedData] = loadProjectAndAttachedDataFromString(projectContents);
        if (executedProject.metadata.id !== run.target.projectId) {
          throw new Error('Subgraph recording project identity changed.');
        }
        if (root) {
          evidenceHandle = await beginChildEvidence(
            root,
            {
              projectId: run.target.projectId,
              sourceProjectName: executedProject.metadata.title,
              sourceProjectRelativePath:
                getManagedWorkflowRelativePathFromVirtualPath(sourceProjectPath) ?? sourceProjectPath,
              createdAt,
              runKind: run.target.version,
              endpointName: `Subgraph: ${executedProject.graphs[run.graphId]?.metadata?.name ?? run.graphId}`,
              executionIdentity: {
                surface: 'subgraph_project',
                graphId: run.graphId,
                correlationId: run.correlationId,
              },
            },
            String(run.recorder.recordingId),
          );
          await root.repository!.outcome(evidenceHandle, { state: run.status, durationMs: run.durationMs });
        }
        diagnostic.phase = 'persistence';
        await persistWorkflowExecutionRecordingWithBackend({
          evidenceHandle,
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
      } catch (error) {
        await incompleteChildEvidence(root);
        await unavailableRunEvidence(
          evidenceHandle,
          diagnostic.phase === 'serialization' ? 'serialization_failed' : 'persistence_failed',
        );
        throw error;
      }
    },
    diagnostic,
    0,
    { deferredCapture: true, acceptedEvidence: !!root },
  );
  if (!accepted) void incompleteChildEvidence(root);
}
