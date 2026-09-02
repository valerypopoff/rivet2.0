import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cssTransition, toast } from 'react-toastify';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
  WorkflowPublishedVersionRestoreResponse,
} from './types';
import type { ProjectCompareSideLabels } from '../../studio-server-shared/editor-bridge';
import { isWorkflowProjectFullyUnpublished } from './projectSettingsForm';
import { useRunRecordingsModalState } from './useRunRecordingsModalState';
import { useWorkflowLibraryDragAndDrop } from './useWorkflowLibraryDragAndDrop';
import { useWorkflowLibraryMutations } from './useWorkflowLibraryMutations';
import { useWorkflowLibrarySelection } from './useWorkflowLibrarySelection';
import { useWorkflowLibraryTree } from './useWorkflowLibraryTree';
import { useWorkflowLibraryTreeSync } from './useWorkflowLibraryTreeSync';
import { useWorkflowProjectVersionActions } from './useWorkflowProjectVersionActions';
import { isPlainF2ShortcutEvent } from './editorBridgeFocus';

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
  onOpenRecording: (recordingId: string, nextOptions?: { replaceCurrent?: boolean }) => void;
  onOpenPublishedVersionPreview: (
    relativePath: string,
    versionId: string,
    nextOptions?: { replaceCurrent?: boolean },
  ) => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => Promise<void> | void;
  onWorkflowProjectOpenIntent: (path: string) => void;
  onWorkflowProjectOpenIntentCanceled: (path: string) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  projectSaveSequence: number;
  projectTreeRenameRequestSequence: number;
}) {
  const {
    onOpenProject,
    onRefreshOpenProjectFromDisk,
    onOpenRecording,
    onOpenPublishedVersionPreview,
    onCompareOpenProjectWith,
    onDeleteProject,
    onWorkflowPathsMoved,
    onWorkflowProjectOpenIntent,
    onWorkflowProjectOpenIntentCanceled,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    projectTreeRenameRequestSequence,
    projectSaveSequence,
  } = options;

  const {
    allProjects,
    error,
    expandedFolders,
    flattenedFolders,
    folderIds,
    folders,
    loading,
    reconcileInBackground: reconcileWorkflowTreeInBackground,
    refresh,
    refreshFromRemoteChange,
    rootProjects,
    setExpandedFolders,
    setFolders,
    setRootProjects,
    syncRef,
  } = useWorkflowLibraryTree(projectSaveSequence);
  const runRecordings = useRunRecordingsModalState();
  const [settingsModalProject, setSettingsModalProject] = useState<WorkflowProjectItem | null>(null);
  const [publishedHistoryProject, setPublishedHistoryProject] = useState<WorkflowProjectItem | null>(null);
  const [runtimeLibsOpen, setRuntimeLibsOpen] = useState(false);
  const [runStatisticsOpen, setRunStatisticsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [folderContextMenuState, setFolderContextMenuState] = useState<WorkflowFolderContextMenuState | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] = useState<WorkflowProjectContextMenuState | null>(null);
  const selection = useWorkflowLibrarySelection({
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
    clearSelection,
    isActiveProjectOpen,
    openedWorkflowProject,
    openedWorkflowProjectRef,
    remapSelectedPath,
    setProjectRowRef,
    suppressAncestorExpansion,
    toggleFolderExpanded,
  } = selection;

  const settingsModalOpen = settingsModalProject != null;

  useEffect(() => {
    if (!settingsModalOpen || !settingsModalProject) {
      return;
    }

    const matchingProject = allProjects.find((project) => project.absolutePath === settingsModalProject.absolutePath);
    if (matchingProject) {
      setSettingsModalProject(matchingProject);
    }
  }, [allProjects, settingsModalOpen, settingsModalProject]);

  useEffect(() => {
    if (!publishedHistoryProject) {
      return;
    }

    const matchingProject = allProjects.find((project) => project.absolutePath === publishedHistoryProject.absolutePath);
    if (!matchingProject) {
      setPublishedHistoryProject(null);
    } else if (matchingProject !== publishedHistoryProject) {
      setPublishedHistoryProject(matchingProject);
    }
  }, [allProjects, publishedHistoryProject]);

  const applyWorkflowProjectPathMoves = useCallback(async (moves: WorkflowProjectPathMove[]) => {
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
  }, [onWorkflowPathsMoved, remapSelectedPath]);

  const mutations = useWorkflowLibraryMutations({
    activePath,
    applyProjectPathMoves: applyWorkflowProjectPathMoves,
    folders,
    onOpenProject,
    reconcileTree: reconcileWorkflowTreeInBackground,
    refresh,
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

  const startProjectRename = useCallback((project: WorkflowProjectItem) => {
    cancelPendingPreviewOpen(project.absolutePath);
    handleStartProjectRename(project);
  }, [cancelPendingPreviewOpen, handleStartProjectRename]);

  const dragAndDrop = useWorkflowLibraryDragAndDrop({
    applyProjectPathMoves: applyWorkflowProjectPathMoves,
    flattenedFolders,
    folders,
    reconcileTree: reconcileWorkflowTreeInBackground,
    refresh,
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

  const handlePanelBodyClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('.project-row') || target.closest('.active-project-section')) {
      return;
    }

    clearSelection();
  }, [clearSelection]);

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
    refresh,
    uploadingFolderPath,
  });
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
    appSettingsOpen ||
      folderContextMenuState ||
      projectContextMenuState ||
      projectModalProject ||
      publishedHistoryProject ||
      runRecordings.open ||
      runStatisticsOpen ||
      runtimeLibsOpen ||
      settingsModalOpen,
  );

  useWorkflowLibraryTreeSync({
    currentSyncRef: syncRef,
    isLocalTreeInteractionActive: Boolean(
      draggedItem
      || movePending
      || editingFolderId
      || editingProjectPath
      || renamingFolderId
      || renamingProjectPath
      || treeMutationPending
      || uploadingFolderPath
      || duplicatingProjectPath,
    ),
    openedProjectPath,
    openedProjectRef: openedWorkflowProjectRef,
    refreshFromRemoteChange,
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

  const handledProjectTreeRenameRequestRef = useRef(projectTreeRenameRequestSequence);

  useEffect(() => {
    if (handledProjectTreeRenameRequestRef.current === projectTreeRenameRequestSequence) {
      return;
    }

    handledProjectTreeRenameRequestRef.current = projectTreeRenameRequestSequence;
    startSelectedProjectRename();
  }, [projectTreeRenameRequestSequence, startSelectedProjectRename]);

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

  const handleFolderContextMenu = useCallback((
    folder: WorkflowFolderItem,
    event: MouseEvent<HTMLDivElement>,
  ) => {
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
  }, [clearInlineEditing, comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

  const handleProjectContextMenu = useCallback((
    project: WorkflowProjectItem,
    event: MouseEvent<HTMLElement>,
  ) => {
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
  }, [clearInlineEditing, comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

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

  const openProjectSettingsModal = useCallback((project: WorkflowProjectItem) => {
    setSettingsModalProject(project);
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (!activeProject) {
      return;
    }

    setSettingsModalProject(activeProject);
  }, [activeProject]);

  const handleDeleteProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    if (!isWorkflowProjectFullyUnpublished(targetProject)) {
      toast.error('To delete a project, unpublish its workflow endpoint and web apps first', {
        transition: instantWarningToastTransition,
      });
      return;
    }

    closeProjectContextMenu();
    openProjectSettingsModal(targetProject);
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

  const openPublishedHistoryModal = useCallback((project: WorkflowProjectItem) => {
    setPublishedHistoryProject(project);
  }, []);

  const closePublishedHistoryModal = useCallback(() => {
    setPublishedHistoryProject(null);
  }, []);

  const handlePublishedVersionRestored = useCallback(async (
    response: WorkflowPublishedVersionRestoreResponse,
  ) => {
    onRefreshOpenProjectFromDisk(response.project.absolutePath);
    await refresh(false);
  }, [onRefreshOpenProjectFromDisk, refresh]);

  const handleFolderRowClick = useCallback((folder: WorkflowFolderItem) => (_event: MouseEvent<HTMLElement>) => {
    if (editingFolderId === folder.id || renamingFolderId === folder.id) {
      return;
    }

    toggleFolderExpanded(folder.id);
  }, [editingFolderId, renamingFolderId, toggleFolderExpanded]);

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
    publishedHistoryProject,
    runtimeLibsOpen,
    runRecordingsOpen: runRecordings.open,
    runRecordingsRetained: runRecordings.retained,
    runRecordingsFoundCount: runRecordings.foundCount,
    runRecordingsResetToken: runRecordings.resetToken,
    runStatisticsOpen,
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
    openPublishedHistoryModal,
    closePublishedHistoryModal,
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
    handlePanelBodyClick,
    handleUploadProjectFromFolder,
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
    setRuntimeLibsOpen,
    setRunStatisticsOpen,
    openRunRecordingsModal: runRecordings.show,
    hideRunRecordingsModal: runRecordings.hide,
    closeRunRecordingsModal: runRecordings.close,
    handleRunRecordingsFoundCountChange: runRecordings.setFoundCount,
    setAppSettingsOpen,
    onOpenRecording: (recordingId: string) => {
      runRecordings.hide();
      onOpenRecording(recordingId);
    },
    onOpenPublishedVersionPreview: (relativePath: string, versionId: string) => {
      setPublishedHistoryProject(null);
      setSettingsModalProject(null);
      onOpenPublishedVersionPreview(relativePath, versionId);
    },
    onProjectPreviewOpen: selection.openPreview,
    onProjectPersistentOpen: selection.openPersistent,
    onWorkflowPathsMoved: applyWorkflowProjectPathMoves,
    onDeleteProject,
    setProjectRowRef,
    isFolderEmpty,
  };
}
