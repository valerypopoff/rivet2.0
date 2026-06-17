import { useSetAtom } from 'jotai';
import { projectsState } from '../state/savedGraphs.js';
import { createBlankProjectWithDefaultGraph } from '../utils/blankProject';
import { addOpenedProject } from '../utils/openedProjects.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useNewProject() {
  const setProjects = useSetAtom(projectsState);
  const workspaceTransitions = useWorkspaceTransitions();

  return async ({
    title,
    description,
  }: {
    title?: string;
    description?: string;
  } = {}) => {
    const { data: _data, ...project } = createBlankProjectWithDefaultGraph({ title, description });
    const initialGraph = project.metadata.mainGraphId ? project.graphs[project.metadata.mainGraphId] : undefined;

    const loaded = await workspaceTransitions.loadProject({
      project,
      graphToLoad: initialGraph,
      testSuites: [],
      markClean: true,
    });

    if (loaded) {
      setProjects((prev) =>
        addOpenedProject(prev, project, {
          fsPath: null,
          openedGraph: initialGraph?.metadata?.id,
        }),
      );
    }

    return loaded;
  };
}
