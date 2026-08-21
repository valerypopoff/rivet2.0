import { useSetAtom } from 'jotai';
import {
  type GraphId,
  type NodeGraph,
  deserializeProject,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { duplicateGraph } from '../utils/duplicateGraph';
import { produce } from 'immer';
import { nanoid } from 'nanoid';
import { addOpenedProject } from '../utils/openedProjects.js';
import { projectsState } from '../state/savedGraphs.js';
import { chooseProjectGraph } from '../utils/workspaceTransitions.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';
import { remapTemplateProjectGraphIds } from '../utils/templateProjectGraphIds.js';

export function useNewProjectFromTemplate() {
  const setProjects = useSetAtom(projectsState);
  const workspaceTransitions = useWorkspaceTransitions();

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

    const loaded = await workspaceTransitions.loadProject({
      project: projectWithoutData,
      data,
      graphToLoad,
      markClean: true,
    });

    if (loaded) {
      setProjects((prev) =>
        addOpenedProject(prev, projectWithNewId, {
          fsPath: null,
          openedGraph: graphToLoad.metadata?.id,
        }),
      );
    }

    return loaded;
  };
}
