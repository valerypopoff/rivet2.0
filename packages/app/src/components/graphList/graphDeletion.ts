import type { GraphId, NodeGraph, ProjectId } from '@valerypopoff/rivet2-core';
import { isInFolder } from './graphFolders.js';

export type GraphDeletionRequest = { projectId: ProjectId; graphIds: GraphId[]; name: string; folderPath?: string };

export function getFolderDeletionGraphIds(graphs: readonly NodeGraph[], folderPath: string): GraphId[] {
  return graphs
    .filter((graph) => graph.metadata?.id && graph.metadata.name && isInFolder(folderPath, graph.metadata.name))
    .map((graph) => graph.metadata!.id!);
}

/** Never include a graph added/moved into a folder after the user reviewed it. */
export function isGraphDeletionRequestCurrent(
  request: GraphDeletionRequest,
  projectId: ProjectId,
  graphs: readonly NodeGraph[],
): boolean {
  if (request.projectId !== projectId) return false;
  const ids = request.folderPath
    ? getFolderDeletionGraphIds(graphs, request.folderPath)
    : graphs
        .filter((graph) => request.graphIds.includes(graph.metadata?.id as GraphId))
        .map((graph) => graph.metadata!.id!);
  return ids.length === request.graphIds.length && ids.every((id) => request.graphIds.includes(id));
}
