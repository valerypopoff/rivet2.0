import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'react-toastify';
import type { WorkflowFolderItem } from './types';
import type { WorkflowBundleConversionFailure } from './WorkflowBundleConversionErrorModal';
import type { WorkflowBundleDeleteResult } from './WorkflowBundleDeleteModal';
import type { LibraryMutationCompletion } from './workflowNamespaceReconciliation';
import { requestWorkflowBundle } from './workflowApi';
import { flattenFolders } from './workflowLibraryHelpers';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';

type WorkflowBundleActionsOptions = {
  activePath: string;
  contextMenu: { folder: WorkflowFolderItem; opener: HTMLElement } | null;
  closeContextMenu(): void;
  canMergeBundles: boolean;
  flattenedFolders: WorkflowFolderItem[];
  treeMutationPending: boolean;
  uploadingFolderPath: string | null;
  reconcileTree: LibraryMutationCompletion;
  setExpandedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
  onDeleteProject(path: string, projectId?: string | null): void;
};

export function useWorkflowBundleActions({
  activePath,
  contextMenu,
  closeContextMenu,
  canMergeBundles,
  flattenedFolders,
  treeMutationPending,
  uploadingFolderPath,
  reconcileTree,
  setExpandedFolders,
  onDeleteProject,
}: WorkflowBundleActionsOptions) {
  const [bundleUploadFolder, setBundleUploadFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleDeleteFolder, setBundleDeleteFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleMergeRequest, setBundleMergeRequest] = useState<{
    source: WorkflowFolderItem;
    destinationBundleId?: string;
  } | null>(null);
  const bundleMergeOpener = useRef<HTMLElement | null>(null);
  const [bundleAction, setBundleAction] = useState<{ kind: 'conversion' | 'duplication'; name: string } | null>(null);
  const [bundleConversionFailure, setBundleConversionFailure] = useState<WorkflowBundleConversionFailure | null>(null);
  const [bundleFolder, setBundleFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);
  const bundleActionPending = useRef(false);
  const captureBundleAction = useWorkflowLibraryActionLifetime(activePath);

  const openBundleMerge = useCallback(
    (source: WorkflowFolderItem, destination?: WorkflowFolderItem, opener?: HTMLElement) => {
      if (!source.bundleId || !canMergeBundles || bundleActionPending.current) return;
      if (
        destination &&
        (!destination.bundleId || destination.bundleId.toLowerCase() === source.bundleId.toLowerCase())
      )
        return;
      bundleMergeOpener.current = opener ?? null;
      closeContextMenu();
      setBundleMergeRequest({ source, destinationBundleId: destination?.bundleId ?? undefined });
    },
    [canMergeBundles, closeContextMenu],
  );

  const openBundleDelete = useCallback(
    (folder: WorkflowFolderItem) => {
      if (bundleActionPending.current) return;
      closeContextMenu();
      setBundleDeleteFolder(folder);
    },
    [closeContextMenu],
  );

  const handleDownloadBundle = () => {
    const folder = contextMenu?.folder;
    if (!folder?.bundleId) return;
    closeContextMenu();
    setBundleFolder(folder);
    setBundleOpen(true);
  };
  const canUploadBundleToFolder = (target: WorkflowFolderItem) =>
    !flattenedFolders.some(
      (folder) =>
        folder.bundleId &&
        (target.relativePath === folder.relativePath || target.relativePath.startsWith(`${folder.relativePath}/`)),
    );
  const handleUploadBundleFromFolder = () => {
    const target = contextMenu?.folder;
    if (!target || !canUploadBundleToFolder(target) || treeMutationPending || uploadingFolderPath) return;
    closeContextMenu();
    setBundleUploadFolder(target);
  };
  const expandCommittedBundle = (folder: WorkflowFolderItem, message: string, isCurrent: () => boolean) => {
    reconcileTree(message, (tree) => {
      if (!isCurrent() || !tree) return;
      const folders = flattenFolders(tree.folders);
      const current = folders.find((item) =>
        folder.namespaceId ? item.namespaceId === folder.namespaceId : item.bundleId === folder.bundleId,
      );
      if (!current) return;
      const ancestors = folders.filter(
        (item) =>
          current.relativePath === item.relativePath || current.relativePath.startsWith(`${item.relativePath}/`),
      );
      setExpandedFolders((previous) => ({
        ...previous,
        ...Object.fromEntries(ancestors.map((item) => [item.id, true])),
      }));
    });
  };
  const toggleBundleKind = async () => {
    const folder = contextMenu?.folder;
    if (!folder || bundleActionPending.current) return;
    const isCurrent = captureBundleAction();
    closeContextMenu();
    if (
      !window.confirm(
        folder.bundleId
          ? 'Convert to an ordinary folder? Projects and references are preserved. Shared Remote Debugger membership will be removed.'
          : 'Convert this folder and its projects to a bundle? References and publications are unchanged.',
      )
    )
      return;
    bundleActionPending.current = true;
    setBundleAction({ kind: 'conversion', name: folder.name });
    setBundleConversionFailure(null);
    try {
      await requestWorkflowBundle('/kind', {
        relativePath: folder.relativePath,
        enabled: !folder.bundleId,
        namespaceId: folder.namespaceId,
      });
      reconcileTree(
        'Conversion completed, but the project list could not refresh. Refresh the tree to see the updated folder or bundle before trying again.',
      );
    } catch (failure) {
      if (failure instanceof MutationOutcomeUnknownError) reconcileTree(failure.message);
      if (isCurrent())
        setBundleConversionFailure({
          folderPath: folder.relativePath,
          creatingBundle: !folder.bundleId,
          message: failure instanceof Error ? failure.message : 'Bundle conversion failed.',
          referenceConflict:
            failure instanceof Error && 'code' in failure && failure.code === 'bundle_cross_bundle_reference',
        });
    } finally {
      bundleActionPending.current = false;
      setBundleAction(null);
    }
  };
  const duplicateBundle = async () => {
    const source = contextMenu?.folder;
    if (!source?.bundleId || bundleActionPending.current) return;
    const isCurrent = captureBundleAction();
    closeContextMenu();
    bundleActionPending.current = true;
    setBundleAction({ kind: 'duplication', name: source.name });
    try {
      const result = await requestWorkflowBundle<{ folder: WorkflowFolderItem; warnings?: string[] }>(
        `/${source.bundleId}/duplicate`,
        { automatic: true },
        undefined,
        source.namespaceId
          ? { expectedSource: { id: source.namespaceId }, relativePath: source.relativePath }
          : undefined,
      );
      expandCommittedBundle(
        result.folder,
        'The copy was created, but the project list could not refresh. Refresh the tree to see it; do not duplicate again.',
        isCurrent,
      );
      if (!isCurrent()) return;
      const message = `${result.folder.name} duplicated from saved versions. Unsaved edits were not copied.`;
      const firstWarning = result.warnings?.[0] ?? '';
      const warningExample = Array.from(firstWarning).slice(0, 160).join('');
      const definitionWarnings = result.warnings?.length
        ? ` ${result.warnings.length} copied ${result.warnings.length === 1 ? 'project needs' : 'projects need'} definition review. ${warningExample}${warningExample.length < firstWarning.length ? '…' : ''}`
        : '';
      if (definitionWarnings) toast.warn(`${message}${definitionWarnings}`);
      else toast.success(message);
    } catch (failure) {
      if (failure instanceof MutationOutcomeUnknownError) reconcileTree(failure.message);
      if (isCurrent())
        toast.error(
          `${failure instanceof Error ? failure.message : 'Could not duplicate bundle.'} Refresh the tree before retrying if the response was lost.`,
        );
    } finally {
      bundleActionPending.current = false;
      setBundleAction(null);
    }
  };
  const handleBundleImported = (folder: WorkflowFolderItem) => {
    const isCurrent = captureBundleAction();
    setBundleUploadFolder(null);
    expandCommittedBundle(folder, 'Bundle imported, but library synchronization is pending.', isCurrent);
  };

  const handleBundleDeleted = (result: WorkflowBundleDeleteResult, options: { closeModal: boolean }) => {
    if (options.closeModal) setBundleDeleteFolder(null);
    for (const project of result.deletedProjects) onDeleteProject(project.path, project.projectId);
    if (options.closeModal) toast.success('Bundle deleted.');
  };

  return {
    openBundleMerge,
    openBundleDelete,
    bundleMergeFolder: bundleMergeRequest?.source ?? null,
    bundleMergeDestinationId: bundleMergeRequest?.destinationBundleId,
    closeBundleMerge: () => {
      setBundleMergeRequest(null);
      const opener = bundleMergeOpener.current;
      bundleMergeOpener.current = null;
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    },
    handleMergeBundle: () => {
      if (contextMenu) openBundleMerge(contextMenu.folder, undefined, contextMenu.opener);
    },
    bundleAction,
    bundleDeleteFolder,
    closeBundleDelete: () => setBundleDeleteFolder(null),
    handleBundleDeleted,
    bundleConversionFailure,
    closeBundleConversionFailure: () => setBundleConversionFailure(null),
    handleToggleBundleKind: toggleBundleKind,
    handleDuplicateBundle: duplicateBundle,
    bundleUploadFolder,
    closeBundleUpload: () => setBundleUploadFolder(null),
    handleUploadBundleFromFolder,
    canUploadBundleToFolder,
    handleBundleImported,
    bundleFolder,
    bundleOpen,
    handleDownloadBundle,
    closeBundleModal: () => setBundleOpen(false),
  };
}
