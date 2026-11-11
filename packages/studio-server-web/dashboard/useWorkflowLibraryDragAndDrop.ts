import { useCallback, useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { toast } from 'react-toastify';

import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectPathMove } from './types';
import { moveWorkflowItem } from './workflowApi';
import {
  type BundleDragPreview,
  type DraggedWorkflowItem,
  ROOT_DROP_TARGET,
  flattenFolders,
  flattenProjects,
} from './workflowLibraryHelpers';
import { remapExpandedFolderIds } from './workflowTreeOps';
import {
  reconcileNamespaceMove,
  requiresFreshNamespaceTree,
  type LibraryMutationCompletion,
} from './workflowNamespaceReconciliation';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';

type WorkflowDragState = {
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  dragOverRoot: boolean;
  dragPreview: BundleDragPreview | null;
};

export function useWorkflowLibraryDragAndDrop({
  activePath,
  applyProjectPathMoves,
  flattenedFolders,
  folders,
  reconcileTree,
  rootProjects,
  setExpandedFolders,
  setFolders,
  setRootProjects,
  onBundleMerge,
}: {
  activePath: string;
  applyProjectPathMoves: (moves: WorkflowProjectPathMove[]) => Promise<void>;
  flattenedFolders: WorkflowFolderItem[];
  folders: WorkflowFolderItem[];
  reconcileTree: LibraryMutationCompletion;
  rootProjects: WorkflowProjectItem[];
  setExpandedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
  setFolders: Dispatch<SetStateAction<WorkflowFolderItem[]>>;
  setRootProjects: Dispatch<SetStateAction<WorkflowProjectItem[]>>;
  onBundleMerge?: (source: WorkflowFolderItem, destination: WorkflowFolderItem, opener: HTMLElement) => void;
}) {
  const [state, setState] = useState<WorkflowDragState>({
    draggedItem: null,
    dropTargetFolderPath: null,
    dragOverRoot: false,
    dragPreview: null,
  });
  const [movePending, setMovePending] = useState(false);
  const { draggedItem, dropTargetFolderPath, dragOverRoot } = state;
  const captureAction = useWorkflowLibraryActionLifetime(activePath);
  const previewBundle =
    onBundleMerge && draggedItem?.itemType === 'folder'
      ? flattenedFolders.find(
          (folder) =>
            folder.relativePath === draggedItem.relativePath &&
            folder.bundleId &&
            (!draggedItem.expectedSource || draggedItem.expectedSource.id === folder.namespaceId),
        )
      : undefined;
  const getBundleMergeSource = useCallback(
    (destination: WorkflowFolderItem) =>
      previewBundle?.bundleId &&
      destination.bundleId &&
      previewBundle.bundleId.toLowerCase() !== destination.bundleId.toLowerCase()
        ? previewBundle
        : undefined,
    [previewBundle],
  );

  const canDropIntoFolder = useCallback(
    (item: DraggedWorkflowItem | null, destinationPath: string) => {
      if (!item || item.parentRelativePath === destinationPath) {
        return false;
      }
      const destinationBundle = flattenedFolders.find(
        (folder) =>
          folder.bundleId &&
          (destinationPath === folder.relativePath || destinationPath.startsWith(`${folder.relativePath}/`)),
      );
      if (
        destinationBundle &&
        item.itemType === 'folder' &&
        flattenedFolders.some(
          (folder) =>
            folder.bundleId &&
            (folder.relativePath === item.relativePath || folder.relativePath.startsWith(`${item.relativePath}/`)),
        )
      )
        return false;
      return (
        item.itemType !== 'folder' ||
        !(item.relativePath === destinationPath || destinationPath.startsWith(`${item.relativePath}/`))
      );
    },
    [flattenedFolders],
  );

  const reset = useCallback(() => {
    setState({ draggedItem: null, dropTargetFolderPath: null, dragOverRoot: false, dragPreview: null });
  }, []);

  const clearDropTarget = useCallback(() => {
    setState((previous) =>
      previous.dropTargetFolderPath === null && !previous.dragOverRoot && !previous.dragPreview
        ? previous
        : { ...previous, dropTargetFolderPath: null, dragOverRoot: false, dragPreview: null },
    );
  }, []);

  const moveDraggedItem = useCallback(
    async (destinationPath: string) => {
      if (!draggedItem || !canDropIntoFolder(draggedItem, destinationPath)) {
        return;
      }

      setMovePending(true);
      const isCurrent = captureAction();
      try {
        const owner = (path: string) =>
          flattenedFolders.find(
            (folder) => folder.bundleId && (path === folder.relativePath || path.startsWith(`${folder.relativePath}/`)),
          )?.bundleId ?? null;
        const sourceIsBundle =
          draggedItem.itemType === 'folder' &&
          flattenedFolders.some((folder) => folder.relativePath === draggedItem.relativePath && folder.bundleId);
        if (
          !sourceIsBundle &&
          owner(draggedItem.parentRelativePath) !== owner(destinationPath) &&
          !window.confirm(
            'This move changes bundle membership. References remain unchanged; Remote Debugger grouping follows the new membership. Continue?',
          )
        )
          return;
        const sourceFolder =
          draggedItem.itemType === 'folder'
            ? flattenedFolders.find((folder) => folder.relativePath === draggedItem.relativePath) ?? null
            : null;
        const result = await moveWorkflowItem(
          draggedItem.itemType,
          draggedItem.relativePath,
          destinationPath,
          draggedItem.expectedSource,
          destinationPath === ''
            ? null
            : flattenedFolders.find((folder) => folder.relativePath === destinationPath)?.namespaceId,
        );
        if (result.folder && !requiresFreshNamespaceTree(result) && isCurrent()) {
          const movedFolder = result.folder;
          if (draggedItem.itemType === 'folder') {
            setExpandedFolders((previous) => ({
              ...remapExpandedFolderIds(previous, draggedItem.relativePath, movedFolder.relativePath),
              [movedFolder.id]: true,
            }));
          } else {
            setExpandedFolders((previous) => ({ ...previous, [movedFolder.id]: true }));
          }
        }

        await reconcileNamespaceMove({
          result,
          sourceFolder,
          folders,
          rootProjects,
          setFolders,
          setRootProjects,
          sourceProject: [...rootProjects, ...flattenProjects(folders)].find(
            (project) => project.relativePath === draggedItem.relativePath,
          ),
          applyProjectPathMoves,
          reconcileTree,
          afterRead: (tree) => {
            if (!isCurrent() || !tree || !result.folder?.namespaceId) return;
            const current = flattenFolders(tree.folders).find(
              (item) => item.namespaceId === result.folder!.namespaceId,
            );
            if (!current) return;
            const ancestors = flattenFolders(tree.folders).filter(
              (item) =>
                current.relativePath === item.relativePath || current.relativePath.startsWith(`${item.relativePath}/`),
            );
            setExpandedFolders((previous) => ({
              ...previous,
              ...Object.fromEntries(ancestors.map((item) => [item.id, true])),
            }));
          },
        });
      } catch (error) {
        if (error instanceof MutationOutcomeUnknownError) reconcileTree(error.message);
        toast.error(error instanceof Error ? error.message : 'Failed to move workflow item');
      } finally {
        setMovePending(false);
        reset();
      }
    },
    [
      applyProjectPathMoves,
      captureAction,
      canDropIntoFolder,
      draggedItem,
      flattenedFolders,
      folders,
      reconcileTree,
      reset,
      rootProjects,
      setExpandedFolders,
      setFolders,
      setRootProjects,
    ],
  );

  const handleDragStart = useCallback(
    (item: DraggedWorkflowItem) => (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.relativePath);
      const bundle =
        onBundleMerge && item.itemType === 'folder'
          ? flattenedFolders.find((folder) => folder.relativePath === item.relativePath && folder.bundleId)
          : undefined;
      if (bundle) {
        // The native bitmap cannot change after dragstart. Render the changing
        // bundle/merge feedback in a pointer-transparent portal instead.
        const image = document.createElement('canvas');
        image.width = image.height = 1;
        event.dataTransfer.setDragImage(image, 0, 0);
      }
      setState({
        draggedItem: item,
        dropTargetFolderPath: null,
        dragOverRoot: false,
        dragPreview: null,
      });
    },
    [flattenedFolders, onBundleMerge],
  );
  const handleDragEnd = useCallback(reset, [reset]);
  const handleFolderDragOver = useCallback(
    (folder: WorkflowFolderItem) => (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      const mergeSource = getBundleMergeSource(folder);
      if (!mergeSource && !canDropIntoFolder(draggedItem, folder.relativePath)) {
        clearDropTarget();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setState((previous) => ({
        ...previous,
        dropTargetFolderPath: folder.relativePath,
        dragOverRoot: false,
        dragPreview: previewBundle
          ? { name: previewBundle.name, x: event.clientX, y: event.clientY, merge: !!mergeSource }
          : null,
      }));
    },
    [canDropIntoFolder, clearDropTarget, draggedItem, getBundleMergeSource, previewBundle],
  );
  const handleFolderDrop = useCallback(
    (folder: WorkflowFolderItem) => async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const mergeSource = getBundleMergeSource(folder);
      if (mergeSource && onBundleMerge) {
        reset();
        onBundleMerge(mergeSource, folder, event.currentTarget);
        return;
      }
      await moveDraggedItem(folder.relativePath);
    },
    [getBundleMergeSource, moveDraggedItem, onBundleMerge, reset],
  );
  const handleRootDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDropIntoFolder(draggedItem, '')) {
        clearDropTarget();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setState((previous) => ({
        ...previous,
        dropTargetFolderPath: ROOT_DROP_TARGET,
        dragOverRoot: true,
        dragPreview: previewBundle
          ? { name: previewBundle.name, x: event.clientX, y: event.clientY, merge: false }
          : null,
      }));
    },
    [canDropIntoFolder, clearDropTarget, draggedItem, previewBundle],
  );
  const handleRootDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      await moveDraggedItem('');
    },
    [moveDraggedItem],
  );
  const handleRootDragLeave = useCallback(() => {
    setState((previous) => ({
      ...previous,
      dragOverRoot: false,
      dropTargetFolderPath: previous.dropTargetFolderPath === ROOT_DROP_TARGET ? null : previous.dropTargetFolderPath,
      dragPreview: previous.dropTargetFolderPath === ROOT_DROP_TARGET ? null : previous.dragPreview,
    }));
  }, []);
  const handleFolderDragLeave = useCallback((folder: WorkflowFolderItem) => {
    setState((previous) =>
      previous.dropTargetFolderPath === folder.relativePath
        ? {
            ...previous,
            dropTargetFolderPath: null,
            dragPreview: null,
          }
        : previous,
    );
  }, []);

  return {
    dragOverRoot,
    draggedItem,
    dragPreview: state.dragPreview,
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
