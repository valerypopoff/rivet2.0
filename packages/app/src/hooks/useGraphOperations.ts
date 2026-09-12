import { useState, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { graphState } from '../state/graph.js';
import { projectMetadataState, savedGraphsState } from '../state/savedGraphs.js';
import { useDeleteGraphs } from './useDeleteGraph.js';
import { useLoadGraph } from './useLoadGraph.js';
import { useDuplicateGraph } from './useDuplicateGraph.js';
import { useImportGraph } from './useImportGraph';
import { type NodeGraph } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { expandedFoldersState } from '../state/ui';
import { toast } from 'react-toastify';
import { useFuseSearch } from './useFuseSearch';
import {
  buildUniqueNewFolderPath,
  buildUntitledGraph,
  createFolderedGraphs,
  deleteFolderGraphs,
  getAncestorFolderPaths,
  preserveFolderNames,
  renameFolderItemInGraphs,
} from '../domain/graphEditing/graphListActions.js';

export function useGraphOperations() {
  const projectMetadata = useAtomValue(projectMetadataState);
  const setProjectMetadata = useSetAtom(projectMetadataState);
  const [savedGraphs, setSavedGraphs] = useAtom(savedGraphsState);
  const [graph, setGraph] = useAtom(graphState);

  const [searchText, setSearchText] = useState('');

  const searchedGraphs = useFuseSearch(
    savedGraphs,
    searchText,
    ['metadata.name' as keyof NodeGraph, 'metadata.description' as keyof NodeGraph],
    {},
  );
  const filteredGraphs = useMemo(() => searchedGraphs.map((g) => g.item), [searchedGraphs]);

  // Track the graph that is being renamed, so that we can update the name when the user is done.
  const [renamingItemFullPath, setRenamingItemFullPath] = useState<string | undefined>();

  // Track folders on deletion or creation, so that empty folders aren't automatically deleted.
  const [folderNames, setFolderNames] = useState<string[]>([]);

  const folderedGraphs = useMemo(() => createFolderedGraphs(filteredGraphs, folderNames), [filteredGraphs, folderNames]);
  const allFolderedGraphs = useMemo(() => createFolderedGraphs(savedGraphs, folderNames), [savedGraphs, folderNames]);
  const allFolderPaths = useMemo(() => preserveFolderNames(allFolderedGraphs), [allFolderedGraphs]);

  const deleteGraphs = useDeleteGraphs();
  const loadGraph = useLoadGraph();
  const duplicateGraph = useDuplicateGraph();
  const importGraph = useImportGraph();

  const setExpandedFolders = useSetAtom(expandedFoldersState);
  const startRename = useStableCallback((folderItemName: string) => {
    setRenamingItemFullPath(folderItemName);
    const ancestorFolderPaths = getAncestorFolderPaths(folderItemName);
    if (ancestorFolderPaths.length === 0) {
      return;
    }

    setExpandedFolders((prev) => {
      let next = prev;
      for (const ancestorFolderPath of ancestorFolderPaths) {
        const expandedFolderKey = `${projectMetadata.id}/${ancestorFolderPath}`;
        if (next[expandedFolderKey] !== true) {
          next = { ...next, [expandedFolderKey]: true };
        }
      }
      return next;
    });
  });

  const cancelRename = useStableCallback(() => {
    setRenamingItemFullPath(undefined);
  });

  const handleNew = useStableCallback((folderPath?: string) => {
    const graph = buildUntitledGraph(savedGraphs, folderPath);
    loadGraph(graph);
    setSavedGraphs((prev) => [...prev, graph]);
    startRename(graph.metadata!.name!);
  });

  const handleNewFolder = useStableCallback((parentPath?: string) => {
    const newFolderPath = buildUniqueNewFolderPath(parentPath, folderNames, savedGraphs);
    setFolderNames((prev) => [...prev, newFolderPath]);
    startRename(newFolderPath);
    setExpandedFolders((prev) => ({
      ...prev,
      [`${projectMetadata.id}/${newFolderPath}`]: true,
    }));
  });

  const handleDelete = useStableCallback((graph: NodeGraph) => {
    const graphId = graph.metadata?.id;
    if (!graphId) {
      return;
    }

    const deletion = deleteGraphs([graphId]);
    if (deletion.referencedGraphIds.length > 0) {
      toast.error('Remove this graph from other graphs and web apps before deleting it.');
      return;
    }
    if (deletion.deletedGraphIds.length === 0) {
      toast.error('Stop the graph run before deleting this graph.');
      return;
    }

    setFolderNames(preserveFolderNames(folderedGraphs));
  });

  const handleDeleteFolder = useStableCallback((folderName: string) => {
    const nextSavedGraphs = deleteFolderGraphs(savedGraphs, folderName);
    const deletedGraphIds = savedGraphs
      .filter((savedGraph) => !nextSavedGraphs.some((nextSavedGraph) => nextSavedGraph.metadata?.id === savedGraph.metadata?.id))
      .map((savedGraph) => savedGraph.metadata?.id)
      .filter((id): id is NonNullable<typeof id> => id != null);
    const deletion = deleteGraphs(deletedGraphIds);
    if (deletion.referencedGraphIds.length > 0) {
      toast.error('Remove folder graphs from other graphs and web apps before deleting the folder.');
      return;
    }
    if (deletion.deletedGraphIds.length === 0 && deletedGraphIds.length > 0) {
      toast.error('Stop all graph runs in this folder before deleting it.');
      return;
    }

    setFolderNames((prev) => prev.filter((name) => name !== folderName && !name.startsWith(`${folderName}/`)));
  });

  const makeMainGraph = useStableCallback((graph: NodeGraph) => {
    const graphId = graph.metadata?.id;
    if (graphId == null || graphId === projectMetadata.mainGraphId) {
      return;
    }

    setProjectMetadata({
      ...projectMetadata,
      mainGraphId: graphId,
    });
  });

  const renameFolderItem = useStableCallback((fullPath: string, newFullPath: string, itemId?: string) => {
    const result = renameFolderItemInGraphs({
      fullPath,
      newFullPath,
      savedGraphs,
      currentGraph: graph,
      folderNames,
    });

    if ('error' in result) {
      if (result.error === 'noop') {
        setRenamingItemFullPath(undefined);
        return;
      }

      if (result.error === 'invalid') {
        toast.error('Names contains invalid segments');
        return;
      }

      if (result.error === 'duplicate') {
        toast.error('A graph or folder with that name already exists.');
        return;
      }

      setRenamingItemFullPath(undefined);
      return;
    }

    setSavedGraphs(result.savedGraphs);
    setGraph(result.currentGraph);
    setFolderNames(result.folderNames);

    setRenamingItemFullPath(undefined);
    setExpandedFolders((prev) => ({
      ...prev,
      [`${projectMetadata.id}/${newFullPath}`]: prev[`${projectMetadata.id}/${fullPath}`] ?? false,
    }));
  });

  return {
    graph,
    savedGraphs,
    searchText,
    setSearchText,
    renamingItemFullPath,
    folderedGraphs,
    allFolderPaths,
    loadGraph,
    duplicateGraph,
    importGraph,
    handleNew,
    handleNewFolder,
    handleDelete,
    handleDeleteFolder,
    makeMainGraph,
    startRename,
    cancelRename,
    renameFolderItem,
  };
}
