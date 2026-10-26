import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cssTransition, toast } from 'react-toastify';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
  WorkflowPublishedVersionRestoreResponse,
  RecordingOpenResult,
} from './types';
import type {
  ProjectCompareSideLabels,
  WorkflowProjectBindingReconciliationResult,
  HostedProjectReconciliationContext,
} from '../../studio-server-shared/editor-bridge';
import type { WorkflowProjectEditorBinding } from '../../studio-server-shared/workflow-types';
import { isWorkflowProjectFullyUnpublished } from './projectSettingsForm';
import { useRunRecordingsModalState } from './useRunRecordingsModalState';
import { useWorkflowLibraryDragAndDrop } from './useWorkflowLibraryDragAndDrop';
import { useWorkflowLibraryMutations } from './useWorkflowLibraryMutations';
import { useWorkflowLibrarySelection } from './useWorkflowLibrarySelection';
import { useWorkflowLibraryTree } from './useWorkflowLibraryTree';
import { useWorkflowLibraryTreeSync } from './useWorkflowLibraryTreeSync';
import { useWorkflowProjectVersionActions } from './useWorkflowProjectVersionActions';
import { isPlainF2ShortcutEvent } from './editorBridgeFocus';
import { requestWorkflowBundle } from './workflowApi';
import type { WorkflowBundleConversionFailure } from './WorkflowBundleConversionErrorModal';
import type { WorkflowBundleDeleteResult } from './WorkflowBundleDeleteModal';
import { flattenFolders } from './workflowLibraryHelpers';
import type { LibraryMutationCompletion } from './workflowNamespaceReconciliation';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';

export const instantWarningToastTransition = cssTransition({
  enter: 'workflow-toast-instant-enter',
  exit: 'workflow-toast-instant-exit',
  collapse: false,
});

type WorkflowFolderContextMenuState = {
  folder: WorkflowFolderItem;
  x: number;
  y: number;
};

type WorkflowProjectContextMenuState = {
  project: WorkflowProjectItem;
  x: number;
  y: number;
};

function isFolderEmpty(folder: WorkflowFolderItem): boolean {
  return folder.folders.length === 0 && folder.projects.length === 0;
}

