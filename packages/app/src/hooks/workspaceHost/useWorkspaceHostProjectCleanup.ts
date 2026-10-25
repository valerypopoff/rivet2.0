import { useSetAtom, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ProjectExecutionSnapshot } from '../../state/dataFlow.js';
import {
  openedProjectSnapshotsState,
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  projectsState,
  releaseProjectContextState,
  savedProjectContentDigestsState,
  deleteProjectContextState,
} from '../../state/savedGraphs.js';
import { flushHybridStorageGroup } from '../../state/storage.js';
import { projectCompareReferenceState, viewingProjectComparisonNodeState } from '../../state/projectComparison.js';
import { removeProjectTabUiState, projectTabUiState } from '../../state/projectTabUi.js';
import { recordingTabIndicatorsState } from '../../state/execution.js';
import { useExecutorSessionRegistry } from '../../providers/ExecutorSessionContext.js';
import { handleError } from '../../utils/errorHandling.js';
import { removeProjectUnsavedState } from '../../utils/projectUnsavedChanges.js';
import { useProjectExecutionSnapshots } from '../useProjectExecutionSnapshots.js';
import { useStableCallback } from '../useStableCallback.js';
import { removeProjectWorkspaceTargetState } from '../../state/workspaceTarget.js';
import { clearUiGraphPreviewSessions } from '../../components/rivetWebApps/uiGraphPreviewSession.js';

function clearCodeEditorModelCacheForClosedProject(projectId: ProjectId, isStillClosed: () => boolean): void {
  window.setTimeout(() => {
    if (!isStillClosed()) return;
    void import('../../utils/monaco/codeEditorModelCache.js')
      .then(({ clearCodeEditorModelCacheForProject }) => {
        if (isStillClosed()) clearCodeEditorModelCacheForProject(projectId);
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
  const store = useStore();
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);
  const setViewingProjectComparisonNode = useSetAtom(viewingProjectComparisonNodeState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const setSavedProjectContentDigests = useSetAtom(savedProjectContentDigestsState);
  const setProjectUnsavedChanges = useSetAtom(projectUnsavedChangesState);
  const setProjectDataUnsavedChanges = useSetAtom(projectDataUnsavedChangesState);
  const setProjectTabUiStates = useSetAtom(projectTabUiState);
  const setRecordingTabIndicators = useSetAtom(recordingTabIndicatorsState);
  const removeWorkspaceTarget = useSetAtom(removeProjectWorkspaceTargetState);
  const executorSessionRegistry = useExecutorSessionRegistry();
  const { removeProjectExecutionSnapshot } = useProjectExecutionSnapshots();

  return useStableCallback(
    (projectId: ProjectId, options: { currentExecutionSnapshot?: ProjectExecutionSnapshot } = {}) => {
      clearUiGraphPreviewSessions(projectId);
      removeProjectExecutionSnapshot(projectId, {
        currentSnapshot: options.currentExecutionSnapshot,
      });
      if (store.get(projectCompareReferenceState)?.projectId === projectId) {
        setProjectCompareReference(undefined);
        setViewingProjectComparisonNode(undefined);
      }
      setOpenedProjectSnapshots((snapshots) => {
        const nextSnapshots = { ...snapshots };
        delete nextSnapshots[projectId];
        return nextSnapshots;
      });
      setSavedProjectContentDigests((digests) => removeProjectUnsavedState(digests, projectId));
      setProjectUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
      setProjectDataUnsavedChanges((flags) => removeProjectUnsavedState(flags, projectId));
      setProjectTabUiStates((states) => removeProjectTabUiState(states, projectId));
      setRecordingTabIndicators((indicators) => {
        if (!indicators[projectId]) return indicators;
        const next = { ...indicators };
        delete next[projectId];
        return next;
      });
      removeWorkspaceTarget(projectId);
      executorSessionRegistry.removeProject(projectId);
      releaseProjectContextState(projectId);
      clearCodeEditorModelCacheForClosedProject(projectId, () => !store.get(projectsState).openedProjects[projectId]);
    },
  );
}

export function useWorkspaceHostDeleteProjectContext() {
  const deleteContext = useSetAtom(deleteProjectContextState);
  return useStableCallback(async (projectId: ProjectId): Promise<void> => {
    deleteContext(projectId);
    await flushHybridStorageGroup('project');
  });
}
