import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { RivetAppHostProjectSavedEvent } from '../../../rivet/packages/app/src/host';
import { projectsState } from '../../../rivet/packages/app/src/state/savedGraphs';
import { flushHybridStorageGroup } from '../../../rivet/packages/app/src/state/storage';
import { resolveHostedProjectTitleFromPath } from './openedProjectMetadata';

export function useReconcileHostedProjectTitleAfterSave() {
  const setProjects = useSetAtom(projectsState);

  return useCallback((event: RivetAppHostProjectSavedEvent) => {
    const projectId = event.project.metadata.id as ProjectId | undefined;
    const title = resolveHostedProjectTitleFromPath(event.path);
    if (!projectId || !title) {
      return;
    }

    setProjects((previousProjects) => {
      const openedProject = previousProjects.openedProjects[projectId];
      if (!openedProject) {
        return previousProjects;
      }

      const nextOpenedProject = {
        ...openedProject,
        title,
        fsPath: event.path ?? openedProject.fsPath,
      };

      if (
        openedProject.title === nextOpenedProject.title &&
        openedProject.fsPath === nextOpenedProject.fsPath
      ) {
        return previousProjects;
      }

      return {
        ...previousProjects,
        openedProjects: {
          ...previousProjects.openedProjects,
          [projectId]: nextOpenedProject,
        },
      };
    });

    void flushHybridStorageGroup('project');
  }, [setProjects]);
}
