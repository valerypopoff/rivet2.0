import { produce } from 'immer';
import { emptyNodeGraph, type NodeGraph } from '@valerypopoff/rivet2-core';
import {
  createFoldersFromGraphs,
  getFolderNames,
  isInFolder,
  type NodeGraphFolderItem,
} from '../../components/graphList/graphFolders.js';

export function buildUntitledGraph(savedGraphs: NodeGraph[], folderPath?: string) {
  const graph = emptyNodeGraph();
  let index = 1;

  if (folderPath) {
    if (savedGraphs.some((candidate) => candidate.metadata?.name === `${folderPath}/Untitled graph`)) {
      index += 1;
    }

    while (savedGraphs.some((candidate) => candidate.metadata?.name === `${folderPath}/Untitled graph ${index}`)) {
      index += 1;
    }

    graph.metadata!.name = index === 1 ? `${folderPath}/Untitled graph` : `${folderPath}/Untitled graph ${index}`;
  } else {
    if (savedGraphs.some((candidate) => candidate.metadata?.name === 'Untitled graph')) {
      index += 1;
    }

    while (savedGraphs.some((candidate) => candidate.metadata?.name === `Untitled graph ${index}`)) {
      index += 1;
    }

    graph.metadata!.name = index === 1 ? 'Untitled graph' : `Untitled graph ${index}`;
  }

  return graph;
}

export function buildNewFolderPath(parentPath?: string) {
  return parentPath ? `${parentPath}/New Folder` : 'New Folder';
}

export function buildUniqueNewFolderPath(parentPath: string | undefined, folderNames: string[], savedGraphs: NodeGraph[]) {
  const basePath = buildNewFolderPath(parentPath);
  let index = 1;
  let candidatePath = basePath;

  while (folderNames.includes(candidatePath) || savedGraphs.some((graph) => graph.metadata?.name === candidatePath)) {
    index += 1;
    candidatePath = parentPath ? `${parentPath}/New Folder ${index}` : `New Folder ${index}`;
  }

  return candidatePath;
}

export function getAncestorFolderPaths(fullPath: string): string[] {
  const pathParts = fullPath.split('/').filter(Boolean);
  return pathParts.slice(0, -1).map((_, index) => pathParts.slice(0, index + 1).join('/'));
}

function getParentFolderPath(fullPath: string): string | undefined {
  const pathParts = fullPath.split('/').filter(Boolean);
  if (pathParts.length <= 1) {
    return undefined;
  }

  return pathParts.slice(0, -1).join('/');
}

function appendUniqueFolderName(folderNames: string[], folderName: string | undefined): string[] {
  if (folderName == null || folderNames.includes(folderName)) {
    return folderNames;
  }

  return [...folderNames, folderName];
}

function hasVisibleFolderContent(folderPath: string, graphs: NodeGraph[], folderNames: string[]): boolean {
  return (
    graphs.some((graph) => graph.metadata?.name != null && isInFolder(folderPath, graph.metadata.name)) ||
    folderNames.some((folderName) => folderName === folderPath || isInFolder(folderPath, folderName))
  );
}

export function deleteFolderGraphs(savedGraphs: NodeGraph[], folderName: string) {
  return savedGraphs.filter((graph) => !(graph.metadata?.name && isInFolder(folderName, graph.metadata.name)));
}

export function renameFolderItemInGraphs(options: {
  fullPath: string;
  newFullPath: string;
  savedGraphs: NodeGraph[];
  currentGraph: NodeGraph;
  folderNames: string[];
}):
  | {
      savedGraphs: NodeGraph[];
      currentGraph: NodeGraph;
      folderNames: string[];
    }
  | { error: 'invalid' | 'duplicate' | 'noop' } {
  const { fullPath, newFullPath, savedGraphs, currentGraph, folderNames } = options;

  if (fullPath === newFullPath || !newFullPath || /\/$/.test(newFullPath)) {
    return { error: 'noop' };
  }

  if (newFullPath.split('/').some((part) => part === '')) {
    return { error: 'invalid' };
  }

  if (savedGraphs.some((graph) => graph.metadata?.name === newFullPath) || folderNames.includes(newFullPath)) {
    return { error: 'duplicate' };
  }

  const nextSavedGraphs = savedGraphs.map((graph) => {
    if (graph.metadata?.name && (fullPath === graph.metadata.name || isInFolder(fullPath, graph.metadata.name))) {
      return {
        ...graph,
        metadata: {
          ...graph.metadata,
          name: graph.metadata.name.replace(fullPath, newFullPath),
        },
      };
    }

    return graph;
  });

  const shouldRenameCurrentGraph =
    currentGraph.metadata?.name != null &&
    (currentGraph.metadata.name === fullPath || isInFolder(fullPath, currentGraph.metadata.name));

  const nextCurrentGraph = shouldRenameCurrentGraph
    ? produce(currentGraph, (draft) => {
        const metadata = draft.metadata ?? { name: '' };
        metadata.name = metadata.name!.replace(fullPath, newFullPath);
        draft.metadata = metadata;
      })
    : currentGraph;

  const nextFolderNames = folderNames.map((name) =>
    name === fullPath || isInFolder(fullPath, name) ? name.replace(fullPath, newFullPath) : name,
  );
  const sourceParentFolderPath = savedGraphs.some((graph) => graph.metadata?.name === fullPath)
    ? getParentFolderPath(fullPath)
    : undefined;
  const shouldPreserveSourceParentFolder =
    sourceParentFolderPath != null && !hasVisibleFolderContent(sourceParentFolderPath, nextSavedGraphs, nextFolderNames);

  return {
    savedGraphs: nextSavedGraphs,
    currentGraph: nextCurrentGraph,
    folderNames: shouldPreserveSourceParentFolder
      ? appendUniqueFolderName(nextFolderNames, sourceParentFolderPath)
      : nextFolderNames,
  };
}

export function createFolderedGraphs(graphs: NodeGraph[], folderNames: string[]): NodeGraphFolderItem[] {
  return createFoldersFromGraphs(graphs, folderNames);
}

export function preserveFolderNames(folderedGraphs: NodeGraphFolderItem[]): string[] {
  return getFolderNames(folderedGraphs);
}
