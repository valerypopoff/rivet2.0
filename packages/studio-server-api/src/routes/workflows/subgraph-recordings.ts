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
import { recordingMemory, isRecordingMemoryCapacityError } from './recording-memory.js';

/** A called project owns its own replay, independently of the caller's run. */
export function enqueueSubgraphProjectRecording(run: SubgraphProjectRun): void {
  const { recorder, graphId, correlationId, status, durationMs, errorMessage } = run;
  const { projectId, version } = run.target;
  const { projectContents, datasetsContents, sourceProjectPath, revisionKey } = run.resolved;
  const root = rootRunEvidence(correlationId);
  if (!root && !isWorkflowRecordingEnabled()) {
    recordingMemory.discard(recorder);
    return;
  }
  const diagnostic: RecordingDiagnosticContext = {
    projectId,
    graphId,
    correlationId,
    surface: 'subgraph_project',
    runKind: version,
    phase: 'serialization',
  };
  if (!projectContents || !sourceProjectPath) {
    void incompleteChildEvidence(root);
    reportRecordingFailure(new Error('Missing immutable Subgraph snapshot'), diagnostic);
    recordingMemory.discard(recorder);
    return;
  }
  const createdAt = run.createdAt ?? getWorkflowRecordingCreatedAt(recorder.events);
  if (!recordingMemory.retain(recorder, [projectContents, datasetsContents])) {
    void incompleteChildEvidence(root);
    return;
  }
  const accepted = enqueueWorkflowExecutionRecordingPersistence(
    async () => {
      let evidenceHandle: RunEvidenceHandle | undefined;
      try {
        const [executedProject, executedAttachedData] = loadProjectAndAttachedDataFromString(projectContents);
        if (executedProject.metadata.id !== projectId) {
          throw new Error('Subgraph recording project identity changed.');
        }
        const executedDatasets = datasetsContents ? deserializeDatasets(datasetsContents) : [];
        const recordingSerialized = recordingMemory.serialize(recorder, [
          projectContents,
          datasetsContents,
          executedProject,
          executedAttachedData,
          executedDatasets,
        ]);
        if (root) {
          evidenceHandle = await beginChildEvidence(
            root,
            {
              projectId,
              sourceProjectName: executedProject.metadata.title,
              sourceProjectRelativePath:
                getManagedWorkflowRelativePathFromVirtualPath(sourceProjectPath) ?? sourceProjectPath,
              createdAt,
              runKind: version,
              endpointName: `Subgraph: ${executedProject.graphs[graphId]?.metadata?.name ?? graphId}`,
              executionIdentity: {
                surface: 'subgraph_project',
                graphId,
                correlationId,
              },
            },
            String(recorder.recordingId),
          );
          await root.repository!.outcome(evidenceHandle, { state: status, durationMs });
        }
        diagnostic.phase = 'persistence';
        await persistWorkflowExecutionRecordingWithBackend(
          {
            evidenceHandle,
            createdAt,
            sourceProject: executedProject,
            sourceProjectPath,
            executedProject,
            executedAttachedData,
            executedDatasets,
            endpointName: `Subgraph: ${executedProject.graphs[graphId]?.metadata?.name ?? graphId}`,
            recordingSerialized,
            runKind: version,
            status,
            durationMs,
            errorMessage,
            executionIdentity: {
              surface: 'subgraph_project',
              graphId,
              graphName: executedProject.graphs[graphId]?.metadata?.name,
              revisionKey,
              correlationId,
            },
          },
          recorder,
        );
      } catch (error) {
        await incompleteChildEvidence(root);
        await unavailableRunEvidence(
          evidenceHandle,
          isRecordingMemoryCapacityError(error)
            ? 'capacity'
            : diagnostic.phase === 'serialization'
              ? 'serialization_failed'
              : 'persistence_failed',
        );
        throw error;
      }
    },
    diagnostic,
    recordingMemory.retainedBytes(recorder),
    { deferredCapture: true, acceptedEvidence: !!root, finalize: () => recordingMemory.discard(recorder) },
  );
  if (!accepted) {
    recordingMemory.discard(recorder);
    void incompleteChildEvidence(root);
  }
}
