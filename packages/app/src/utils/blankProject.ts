import { emptyNodeGraph, type Project, type ProjectId, newId } from '@valerypopoff/rivet2-core';

export const DEFAULT_PROJECT_GRAPH_NAME = 'Main graph';

export function blankProject(): Project {
  return {
    graphs: {},
    metadata: {
      id: newId<ProjectId>(),
      title: 'Untitled Project',
      description: '',
    },
    plugins: [],
  };
}

export function createBlankProjectWithDefaultGraph(options: { title?: string; description?: string } = {}): Project {
  const project = blankProject();
  const graph = emptyNodeGraph();

  graph.metadata!.name = DEFAULT_PROJECT_GRAPH_NAME;
  project.metadata.title = options.title || project.metadata.title;
  project.metadata.description = options.description || project.metadata.description;
  project.metadata.mainGraphId = graph.metadata!.id!;
  project.graphs[graph.metadata!.id!] = graph;

  return project;
}
