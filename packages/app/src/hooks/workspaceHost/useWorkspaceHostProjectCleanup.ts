import { useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectExecutionSnapshot } from '../../state/dataFlow.js';
import {
  openedProjectSnapshotsState,
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  releaseProjectContextState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import { projectCompareReferenceState, viewingProjectComparisonNodeState } from '../../state/projectComparison.js';
import { removeProjectTabUiState, projectTabUiState } from '../../state/projectTabUi.js';
import { useExecutorSessionRegistry } from '../../providers/ExecutorSessionContext.js';
import { handleError } from '../../utils/errorHandling.js';
import { removeProjectUnsavedState } from '../../utils/projectUnsavedChanges.js';
import { useProjectExecutionSnapshots } from '../useProjectExecutionSnapshots.js';
import { useStableCallback } from '../useStableCallback.js';
import { removeProjectWorkspaceTargetState } from '../../state/workspaceTarget.js';

function clearCodeEditorModelCacheForClosedProject(projectId: ProjectId): void {
  window.setTimeout(() => {
    void import('../../utils/monaco/codeEditorModelCache.js')
      .then(({ clearCodeEditorModelCacheForProject }) => {
        clearCodeEditorModelCacheForProject(projectId);
      })
      .catch((error) => {
        handleError(error, 'Failed to clear code editor model cache', {
          metadata: {
            projectId,
          },
        });
      });
  }, 0);
}

export function useWorkspaceHostProjectCleanup() {
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);
  const setViewingProjectComparisonNode = useSetAtom(viewingProjectComparisonNodeState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const setProjectTabUiStates = useSetAtom(projectTabUiState);
  const removeWorkspaceTarget = useSetAtom(removeProjectWorkspaceTargetState);
  const executorSessionRegistry = useExecutorSessionRegistry();
  const { removeProjectExecutionSnapshot } = useProjectExecutionSnapshots();

  return useStableCallback(
    (projectId: ProjectId, options: { currentExecutionSnapshot?: ProjectExecutionSnapshot } = {}) => {
      removeProjectExecutionSnapshot(projectId, {
        currentSnapshot: options.currentExecutionSnapshot,
      });
      setProjectCompareReference((reference) => (reference?.projectId === projectId ? undefined : reference));
      setViewingProjectComparisonNode(undefined);
      setOpenedProjectSnapshots((snapshots) => {
        const nextSnapshots = { ...snapshots };
        delete nextSnapshots[projectId];
        return nextSnapshots;
      });
      setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, projectId));
      setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
      setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
      setProjectTabUiStates((states) => removeProjectTabUiState(states, projectId));
      removeWorkspaceTarget(projectId);
      executorSessionRegistry.removeProject(projectId);
      releaseProjectContextState(projectId);
      clearCodeEditorModelCacheForClosedProject(projectId);
    },
  );
}
