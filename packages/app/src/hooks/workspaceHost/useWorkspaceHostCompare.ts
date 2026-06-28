import { useAtomValue, useSetAtom } from 'jotai';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { projectCompareReferenceState, viewingProjectComparisonNodeState } from '../../state/projectComparison.js';
import { projectState } from '../../state/savedGraphs.js';
import { useStableCallback } from '../useStableCallback.js';
import type { RivetProjectCompareOptions } from './types.js';

export function useWorkspaceHostCompare() {
  const currentProject = useAtomValue(projectState);
  const projectCompareReference = useAtomValue(projectCompareReferenceState);
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);
  const setViewingProjectComparisonNode = useSetAtom(viewingProjectComparisonNodeState);

  const startProjectCompare = useStableCallback(
    async (referenceProject: Project, referencePath?: string | null, options?: RivetProjectCompareOptions) => {
      const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
      if (!currentProjectId) {
        return false;
      }

      setViewingProjectComparisonNode(undefined);
      setProjectCompareReference({
        projectId: currentProjectId,
        referencePath: referencePath ?? undefined,
        referenceProject,
        labels: options?.labels,
      });

      return true;
    },
  );

  const stopProjectCompare = useStableCallback(async (projectId?: ProjectId) => {
    if (!projectCompareReference || (projectId && projectCompareReference.projectId !== projectId)) {
      return false;
    }

    setViewingProjectComparisonNode(undefined);
    setProjectCompareReference(undefined);

    return true;
  });

  return {
    startProjectCompare,
    stopProjectCompare,
  };
}
