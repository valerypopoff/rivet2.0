import { createBlankProjectWithDefaultGraph } from '../utils/blankProject';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';

export function useNewProject() {
  const { openProjectSnapshot } = useWorkspaceHostOpenProject();

  return async ({
    title,
    description,
  }: {
    title?: string;
    description?: string;
  } = {}) => {
    const { data: _data, ...project } = createBlankProjectWithDefaultGraph({ title, description });
    const initialGraph = project.metadata.mainGraphId ? project.graphs[project.metadata.mainGraphId] : undefined;

    return openProjectSnapshot({
      project,
      graphToLoad: initialGraph,
      path: null,
    });
  };
}
