import { useSetAtom, useStore } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openedProjectSnapshotsState, projectsState, projectState } from '../../state/savedGraphs.js';
import { clearLoadedRecordingForTabState } from '../../state/execution.js';
import { flushHybridStorageGroup } from '../../state/storage.js';
import { removeOpenedProject } from '../../utils/openedProjects.js';
import { isOpenedProjectRecoverable } from '../../utils/openedProjectSnapshots.js';
import { useCurrentProjectEditorSnapshot } from '../useCurrentProjectEditorSnapshot.js';
import { useLoadProject } from '../useLoadProject.js';
import { useProjectExecutionSnapshots } from '../useProjectExecutionSnapshots.js';
import { useStableCallback } from '../useStableCallback.js';
import { useWorkspaceHostProjectCleanup } from './useWorkspaceHostProjectCleanup.js';
import {
  getProjectActivationRevision,
  waitForPendingProjectActivations,
} from '../../utils/projectActivationCoordinator.js';
import { handleError } from '../../utils/errorHandling.js';

export function useWorkspaceHostCloseProject() {
  const store = useStore();
  const setProjects = useSetAtom(projectsState);
  const clearLoadedRecordingForTab = useSetAtom(clearLoadedRecordingForTabState);
  const loadProject = useLoadProject();
  const { persistCurrentProjectEditorSnapshot } = useCurrentProjectEditorSnapshot();
  const { captureCurrentProjectExecutionSnapshot, restoreProjectExecutionSnapshot } = useProjectExecutionSnapshots();
  const cleanupClosedProject = useWorkspaceHostProjectCleanup();

  return useStableCallback(async (requestedProjectId?: ProjectId) => {
    const currentProject = store.get(projectState);
    const projectId = requestedProjectId ?? currentProject.metadata.id;
    const projects = store.get(projectsState);
    const openedProjectIds = projects.openedProjectsSortedIds;
    const indexOfProject = openedProjectIds.indexOf(projectId);
    if (indexOfProject === -1) {
      return false;
    }

    const closingCurrentProject = currentProject.metadata.id === projectId;
    if (closingCurrentProject) {
      persistCurrentProjectEditorSnapshot();
    }
    const closingCurrentProjectExecutionSnapshot = closingCurrentProject
      ? captureCurrentProjectExecutionSnapshot()
      : undefined;

    const candidateProjectIds = [
      ...openedProjectIds.slice(indexOfProject + 1),
      ...openedProjectIds.slice(0, indexOfProject).reverse(),
    ];

    if (closingCurrentProject) {
      let activatedReplacement = false;
      for (const candidateProjectId of candidateProjectIds) {
        const candidateProject = store.get(projectsState).openedProjects[candidateProjectId];
        if (
          !candidateProject ||
          !isOpenedProjectRecoverable(candidateProject, store.get(openedProjectSnapshotsState))
        ) {
          continue;
        }

        const loading = loadProject(candidateProject);
        const revision = getProjectActivationRevision(store);
        const loaded = await loading;
        if (getProjectActivationRevision(store) !== revision) {
          // False may mean cancelled, not corrupt/unreadable. A newer user
          // selection owns the workspace; do not replace it or clear its run.
          await waitForPendingProjectActivations(store);
          if (store.get(projectState).metadata.id === projectId) {
            // The user reselected this tab (or the newer selection failed).
            // Keep the still-active tab intact rather than leaving a selected
            // project with no tab while other projects remain open.
            return false;
          }
          activatedReplacement = true;
          break;
        }
        if (loaded) {
          activatedReplacement = true;
          break;
        }
      }

      if (!activatedReplacement && store.get(projectState).metadata.id === projectId) {
        // If remaining tabs cannot be restored, retain this usable tab instead
        // of leaving its live canvas selected with no registered owner.
        if (Object.keys(store.get(projectsState).openedProjects).some((id) => id !== projectId)) return false;
        restoreProjectExecutionSnapshot(undefined);
      }
    }

    cleanupClosedProject(projectId, {
      currentExecutionSnapshot: closingCurrentProjectExecutionSnapshot,
    });
    // Recording selection is app-local but belongs to one project tab. Release
    // it before removing the tab so no invisible owner can block other tabs
    // from loading or unloading their own recording.
    clearLoadedRecordingForTab({
      projectId,
      projectPath: store.get(projectsState).openedProjects[projectId]?.fsPath ?? null,
    });
    setProjects((previousProjects) => removeOpenedProject(previousProjects, projectId));

    // Persist the close as one complete transaction: retain the editor
    // snapshot, but also commit the final tab/snapshot/context cleanup. A flush
    // before removeOpenedProject would make stale open-tab metadata durable
    // while leaving the actual close behind in a cancellable debounce.
    void flushHybridStorageGroup('project').catch((error) => {
      handleError(
        error,
        'Tab closed, but browser recovery could not record the close. Retry recovery before reloading.',
        { toastError: false },
      );
    });

    return true;
  });
}
