import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openedProjectsSortedIdsState, projectsState, projectState } from '../../state/savedGraphs.js';
import { clearLoadedRecordingForProjectState } from '../../state/execution.js';
import { removeOpenedProject } from '../../utils/openedProjects.js';
import { useCurrentProjectEditorSnapshot } from '../useCurrentProjectEditorSnapshot.js';
import { useLoadProject } from '../useLoadProject.js';
import { useProjectExecutionSnapshots } from '../useProjectExecutionSnapshots.js';
import { useStableCallback } from '../useStableCallback.js';
import { useWorkspaceHostProjectCleanup } from './useWorkspaceHostProjectCleanup.js';

export function useWorkspaceHostCloseProject() {
  const [projects, setProjects] = useAtom(projectsState);
  const currentProject = useAtomValue(projectState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const clearLoadedRecordingForProject = useSetAtom(clearLoadedRecordingForProjectState);
  const loadProject = useLoadProject();
  const { persistCurrentProjectEditorSnapshot } = useCurrentProjectEditorSnapshot();
  const { captureCurrentProjectExecutionSnapshot, restoreProjectExecutionSnapshot } = useProjectExecutionSnapshots();
  const cleanupClosedProject = useWorkspaceHostProjectCleanup();

  return useStableCallback(async (projectId = currentProject.metadata.id as ProjectId) => {
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

    const sortedOpenedProjects = openedProjectIds
      .map((id) => ({
        id,
        project: projects.openedProjects[id],
      }))
      .filter((item) => item.project != null);
    const closestProject = sortedOpenedProjects[indexOfProject + 1] || sortedOpenedProjects[indexOfProject - 1];

    if (closingCurrentProject && closestProject?.project) {
      const loaded = await loadProject(closestProject.project);
      if (!loaded) {
        return false;
      }
    } else if (closingCurrentProject) {
      restoreProjectExecutionSnapshot(undefined);
    }

    cleanupClosedProject(projectId, {
      currentExecutionSnapshot: closingCurrentProjectExecutionSnapshot,
    });
    // Recording selection is app-local but belongs to one project tab. Release
    // it before removing the tab so no invisible owner can block other tabs
    // from loading or unloading their own recording.
    clearLoadedRecordingForProject(projectId);
    setProjects((previousProjects) => removeOpenedProject(previousProjects, projectId));

    return true;
  });
}
