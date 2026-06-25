import { useAtom, useAtomValue } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { openedProjectsSortedIdsState, projectsState, projectState } from '../../state/savedGraphs.js';
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
    setProjects((previousProjects) => removeOpenedProject(previousProjects, projectId));

    return true;
  });
}
