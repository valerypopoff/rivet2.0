import { useCallback, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { toast } from 'react-toastify';

import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectPathMove } from './types';
import { moveWorkflowItem } from './workflowApi';
import { type DraggedWorkflowItem, ROOT_DROP_TARGET } from './workflowLibraryHelpers';
import { applyFolderMoveToTree, remapExpandedFolderIds } from './workflowTreeOps';

type WorkflowDragState = {
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  dragOverRoot: boolean;
};

export function useWorkflowLibraryDragAndDrop({
  applyProjectPathMoves,
  flattenedFolders,
  folders,
  reconcileTree,
  refresh,
  rootProjects,
  setExpandedFolders,
  setFolders,
  setRootProjects,
}: {
  applyProjectPathMoves: (moves: WorkflowProjectPathMove[]) => Promise<void>;
  flattenedFolders: WorkflowFolderItem[];
  folders: WorkflowFolderItem[];
  reconcileTree: (message: string) => void;
  refresh: (showLoading?: boolean) => Promise<unknown>;
  rootProjects: WorkflowProjectItem[];
  setExpandedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
  setFolders: Dispatch<SetStateAction<WorkflowFolderItem[]>>;
  setRootProjects: Dispatch<SetStateAction<WorkflowProjectItem[]>>;
}) {
  const [state, setState] = useState<WorkflowDragState>({
    draggedItem: null,
    dropTargetFolderPath: null,
    dragOverRoot: false,
  });
  const [movePending, setMovePending] = useState(false);
  const { draggedItem, dropTargetFolderPath, dragOverRoot } = state;

  const canDropIntoFolder = useCallback((item: DraggedWorkflowItem | null, destinationPath: string) => {
    if (!item || item.parentRelativePath === destinationPath) {
      return false;
    }
    return item.itemType !== 'folder' || !(
      item.relativePath === destinationPath || destinationPath.startsWith(`${item.relativePath}/`)
    );
  }, []);

  const reset = useCallback(() => {
    setState({ draggedItem: null, dropTargetFolderPath: null, dragOverRoot: false });
  }, []);

  const moveDraggedItem = useCallback(async (destinationPath: string) => {
    if (!draggedItem || !canDropIntoFolder(draggedItem, destinationPath)) {
      return;
    }

    setMovePending(true);
    try {
      const sourceFolder = draggedItem.itemType === 'folder'
        ? flattenedFolders.find((folder) => folder.relativePath === draggedItem.relativePath) ?? null
        : null;
      const result = await moveWorkflowItem(draggedItem.itemType, draggedItem.relativePath, destinationPath);
      if (result.folder) {
        const movedFolder = result.folder;
        if (draggedItem.itemType === 'folder') {
          setExpandedFolders((previous) => ({
            ...remapExpandedFolderIds(previous, draggedItem.relativePath, movedFolder.relativePath),
            [movedFolder.id]: true,
          }));
        } else {
          setExpandedFolders((previous) => ({ ...previous, [movedFolder.id]: true }));
        }

        if (sourceFolder && draggedItem.itemType === 'folder') {
          const nextTree = applyFolderMoveToTree(folders, rootProjects, sourceFolder, movedFolder);
          setFolders(nextTree.folders);
          setRootProjects(nextTree.rootProjects);
        }
      }

      await applyProjectPathMoves(result.movedProjectPaths);
      if (draggedItem.itemType === 'folder' && result.folder && sourceFolder) {
        reconcileTree('Workflow moved, but failed to refresh the tree');
      } else {
        await refresh(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move workflow item');
    } finally {
      setMovePending(false);
      reset();
    }
  }, [
    applyProjectPathMoves,
    canDropIntoFolder,
    draggedItem,
    flattenedFolders,
    folders,
    reconcileTree,
    refresh,
    reset,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
  ]);

  const handleDragStart = useCallback((item: DraggedWorkflowItem) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.relativePath);
    setState((previous) => ({ ...previous, draggedItem: item }));
  }, []);
  const handleDragEnd = useCallback(reset, [reset]);
  const handleFolderDragOver = useCallback((folder: WorkflowFolderItem) => (event: DragEvent<HTMLElement>) => {
    if (!canDropIntoFolder(draggedItem, folder.relativePath)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setState((previous) => ({
      ...previous,
      dropTargetFolderPath: folder.relativePath,
      dragOverRoot: false,
    }));
  }, [canDropIntoFolder, draggedItem]);
  const handleFolderDrop = useCallback((folder: WorkflowFolderItem) => async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await moveDraggedItem(folder.relativePath);
  }, [moveDraggedItem]);
  const handleRootDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!canDropIntoFolder(draggedItem, '')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setState((previous) => ({
      ...previous,
      dropTargetFolderPath: ROOT_DROP_TARGET,
      dragOverRoot: true,
    }));
  }, [canDropIntoFolder, draggedItem]);
  const handleRootDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    await moveDraggedItem('');
  }, [moveDraggedItem]);
  const handleRootDragLeave = useCallback(() => {
    setState((previous) => ({
      ...previous,
      dragOverRoot: false,
      dropTargetFolderPath: previous.dropTargetFolderPath === ROOT_DROP_TARGET
        ? null
        : previous.dropTargetFolderPath,
    }));
  }, []);
  const handleFolderDragLeave = useCallback((folder: WorkflowFolderItem) => {
    setState((previous) => previous.dropTargetFolderPath === folder.relativePath
      ? { ...previous, dropTargetFolderPath: null }
      : previous);
  }, []);

  return {
    dragOverRoot,
    draggedItem,
    dropTargetFolderPath,
    handleDragEnd,
    handleDragStart,
    handleFolderDragLeave,
    handleFolderDragOver,
    handleFolderDrop,
    handleRootDragLeave,
    handleRootDragOver,
    handleRootDrop,
    movePending,
  };
}
