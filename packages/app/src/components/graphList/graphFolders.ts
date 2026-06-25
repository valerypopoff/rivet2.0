import { type NodeGraph, type ProjectComparisonChangeKind } from '@valerypopoff/rivet2-core';

export interface NodeGraphFolder {
  type: 'folder';
  name: string;
  fullPath: string;
  children: NodeGraphFolderItem[];
}

export interface NodeGraphFolderGraph {
  type: 'graph';
  name: string;
  graph: NodeGraph;
  compareChangeKind?: ProjectComparisonChangeKind;
  isComparisonGhost?: boolean;
}

export type NodeGraphFolderItem = NodeGraphFolder | NodeGraphFolderGraph;

const graphTreeNameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

function compareGraphTreeItems(left: NodeGraphFolderItem, right: NodeGraphFolderItem): number {
  if (left.type !== right.type) {
    return left.type === 'folder' ? -1 : 1;
  }

  return graphTreeNameCollator.compare(left.name, right.name);
}

export function createFoldersFromGraphs(graphs: NodeGraph[], folderNames: string[]): NodeGraphFolderItem[] {
  const rootFolder: NodeGraphFolder = {
    name: '',
    fullPath: '',
    type: 'folder',
    children: [],
  };

  folderNames.forEach((folderName) => {
    ensureFolderPath(rootFolder, folderName.split('/'));
  });

  graphs.forEach((graph) => {
    addGraphToFolderTree(rootFolder, graph);
  });

  sortFolder(rootFolder);
  return rootFolder.children;
}

export function addComparisonRemovedGraphsToFolderTree(
  folderedGraphs: NodeGraphFolderItem[],
  removedGraphs: NodeGraph[],
): NodeGraphFolderItem[] {
  if (removedGraphs.length === 0) {
    return folderedGraphs;
  }

  const rootFolder: NodeGraphFolder = {
    name: '',
    fullPath: '',
    type: 'folder',
    children: cloneFolderItems(folderedGraphs),
  };

  for (const removedGraph of removedGraphs) {
    addComparisonRemovedGraph(rootFolder, removedGraph);
  }

  sortFolder(rootFolder);
  return rootFolder.children;
}

export function isInFolder(folderPath: string, itemPath: string): boolean {
  return itemPath.startsWith(folderPath + '/');
}

export function getFolderNames(folderedGraphs: NodeGraphFolderItem[]): string[] {
  const folderNames: string[] = [];

  const traverseFolder = (folder: NodeGraphFolderItem) => {
    if (folder.type === 'folder') {
      folder.children.forEach(traverseFolder);
      folderNames.push(folder.fullPath);
    }
  };

  folderedGraphs.forEach(traverseFolder);
  return folderNames;
}

export function getGraphFolderExpansionStorageKey(projectId: string | undefined, folderPath: string): string {
  return `${projectId}/${folderPath}`;
}

export function setAllGraphFolderExpansionStates(options: {
  expandedFolders: Record<string, boolean>;
  folderPaths: readonly string[];
  isExpanded: boolean;
  projectId: string | undefined;
}): Record<string, boolean> {
  const { expandedFolders, folderPaths, isExpanded, projectId } = options;
  let nextExpandedFolders = expandedFolders;

  for (const folderPath of folderPaths) {
    if (!folderPath) {
      continue;
    }

    const folderKey = getGraphFolderExpansionStorageKey(projectId, folderPath);
    if (nextExpandedFolders[folderKey] === isExpanded) {
      continue;
    }

    if (nextExpandedFolders === expandedFolders) {
      nextExpandedFolders = { ...expandedFolders };
    }

    nextExpandedFolders[folderKey] = isExpanded;
  }

  return nextExpandedFolders;
}

export function countGraphsInFolder(folder: NodeGraphFolder): number {
  return folder.children.reduce((count, child) => {
    if (child.type === 'graph') {
      return count + 1;
    }

    return count + countGraphsInFolder(child);
  }, 0);
}

function addComparisonRemovedGraph(rootFolder: NodeGraphFolder, graph: NodeGraph): void {
  addGraphToFolderTree(rootFolder, graph, {
    compareChangeKind: 'removed',
    isComparisonGhost: true,
  });
}

function addGraphToFolderTree(
  rootFolder: NodeGraphFolder,
  graph: NodeGraph,
  flags: Partial<Pick<NodeGraphFolderGraph, 'compareChangeKind' | 'isComparisonGhost'>> = {},
): void {
  const graphNameParts = graph.metadata?.name?.split('/') ?? [];
  const parentFolder = ensureFolderPath(rootFolder, graphNameParts, graphNameParts.length - 1);

  parentFolder.children.push({
    ...flags,
    graph,
    name: graphNameParts[graphNameParts.length - 1] ?? '',
    type: 'graph',
  });
}

function ensureFolderPath(rootFolder: NodeGraphFolder, folderNameParts: string[], partCount = folderNameParts.length) {
  let currentFolder = rootFolder;

  for (let index = 0; index < partCount; index++) {
    const folderName = folderNameParts[index] ?? '';
    const fullPath = folderNameParts.slice(0, index + 1).join('/');
    let folder = currentFolder.children.find(
      (child): child is NodeGraphFolder => child.name === folderName && child.type === 'folder',
    );

    if (!folder) {
      folder = {
        name: folderName,
        fullPath,
        type: 'folder',
        children: [],
      };
      currentFolder.children.push(folder);
    }

    currentFolder = folder;
  }

  return currentFolder;
}

function cloneFolderItems(items: NodeGraphFolderItem[]): NodeGraphFolderItem[] {
  return items.map((item) =>
    item.type === 'folder'
      ? {
          ...item,
          children: cloneFolderItems(item.children),
        }
      : { ...item },
  );
}

function sortFolder(folder: NodeGraphFolder): void {
  folder.children.sort(compareGraphTreeItems);
  folder.children.forEach((child) => {
    if (child.type === 'folder') {
      sortFolder(child);
    }
  });
}
