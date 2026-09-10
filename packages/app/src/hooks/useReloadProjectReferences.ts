import { useAtomValue, useSetAtom } from 'jotai';
import { loadProjectReferenceTree } from '@valerypopoff/rivet2-core';
import { loadedProjectState, projectState, referencedProjectsState } from '../state/savedGraphs';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { TauriProjectReferenceLoader } from '../model/TauriProjectReferenceLoader';
import { handleError } from '../utils/errorHandling.js';
import { usePathPolicyProvider } from '../providers/ProvidersContext.js';

export function useReloadProjectReferences() {
  const project = useAtomValue(projectState);
  const loadedProject = useAtomValue(loadedProjectState);
  const pathPolicy = usePathPolicyProvider();

  const setReferencedProjects = useSetAtom(referencedProjectsState);
  const reloadGeneration = useRef(0);
  const invalidatePendingReloads = useCallback(() => {
    reloadGeneration.current++;
  }, []);
  // Reference discovery only depends on a project's identity and reference
  // list. Editing metadata (including project global variables) must not reload every
  // referenced project on each keystroke.
  const referenceRoot = useMemo(
    () => ({ metadata: { id: project.metadata.id }, references: project.references }),
    [project.metadata.id, project.references],
  );

  const reloadReferences = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    // Do not let the previous project's definitions appear in Get Global
    // while the current reference closure is still loading.
    setReferencedProjects({});
    try {
      const loader = new TauriProjectReferenceLoader(pathPolicy);
      const references = await loadProjectReferenceTree(referenceRoot, loadedProject.path ?? undefined, loader);
      if (generation === reloadGeneration.current) {
        setReferencedProjects(references);
      }
    } catch (err) {
      // An earlier project can otherwise remain visible after its reference
      // file was removed or changed. That would make editor discovery disagree
      // with an execution that correctly fails to load the reference.
      if (generation !== reloadGeneration.current) return;

      setReferencedProjects({});
      handleError(err, 'Failed to reload project references', {
        metadata: {
          projectId: referenceRoot.metadata.id,
          projectPath: loadedProject.path,
          referenceCount: referenceRoot.references?.length ?? 0,
        },
      });
    }
  }, [loadedProject.path, pathPolicy, referenceRoot, setReferencedProjects]);

  useEffect(() => {
    void reloadReferences();
    // Invalidate an in-flight request when this hook unmounts or a new
    // project/reference list supersedes it. A late completion must never
    // publish references or report an error for the active project.
    return invalidatePendingReloads;
  }, [invalidatePendingReloads, reloadReferences]);

  return reloadReferences;
}
