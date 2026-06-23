import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { loadedProjectState, openedProjectsSortedIdsState, projectState } from '../state/savedGraphs.js';
import { useRivetAppHostCallbacks } from '../providers/HostCallbacksContext.js';
import { selectedOpeningProjectTabIdState, workspaceVisibleTabCountState } from '../state/openingProjectTabs.js';

export function RivetAppHostLifecycle() {
  const callbacks = useRivetAppHostCallbacks();
  const project = useAtomValue(projectState);
  const loadedProject = useAtomValue(loadedProjectState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const selectedOpeningProjectTabId = useAtomValue(selectedOpeningProjectTabIdState);
  const workspaceVisibleTabCount = useAtomValue(workspaceVisibleTabCountState);

  useEffect(() => {
    const realProjectSelected = openedProjectIds.length > 0 && selectedOpeningProjectTabId == null;

    callbacks.onActiveProjectChanged?.({
      project: realProjectSelected ? project : null,
      projectId: realProjectSelected ? project.metadata.id : null,
      path: realProjectSelected ? loadedProject.path : null,
    });
  }, [callbacks, loadedProject.path, openedProjectIds, project, selectedOpeningProjectTabId]);

  useEffect(() => {
    callbacks.onOpenProjectCountChanged?.({
      count: workspaceVisibleTabCount,
      projectIds: openedProjectIds,
    });
  }, [callbacks, openedProjectIds, workspaceVisibleTabCount]);

  return null;
}