export function useWorkflowLibraryController(options: {
  onOpenProject: (path: string, nextOptions?: WorkflowProjectOpenOptions) => void;
  onRefreshOpenProjectFromDisk: (path: string) => void;
  onOpenRecording: (recordingId: string, nextOptions?: { replaceCurrent?: boolean }) => Promise<RecordingOpenResult>;
  onOpenPublishedVersionPreview: (
    relativePath: string,
    versionId: string,
    nextOptions?: { replaceCurrent?: boolean },
  ) => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => Promise<void> | void;
  onReconcileWorkflowProjectBindings: (
    bindings: WorkflowProjectEditorBinding[],
    context: HostedProjectReconciliationContext,
  ) => Promise<WorkflowProjectBindingReconciliationResult>;
  onCaptureProjectReconciliation: () => Promise<HostedProjectReconciliationContext | null>;
  reconciliationSequence: number;
  onWorkflowProjectOpenIntent: (path: string) => void;
  onWorkflowProjectOpenIntentCanceled: (path: string) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  editorReady: boolean;
  projectSaveSequence: number;
}) {
  const {
    onOpenProject,
    onRefreshOpenProjectFromDisk,
    onOpenRecording,
    onOpenPublishedVersionPreview,
    onCompareOpenProjectWith,
    onDeleteProject,
    onWorkflowPathsMoved,
    onReconcileWorkflowProjectBindings,
    onCaptureProjectReconciliation,
    reconciliationSequence,
    onWorkflowProjectOpenIntent,
    onWorkflowProjectOpenIntentCanceled,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    editorReady,
    projectSaveSequence,
  } = options;

  const {
    explicitBundles,
    namespaceMutations,
    allProjects,
    error,
    expandedFolders,
    flattenedFolders,
    folderIds,
    folders,
    loading,
    localRefreshSequence,
    reconcileInBackground: reconcileWorkflowTreeInBackground,
    refresh,
    refreshFromRemoteChange,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
    syncRef,
  } = useWorkflowLibraryTree();
  const runRecordings = useRunRecordingsModalState();
  const [settingsModalProject, setSettingsModalProject] = useState<WorkflowProjectItem | null>(null);
  const [settingsModalInitialTab, setSettingsModalInitialTab] = useState<'workflow' | 'danger'>('workflow');
  const [runStatisticsOpen, setRunStatisticsOpen] = useState(false);
  const [publishedItemsOpen, setPublishedItemsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [folderContextMenuState, setFolderContextMenuState] = useState<WorkflowFolderContextMenuState | null>(null);
  const [bundleUploadFolder, setBundleUploadFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleDeleteFolder, setBundleDeleteFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleAction, setBundleAction] = useState<{ kind: 'conversion' | 'duplication'; name: string } | null>(null);
  const [bundleConversionFailure, setBundleConversionFailure] = useState<WorkflowBundleConversionFailure | null>(null);
  const bundleActionPending = useRef(false);
  const [projectContextMenuState, setProjectContextMenuState] = useState<WorkflowProjectContextMenuState | null>(null);
  const selection = useWorkflowLibrarySelection({
    error,
    allProjects,
    expandedFolders,
    flattenedFolders,
    loading,
    onActiveWorkflowProjectPathChange,
    onOpenProject,
    onWorkflowProjectOpenIntent,
    onWorkflowProjectOpenIntentCanceled,
    openedProjectPath,
    setExpandedFolders,
  });
  const {
    activePath,
    activeProject,
    cancelPendingPreviewOpen,
    isActiveProjectOpen,
    openedWorkflowProject,
    openedWorkflowProjectRef,
    openPersistent,
    remapSelectedPath,
    setProjectRowRef,
    suppressAncestorExpansion,
    toggleAllFoldersExpanded,
    toggleFolderExpanded,
  } = selection;
  const captureBundleAction = useWorkflowLibraryActionLifetime(activePath);

  const settingsModalOpen = settingsModalProject != null;

  useEffect(() => {
    if (!settingsModalOpen || !settingsModalProject) {
      return;
    }

    const matchingProject = allProjects.find((project) =>
      settingsModalProject.projectMetadataId
        ? project.projectMetadataId === settingsModalProject.projectMetadataId
        : project.absolutePath === settingsModalProject.absolutePath,
    );
    if (matchingProject) {
      setSettingsModalProject(matchingProject);
    }
  }, [allProjects, settingsModalOpen, settingsModalProject]);

  const applyWorkflowProjectPathMoves = useCallback(
    async (moves: WorkflowProjectPathMove[]) => {
      if (moves.length === 0) {
        return;
      }

      remapSelectedPath(moves);
      setSettingsModalProject((prev) => {
        if (!prev) {
          return prev;
        }

        const nextPath = moves.find((move) => move.fromAbsolutePath === prev.absolutePath)?.toAbsolutePath;
        return nextPath ? { ...prev, absolutePath: nextPath } : prev;
      });
      await onWorkflowPathsMoved(moves);
    },
    [onWorkflowPathsMoved, remapSelectedPath],
  );

  const mutations = useWorkflowLibraryMutations({
    namespaceMutations,
    activePath,
    applyProjectPathMoves: applyWorkflowProjectPathMoves,
    folders,
    onOpenProject,
    reconcileTree: reconcileWorkflowTreeInBackground,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
    suppressAncestorExpansion,
  });
  const {
    addProject: handleAddProject,
    cancelFolderRename: handleCancelFolderRename,
    cancelProjectRename: handleCancelProjectRename,
    clearInlineEditing,
    createFolder: handleCreateFolder,
    deleteFolder: handleDeleteFolder,
    editingFolderId,
    editingProjectPath,
    renamingFolderId,
    renamingProjectPath,
    startFolderRename: handleStartFolderRename,
    startProjectRename: handleStartProjectRename,
    submitFolderRename: handleSubmitFolderRename,
    submitProjectRename: handleSubmitProjectRename,
    treeMutationPending,
    uploadProject,
    uploadingFolderPath,
  } = mutations;

  const startProjectRename = useCallback(
    (project: WorkflowProjectItem) => {
      cancelPendingPreviewOpen(project.absolutePath);
      handleStartProjectRename(project);
    },
    [cancelPendingPreviewOpen, handleStartProjectRename],
  );

  const dragAndDrop = useWorkflowLibraryDragAndDrop({
    activePath,
    applyProjectPathMoves: applyWorkflowProjectPathMoves,
    flattenedFolders,
    folders,
    reconcileTree: reconcileWorkflowTreeInBackground,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
  });
  const {
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
  } = dragAndDrop;

  const closeProjectContextMenu = useCallback(() => {
    setProjectContextMenuState(null);
  }, []);

  const closeFolderContextMenu = useCallback(() => {
    setFolderContextMenuState(null);
  }, []);

  const versionActions = useWorkflowProjectVersionActions({
    closeProjectContextMenu,
    onCompareOpenProjectWith,
    openedWorkflowProject,
    openedWorkflowProjectRef,
    projectContextMenuProject: projectContextMenuState?.project ?? null,
    reconcileTree: reconcileWorkflowTreeInBackground,
    uploadingFolderPath,
  });
  const [bundleFolder, setBundleFolder] = useState<WorkflowFolderItem | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);
  const handleDownloadBundle = () => {
    const folder = folderContextMenuState?.folder;
    if (!folder?.bundleId) return;
    closeFolderContextMenu();
    setBundleFolder(folder);
    setBundleOpen(true);
  };
  const {
    canCompareOpenedProjectToPublishedVersion,
    canCompareWithProject,
    closeProjectModal,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    handleCompareOpenedProjectToPublishedVersionFromContextMenu,
    handleCompareProjectFromContextMenu,
    handleDownloadProject,
    handleDuplicateProject,
    handleProjectModalSelectPublished,
    handleProjectModalSelectUnpublishedChanges,
    projectModalActiveVersion,
    projectModalMode,
    projectModalProject,
  } = versionActions;

  const projectTreeOverlayOpen = Boolean(
    bundleDeleteFolder ||
      bundleOpen ||
      appSettingsOpen ||
      folderContextMenuState ||
      projectContextMenuState ||
      projectModalProject ||
      runRecordings.open ||
      runStatisticsOpen ||
      publishedItemsOpen ||
      settingsModalOpen,
  );

  useWorkflowLibraryTreeSync({
    currentSyncRef: syncRef,
    localRefreshSequence,
    projectSaveSequence,
    isLocalTreeInteractionActive: Boolean(
      draggedItem ||
        movePending ||
        editingFolderId ||
        editingProjectPath ||
        renamingFolderId ||
        renamingProjectPath ||
        treeMutationPending ||
        uploadingFolderPath ||
        duplicatingProjectPath,
    ),
    openedProjectPath,
    openedProjectRef: openedWorkflowProjectRef,
    editorReady,
    refreshFromRemoteChange,
    reconcileProjectBindings: onReconcileWorkflowProjectBindings,
    captureReconciliation: onCaptureProjectReconciliation,
    reconciliationSequence,
  });

  const startSelectedProjectRename = useCallback(() => {
    if (
      !activeProject ||
      activeProject.absolutePath !== activePath ||
      editingFolderId ||
      editingProjectPath ||
      renamingFolderId ||
      renamingProjectPath ||
      treeMutationPending ||
      movePending ||
      comparingProjectPath ||
      downloadingProjectPath ||
      duplicatingProjectPath ||
      projectTreeOverlayOpen ||
      uploadingFolderPath
    ) {
      return false;
    }

    startProjectRename(activeProject);
    return true;
  }, [
    activePath,
    activeProject,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    editingFolderId,
    editingProjectPath,
    movePending,
    projectTreeOverlayOpen,
    renamingFolderId,
    renamingProjectPath,
    startProjectRename,
    treeMutationPending,
    uploadingFolderPath,
  ]);

  useEffect(() => {
    const handleFallbackProjectRenameShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isPlainF2ShortcutEvent(event)) {
        return;
      }

      const focusedElement = document.activeElement;
      if (focusedElement !== document.body && focusedElement !== document.documentElement) {
        return;
      }

      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return;
      }

      if (startSelectedProjectRename()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleFallbackProjectRenameShortcut, true);
    return () => window.removeEventListener('keydown', handleFallbackProjectRenameShortcut, true);
  }, [startSelectedProjectRename]);

  const handleFolderContextMenu = useCallback(
    (folder: WorkflowFolderItem, event: MouseEvent<HTMLDivElement>) => {
      if (comparingProjectPath || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      clearInlineEditing();
      setProjectContextMenuState(null);
      setFolderContextMenuState({
        folder,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [clearInlineEditing, comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath],
  );

  const handleProjectContextMenu = useCallback(
    (project: WorkflowProjectItem, event: MouseEvent<HTMLElement>) => {
      if (comparingProjectPath || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      clearInlineEditing();
      setFolderContextMenuState(null);
      setProjectContextMenuState({
        project,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [clearInlineEditing, comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath],
  );

  const handleUploadProjectFromFolder = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    await uploadProject(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    uploadProject,
    uploadingFolderPath,
  ]);

  const canUploadBundleToFolder = (target: WorkflowFolderItem) =>
    !flattenedFolders.some(
      (folder) =>
        folder.bundleId &&
        (target.relativePath === folder.relativePath || target.relativePath.startsWith(`${folder.relativePath}/`)),
    );
  const handleUploadBundleFromFolder = () => {
    const target = folderContextMenuState?.folder;
    if (!target || !canUploadBundleToFolder(target) || treeMutationPending || uploadingFolderPath) return;
    closeFolderContextMenu();
    setBundleUploadFolder(target);
  };
  const refreshTreeAfterBundleChange: LibraryMutationCompletion = (message, afterRead) =>
    reconcileWorkflowTreeInBackground(message, afterRead);
  const expandCommittedBundle = (folder: WorkflowFolderItem, message: string, isCurrent: () => boolean) => {
    refreshTreeAfterBundleChange(message, (tree) => {
      if (!isCurrent()) return;
      const current =
        tree &&
        flattenFolders(tree.folders).find((item) =>
          folder.namespaceId ? item.namespaceId === folder.namespaceId : item.bundleId === folder.bundleId,
        );
      if (!current) return;
      const ancestors = flattenFolders(tree!.folders).filter(
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
    const folder = folderContextMenuState?.folder;
    if (!folder || bundleActionPending.current) return;
    const isCurrent = captureBundleAction();
    closeFolderContextMenu();
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
      refreshTreeAfterBundleChange(
        'Conversion completed, but the project list could not refresh. Refresh the tree to see the updated folder or bundle before trying again.',
      );
    } catch (failure) {
      if (failure instanceof MutationOutcomeUnknownError) refreshTreeAfterBundleChange(failure.message);
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
    const source = folderContextMenuState?.folder;
    if (!source?.bundleId || bundleActionPending.current) return;
    const isCurrent = captureBundleAction();
    closeFolderContextMenu();
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
      if (failure instanceof MutationOutcomeUnknownError) refreshTreeAfterBundleChange(failure.message);
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

  const handleCreateProjectFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    await handleAddProject(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleAddProject,
    uploadingFolderPath,
  ]);

  const handleCreateFolderFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    await handleCreateFolder(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleCreateFolder,
    uploadingFolderPath,
  ]);

  const handleRenameFolderFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    handleStartFolderRename(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleStartFolderRename,
    uploadingFolderPath,
  ]);

  const handleDeleteFolderFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    if (targetFolder.bundleId) {
      if (bundleActionPending.current) return;
      closeFolderContextMenu();
      setBundleDeleteFolder(targetFolder);
      return;
    }

    if (!isFolderEmpty(targetFolder)) {
      toast.error('You can only delete empty folders', {
        transition: instantWarningToastTransition,
      });
      return;
    }

    closeFolderContextMenu();
    await handleDeleteFolder(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleDeleteFolder,
    uploadingFolderPath,
  ]);

  const handleBundleDeleted = (result: WorkflowBundleDeleteResult, options: { closeModal: boolean }) => {
    if (options.closeModal) setBundleDeleteFolder(null);
    for (const project of result.deletedProjects) onDeleteProject(project.path, project.projectId);
    if (options.closeModal) toast.success('Bundle deleted.');
  };

  const openProjectSettingsModal = useCallback(
    (project: WorkflowProjectItem, initialTab: 'workflow' | 'danger' = 'workflow') => {
      setSettingsModalInitialTab(initialTab);
      setSettingsModalProject(project);
    },
    [],
  );

  const handleOpenSettings = useCallback(() => {
    if (!activeProject) {
      return;
    }

    openProjectSettingsModal(activeProject);
  }, [activeProject, openProjectSettingsModal]);

  const handleDeleteProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    const fullyUnpublished = isWorkflowProjectFullyUnpublished(targetProject);
    if (!fullyUnpublished) {
      toast.error('To delete a project, unpublish its workflow endpoint and web apps first', {
        transition: instantWarningToastTransition,
      });
    }

    closeProjectContextMenu();
    openProjectSettingsModal(targetProject, fullyUnpublished ? 'danger' : 'workflow');
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    openProjectSettingsModal,
    projectContextMenuState,
    uploadingFolderPath,
  ]);

  const handleRenameProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();
    startProjectRename(targetProject);
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuState,
    startProjectRename,
    uploadingFolderPath,
  ]);

  const closeSettingsModal = useCallback(() => {
    setSettingsModalProject(null);
  }, []);

  const handlePublishedVersionRestored = useCallback(
    async (response: WorkflowPublishedVersionRestoreResponse) => {
      onRefreshOpenProjectFromDisk(response.project.absolutePath);
      await refresh(false);
    },
    [onRefreshOpenProjectFromDisk, refresh],
  );

  const handleFolderRowClick = useCallback(
    (folder: WorkflowFolderItem) => (event: MouseEvent<HTMLElement>) => {
      if (editingFolderId === folder.id || renamingFolderId === folder.id) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        toggleAllFoldersExpanded(folder.id);
        return;
      }

      toggleFolderExpanded(folder.id);
    },
    [editingFolderId, renamingFolderId, toggleAllFoldersExpanded, toggleFolderExpanded],
  );

  const handleFolderRowKeyDown = useCallback(
    (folder: WorkflowFolderItem) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (editingFolderId === folder.id || renamingFolderId === folder.id) {
        return;
      }

      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      toggleFolderExpanded(folder.id);
    },
    [editingFolderId, renamingFolderId, toggleFolderExpanded],
  );

  const openPublishedItemProject = useCallback(
    (project: WorkflowProjectItem) => {
      setPublishedItemsOpen(false);
      openPersistent(project);
    },
    [openPersistent],
  );

  const handleProjectRowKeyDown = useCallback(
    (project: WorkflowProjectItem) => (event: KeyboardEvent<HTMLElement>) => {
      if (!isPlainF2ShortcutEvent(event) || project.absolutePath !== activePath || !startSelectedProjectRename()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [activePath, startSelectedProjectRename],
  );

  return {
    explicitBundles,
    bundleAction,
    bundleDeleteFolder,
    closeBundleDelete: () => setBundleDeleteFolder(null),
    handleBundleDeleted,
    bundleConversionFailure,
    closeBundleConversionFailure: () => setBundleConversionFailure(null),
    handleToggleBundleKind: toggleBundleKind,
    handleDuplicateBundle: duplicateBundle,
    bundleFolders: flattenedFolders,
    bundleUploadFolder,
    closeBundleUpload: () => setBundleUploadFolder(null),
    handleUploadBundleFromFolder,
    canUploadBundleToFolder,
    handleBundleImported,
    bundleFolder,
    bundleOpen,
    handleDownloadBundle,
    closeBundleModal: () => setBundleOpen(false),
    folders,
    rootProjects,
    folderIds,
    allProjects,
    activePath,
    openedWorkflowProject,
    activeProject,
    loading,
    error,
    expandedFolders,
    draggedItem,
    dropTargetFolderPath,
    dragOverRoot,
    downloadingProjectPath,
    duplicatingProjectPath,
    uploadingFolderPath,
    editingFolderId,
    renamingFolderId,
    editingProjectPath,
    renamingProjectPath,
    settingsModalOpen,
    settingsModalProject,
    settingsModalInitialTab,
    runRecordingsOpen: runRecordings.open,
    runRecordingsRetained: runRecordings.retained,
    runRecordingsFoundCount: runRecordings.foundCount,
    runRecordingsResetToken: runRecordings.resetToken,
    runStatisticsOpen,
    publishedItemsOpen,
    appSettingsOpen,
    folderContextMenuState,
    projectContextMenuState,
    projectModalProject,
    projectModalMode,
    projectModalActiveVersion,
    isActiveProjectOpen,
    refresh,
    handleCreateFolder,
    handleOpenSettings,
    closeSettingsModal,
    handlePublishedVersionRestored,
    closeProjectContextMenu,
    closeFolderContextMenu,
    closeProjectModal,
    handleProjectContextMenu,
    handleFolderContextMenu,
    handleDragStart,
    handleDragEnd,
    handleFolderRowClick,
    handleFolderRowKeyDown,
    handleProjectRowKeyDown,
    handleFolderDragOver,
    handleFolderDrop,
    handleFolderDragLeave,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    handleUploadProjectFromFolder,
    handleCreateFolderFromContextMenu,
    handleCreateProjectFromContextMenu,
    handleRenameFolderFromContextMenu,
    handleSubmitFolderRename,
    handleCancelFolderRename,
    handleDeleteFolderFromContextMenu,
    handleRenameProjectFromContextMenu,
    handleSubmitProjectRename,
    handleCancelProjectRename,
    handleDownloadProject,
    handleDuplicateProject,
    handleCompareProjectFromContextMenu,
    canCompareWithProject,
    handleCompareOpenedProjectToPublishedVersionFromContextMenu,
    canCompareOpenedProjectToPublishedVersion,
    handleDeleteProjectFromContextMenu,
    handleProjectModalSelectPublished,
    handleProjectModalSelectUnpublishedChanges,
    setRunStatisticsOpen,
    setPublishedItemsOpen,
    openPublishedItemProject,
    openRunRecordingsModal: runRecordings.show,
    hideRunRecordingsModal: runRecordings.hide,
    closeRunRecordingsModal: runRecordings.close,
    handleRunRecordingsFoundCountChange: runRecordings.setFoundCount,
    setAppSettingsOpen,
    onOpenRecording,
    onOpenPublishedVersionPreview: (relativePath: string, versionId: string) => {
      setSettingsModalProject(null);
      onOpenPublishedVersionPreview(relativePath, versionId);
    },
    onProjectPreviewOpen: selection.openPreview,
    onProjectPersistentOpen: selection.openPersistent,
    onWorkflowPathsMoved: applyWorkflowProjectPathMoves,
    onDeleteProject,
    onStructuralMutation: reconcileWorkflowTreeInBackground,
    setProjectRowRef,
    isFolderEmpty,
  };
}
