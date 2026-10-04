import { type GraphId, type NodeGraph, deserializeProject, type ProjectId } from '@valerypopoff/rivet2-core';
import { duplicateGraph } from '../utils/duplicateGraph';
import { produce } from 'immer';
import { nanoid } from 'nanoid';
import { chooseProjectGraph } from '../utils/workspaceTransitions.js';
import { useWorkspaceHostOpenProject } from './workspaceHost/useWorkspaceHostOpenProject.js';
import { remapTemplateProjectGraphIds } from '../utils/templateProjectGraphIds.js';

export function useNewProjectFromTemplate() {
  const { openProjectSnapshot } = useWorkspaceHostOpenProject();

  return async (template: unknown) => {
    let [project] = deserializeProject(template);

    project = produce(project, (draft) => {
      const newGraphs: NodeGraph[] = [];
      const oldNewGraphIdMapping: Record<GraphId, GraphId> = {};

      // Duplicate each graph to get brand new IDs for all nodes and connections
      for (const graph of Object.values(draft.graphs)) {
        const duplicated = duplicateGraph(graph);
        newGraphs.push(duplicated);
        oldNewGraphIdMapping[graph.metadata!.id!] = duplicated.metadata!.id!;
      }

      draft.graphs = newGraphs.reduce(
        (acc, graph) => {
          acc[graph.metadata!.id!] = graph;
          return acc;
        },
        {} as Record<GraphId, NodeGraph>,
      );

      remapTemplateProjectGraphIds(draft, oldNewGraphIdMapping);
    });

    const projectWithNewId = {
      ...project,
      metadata: {
        ...project.metadata,
        id: nanoid() as ProjectId,
      },
    };
    const { data, ...projectWithoutData } = projectWithNewId;
    const graphToLoad = chooseProjectGraph(projectWithoutData, {
      fallbackToMainGraph: true,
      fallbackToSortedProjectGraph: true,
    });

    return openProjectSnapshot({
      project: projectWithoutData,
      data,
      graphToLoad,
      path: null,
    });
  };
}
