import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cssTransition, toast } from 'react-toastify';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  downloadWorkflowProject,
  duplicateWorkflowProjectVersion,
  fetchCurrentWorkflowPublishedVersion,
  fetchWorkflowTree,
  moveWorkflowItem,
  renameWorkflowFolder,
  renameWorkflowProject,
  uploadWorkflowProject,
} from './workflowApi';
import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
  WorkflowPublishedVersionRestoreResponse,
} from './types';
import {
  collectFolderIds,
  type DraggedWorkflowItem,
  flattenFolders,
  flattenProjects,
  normalizeWorkflowPath,
  ROOT_DROP_TARGET,
} from './workflowLibraryHelpers';
import {
  applyFolderMoveToTree,
  applyProjectMoveToTree,
  remapExpandedFolderIds,
  rewriteWorkflowPathPrefix,
} from './workflowTreeOps';
import { getWorkflowPublishedVersionPreviewVirtualProjectPath } from '../../shared/workflow-types';
import type { ProjectCompareSideLabels } from '../../shared/editor-bridge';

const PROJECT_SAVE_REFRESH_DELAY_MS = 150;

export const instantWarningToastTransition = cssTransition({
  enter: 'workflow-toast-instant-enter',
  exit: 'workflow-toast-instant-exit',
  collapse: false,
});

export type WorkflowProjectModalState = {
  mode: 'download' | 'duplicate' | 'compare';
  project: WorkflowProjectItem;
};

type WorkflowActionState = {
  projectPath: string | null;
  version: WorkflowProjectDownloadVersion | null;
};

type WorkflowDragState = {
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  dragOverRoot: boolean;
};

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

function normalizePromptValue(value: string | null): string | null {
  if (value == null) {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue || null;
}

function getRenamedFolderIds(
  folder: WorkflowFolderItem,
  sourceRelativePath: string,
  destinationRelativePath: string,
): string[] {
  return flattenFolders([folder]).map((childFolder) =>
    rewriteWorkflowPathPrefix(childFolder.id, sourceRelativePath, destinationRelativePath));
}

async function pickWorkflowProjectFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await (window as Window & {
        showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<Array<{ getFile: () => Promise<File> }>>;
      }).showOpenFilePicker?.({
        multiple: false,
      }) ?? [];

      return fileHandle ? fileHandle.getFile() : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }

      throw error;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.rivet-project';
    input.style.display = 'none';

    let settled = false;
    let focusTimerId: number | null = null;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (focusTimerId != null) {
        window.clearTimeout(focusTimerId);
        focusTimerId = null;
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      focusTimerId = window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 300);
    };

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    }, { once: true });
    window.addEventListener('focus', handleWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
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
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
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
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    projectSaveSequence,
  } = options;

  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const projectRowRefs = useRef<Record<string, HTMLElement | null>>({});
  const [dragState, setDragState] = useState<WorkflowDragState>({
    draggedItem: null,
    dropTargetFolderPath: null,
    dragOverRoot: false,
  });
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [settingsModalProject, setSettingsModalProject] = useState<WorkflowProjectItem | null>(null);
  const [publishedHistoryProject, setPublishedHistoryProject] = useState<WorkflowProjectItem | null>(null);
  const [runtimeLibsOpen, setRuntimeLibsOpen] = useState(false);
  const [runRecordingsOpen, setRunRecordingsOpen] = useState(false);
  const [runRecordingsRetained, setRunRecordingsRetained] = useState(false);
  const [runRecordingsFoundCount, setRunRecordingsFoundCount] = useState(0);
  const [runRecordingsResetToken, setRunRecordingsResetToken] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [folderContextMenuState, setFolderContextMenuState] = useState<WorkflowFolderContextMenuState | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] = useState<WorkflowProjectContextMenuState | null>(null);
  const [uploadingFolderPath, setUploadingFolderPath] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  const [renamingProjectPath, setRenamingProjectPath] = useState<string | null>(null);
  const [projectModalState, setProjectModalState] = useState<WorkflowProjectModalState | null>(null);
  const [downloadState, setDownloadState] = useState<WorkflowActionState>({
    projectPath: null,
    version: null,
  });
  const [duplicateState, setDuplicateState] = useState<WorkflowActionState>({
    projectPath: null,
    version: null,
  });
  const [compareState, setCompareState] = useState<WorkflowActionState>({
    projectPath: null,
    version: null,
  });
  const refreshRequestIdRef = useRef(0);
  const projectSaveRefreshTimeoutRef = useRef<number | null>(null);
  const lastAutoExpandedActivePathRef = useRef<string | null>(null);
  const suppressedActiveAncestorExpansionIdsRef = useRef<Set<string>>(new Set());
  const openedWorkflowProjectRef = useRef<WorkflowProjectItem | null>(null);

  const { draggedItem, dropTargetFolderPath, dragOverRoot } = dragState;
  const downloadingProjectPath = downloadState.projectPath;
  const downloadingVersion = downloadState.version;
  const duplicatingProjectPath = duplicateState.projectPath;
  const duplicatingVersion = duplicateState.version;
  const comparingProjectPath = compareState.projectPath;
  const comparingVersion = compareState.version;
  const settingsModalOpen = settingsModalProject != null;

  const openRunRecordingsModal = useCallback(() => {
    setRunRecordingsOpen(true);
  }, []);

  const hideRunRecordingsModal = useCallback(() => {
    setRunRecordingsOpen(false);
    setRunRecordingsRetained(true);
  }, []);

  const closeRunRecordingsModal = useCallback(() => {
    setRunRecordingsOpen(false);
    setRunRecordingsRetained(false);
    setRunRecordingsFoundCount(0);
    setRunRecordingsResetToken((currentToken) => currentToken + 1);
  }, []);

  const handleRunRecordingsFoundCountChange = useCallback((count: number) => {
    setRunRecordingsFoundCount(count);
  }, []);

  const refresh = useCallback(async (
    showLoading = true,
    refreshOptions?: {
      preserveVisibleTreeOnError?: boolean;
      onError?: (message: string) => void;
    },
  ) => {
    const requestId = ++refreshRequestIdRef.current;
    const preserveVisibleTreeOnError = refreshOptions?.preserveVisibleTreeOnError ?? false;

    if (showLoading) {
      setLoading(true);
    }
    if (!preserveVisibleTreeOnError) {
      setError(null);
    }

    try {
      const tree = await fetchWorkflowTree();
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      setFolders(tree.folders);
      setRootProjects(tree.projects);
      setExpandedFolders((prev) => {
        const validFolderIds = new Set(collectFolderIds(tree.folders));
        const next: Record<string, boolean> = {};
        let changed = false;

        for (const [folderId, isExpanded] of Object.entries(prev)) {
          if (validFolderIds.has(folderId)) {
            next[folderId] = isExpanded;
          } else {
            changed = true;
          }
        }

        for (const folderId of validFolderIds) {
          if (next[folderId] == null) {
            next[folderId] = false;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    } catch (err: any) {
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      const message = err.message || 'Failed to load workflow folders';
      if (!preserveVisibleTreeOnError) {
        setError(message);
      }
      refreshOptions?.onError?.(message);
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleProjectSaveRefresh = useCallback(() => {
    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }

    projectSaveRefreshTimeoutRef.current = window.setTimeout(() => {
      projectSaveRefreshTimeoutRef.current = null;
      void refresh(false, {
        preserveVisibleTreeOnError: true,
        onError: (message) => {
          toast.error(message);
        },
      });
    }, PROJECT_SAVE_REFRESH_DELAY_MS);
  }, [refresh]);

  const reconcileWorkflowTreeInBackground = useCallback((message: string) => {
    void refresh(false, {
      preserveVisibleTreeOnError: true,
      onError: (errorMessage) => {
        toast.error(errorMessage || message);
      },
    });
  }, [refresh]);

  useEffect(() => () => {
    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }
  }, []);

  const activePath = selectedProjectPath;
  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);
  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);
  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  const openedWorkflowProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === openedProjectPath) ?? null,
    [allProjects, openedProjectPath],
  );
  const openedWorkflowProjectPath = openedWorkflowProject?.absolutePath ?? '';
  openedWorkflowProjectRef.current = openedWorkflowProject;

  const activeProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === activePath) ?? null,
    [activePath, allProjects],
  );
  const isActiveProjectOpen = activeProject != null && activeProject.absolutePath === openedProjectPath;

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

  useEffect(() => {
    if (!openedProjectPath) {
      return;
    }

    setSelectedProjectPath(openedProjectPath);
  }, [openedProjectPath]);

  useEffect(() => {
    if (!selectedProjectPath) {
      return;
    }

    if (allProjects.some((project) => project.absolutePath === selectedProjectPath)) {
      return;
    }

    setSelectedProjectPath(openedWorkflowProject?.absolutePath ?? '');
  }, [allProjects, openedWorkflowProject, selectedProjectPath]);

  useEffect(() => {
    onActiveWorkflowProjectPathChange(openedWorkflowProjectPath);
  }, [onActiveWorkflowProjectPathChange, openedWorkflowProjectPath]);

  useEffect(() => {
    if (projectSaveSequence === 0) {
      return;
    }

    scheduleProjectSaveRefresh();
  }, [projectSaveSequence, scheduleProjectSaveRefresh]);

  const activeAncestorFolderIds = useMemo(() => {
    if (!activePath) {
      return [];
    }

    const normalizedActivePath = normalizeWorkflowPath(activePath);

    return flattenedFolders
      .filter((folder) => {
        const normalizedFolderPath = normalizeWorkflowPath(folder.absolutePath);
        return normalizedActivePath === normalizedFolderPath || normalizedActivePath.startsWith(`${normalizedFolderPath}/`);
      })
      .sort((left, right) => left.absolutePath.length - right.absolutePath.length)
      .map((folder) => folder.id);
  }, [activePath, flattenedFolders]);

  useEffect(() => {
    const normalizedActivePath = normalizeWorkflowPath(activePath);
    if (!normalizedActivePath) {
      lastAutoExpandedActivePathRef.current = null;
      return;
    }

    if (activeAncestorFolderIds.length === 0) {
      return;
    }

    if (lastAutoExpandedActivePathRef.current === normalizedActivePath) {
      return;
    }

    lastAutoExpandedActivePathRef.current = normalizedActivePath;

    const suppressedFolderIds = suppressedActiveAncestorExpansionIdsRef.current;
    if (activeAncestorFolderIds.some((folderId) => suppressedFolderIds.has(folderId))) {
      for (const folderId of activeAncestorFolderIds) {
        suppressedFolderIds.delete(folderId);
      }

      return;
    }

    setExpandedFolders((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const folderId of activeAncestorFolderIds) {
        if (!next[folderId]) {
          next[folderId] = true;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [activeAncestorFolderIds, activePath]);

  useEffect(() => {
    if (!activePath || loading) {
      return;
    }

    const activeRow = projectRowRefs.current[activePath];
    if (!activeRow) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      activeRow.scrollIntoView({ block: 'nearest' });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activePath, expandedFolders, loading]);

  const canDropIntoFolder = useCallback((item: DraggedWorkflowItem | null, destinationFolderRelativePath: string) => {
    if (!item) {
      return false;
    }

    if (item.parentRelativePath === destinationFolderRelativePath) {
      return false;
    }

    if (item.itemType === 'folder') {
      return !(
        item.relativePath === destinationFolderRelativePath ||
        destinationFolderRelativePath.startsWith(`${item.relativePath}/`)
      );
    }

    return true;
  }, []);

  const resetDragState = useCallback(() => {
    setDragState({
      draggedItem: null,
      dropTargetFolderPath: null,
      dragOverRoot: false,
    });
  }, []);

  const toggleFolderExpanded = useCallback((folderId: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !(prev[folderId] ?? false) }));
  }, []);

  const applyWorkflowProjectPathMoves = useCallback((moves: WorkflowProjectPathMove[]) => {
    if (moves.length === 0) {
      return;
    }

    setSelectedProjectPath((prev) => moves.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
    setSettingsModalProject((prev) => {
      if (!prev) {
        return prev;
      }

      const nextPath = moves.find((move) => move.fromAbsolutePath === prev.absolutePath)?.toAbsolutePath;
      return nextPath ? { ...prev, absolutePath: nextPath } : prev;
    });
    onWorkflowPathsMoved(moves);
  }, [onWorkflowPathsMoved]);

  const handleMoveDraggedItem = useCallback(async (destinationFolderRelativePath: string) => {
    if (!canDropIntoFolder(draggedItem, destinationFolderRelativePath) || !draggedItem) {
      return;
    }

    try {
      const sourceFolder = draggedItem.itemType === 'folder'
        ? flattenedFolders.find((folder) => folder.relativePath === draggedItem.relativePath) ?? null
        : null;
      const result = await moveWorkflowItem(
        draggedItem.itemType,
        draggedItem.relativePath,
        destinationFolderRelativePath,
      );

      if (result.folder) {
        const movedFolder = result.folder;
        if (draggedItem.itemType === 'folder') {
          setExpandedFolders((prev) => {
            const next = remapExpandedFolderIds(prev, draggedItem.relativePath, movedFolder.relativePath);
            return {
              ...next,
              [movedFolder.id]: true,
            };
          });
        } else {
          setExpandedFolders((prev) => ({ ...prev, [movedFolder.id]: true }));
        }

        if (sourceFolder && draggedItem.itemType === 'folder') {
          const nextTree = applyFolderMoveToTree(folders, rootProjects, sourceFolder, movedFolder);
          setFolders(nextTree.folders);
          setRootProjects(nextTree.rootProjects);
        }
      }

      applyWorkflowProjectPathMoves(result.movedProjectPaths);

      if (draggedItem.itemType === 'folder' && result.folder && sourceFolder) {
        reconcileWorkflowTreeInBackground('Workflow moved, but failed to refresh the tree');
      } else {
        await refresh(false);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to move workflow item');
    } finally {
      resetDragState();
    }
  }, [
    applyWorkflowProjectPathMoves,
    canDropIntoFolder,
    draggedItem,
    flattenedFolders,
    folders,
    reconcileWorkflowTreeInBackground,
    refresh,
    resetDragState,
    rootProjects,
  ]);

  const handleDragStart = useCallback((item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.relativePath);
    setDragState((prev) => ({ ...prev, draggedItem: item }));
  }, []);

  const handleDragEnd = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const handleFolderDragOver = useCallback((folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => {
    if (!canDropIntoFolder(draggedItem, folder.relativePath)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragState((prev) => ({
      ...prev,
      dropTargetFolderPath: folder.relativePath,
      dragOverRoot: false,
    }));
  }, [canDropIntoFolder, draggedItem]);

  const handleFolderDrop = useCallback((folder: WorkflowFolderItem) => async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await handleMoveDraggedItem(folder.relativePath);
  }, [handleMoveDraggedItem]);

  const handleRootDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canDropIntoFolder(draggedItem, '')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragState((prev) => ({
      ...prev,
      dropTargetFolderPath: ROOT_DROP_TARGET,
      dragOverRoot: true,
    }));
  }, [canDropIntoFolder, draggedItem]);

  const handleRootDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    await handleMoveDraggedItem('');
  }, [handleMoveDraggedItem]);

  const handlePanelBodyClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('.project-row') || target.closest('.active-project-section')) {
      return;
    }

    setSelectedProjectPath('');
  }, []);

  const handleRootDragLeave = useCallback(() => {
    setDragState((prev) => ({ ...prev, dragOverRoot: false }));
    if (dropTargetFolderPath === ROOT_DROP_TARGET) {
      setDragState((prev) => ({ ...prev, dropTargetFolderPath: null }));
    }
  }, [dropTargetFolderPath]);

  const handleFolderDragLeave = useCallback((folder: WorkflowFolderItem) => {
    if (dropTargetFolderPath === folder.relativePath) {
      setDragState((prev) => ({ ...prev, dropTargetFolderPath: null }));
    }
  }, [dropTargetFolderPath]);

  const handleCreateFolder = useCallback(async () => {
    const name = normalizePromptValue(prompt('New folder name:'));
    if (!name) {
      return;
    }

    try {
      const folder = await createWorkflowFolder(name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create folder');
    }
  }, [refresh]);

  const handleStartFolderRename = useCallback((folder: WorkflowFolderItem) => {
    setEditingProjectPath(null);
    setEditingFolderId(folder.id);
  }, []);

  const handleCancelFolderRename = useCallback((folder: WorkflowFolderItem) => {
    setEditingFolderId((currentFolderId) => currentFolderId === folder.id ? null : currentFolderId);
  }, []);

  const handleSubmitFolderRename = useCallback(async (folder: WorkflowFolderItem, rawName: string) => {
    const newName = normalizePromptValue(rawName);
    if (!newName || newName === folder.name) {
      setEditingFolderId(null);
      return;
    }

    setEditingFolderId(null);
    setRenamingFolderId(folder.id);

    try {
      const result = await renameWorkflowFolder(folder.relativePath, newName);
      const activeProjectPathMove = result.movedProjectPaths.find((move) => move.fromAbsolutePath === activePath);
      if (activeProjectPathMove) {
        suppressedActiveAncestorExpansionIdsRef.current = new Set([
          ...suppressedActiveAncestorExpansionIdsRef.current,
          ...getRenamedFolderIds(folder, folder.relativePath, result.folder.relativePath),
        ]);
      }

      const nextTree = applyFolderMoveToTree(folders, rootProjects, folder, result.folder);
      setFolders(nextTree.folders);
      setRootProjects(nextTree.rootProjects);
      setExpandedFolders((prev) => remapExpandedFolderIds(prev, folder.relativePath, result.folder.relativePath));
      applyWorkflowProjectPathMoves(result.movedProjectPaths);
      reconcileWorkflowTreeInBackground('Folder renamed, but failed to refresh the tree');
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename folder');
    } finally {
      setRenamingFolderId((currentFolderId) => currentFolderId === folder.id ? null : currentFolderId);
    }
  }, [activePath, applyWorkflowProjectPathMoves, folders, reconcileWorkflowTreeInBackground, rootProjects]);

  const handleStartProjectRename = useCallback((project: WorkflowProjectItem) => {
    setEditingFolderId(null);
    setEditingProjectPath(project.absolutePath);
  }, []);

  const handleCancelProjectRename = useCallback((project: WorkflowProjectItem) => {
    setEditingProjectPath((currentProjectPath) =>
      currentProjectPath === project.absolutePath ? null : currentProjectPath);
  }, []);

  const handleSubmitProjectRename = useCallback(async (project: WorkflowProjectItem, rawName: string) => {
    const newName = normalizePromptValue(rawName);
    if (!newName || newName === project.name) {
      setEditingProjectPath(null);
      return;
    }

    setEditingProjectPath(null);
    setRenamingProjectPath(project.absolutePath);

    try {
      const result = await renameWorkflowProject(project.relativePath, newName);
      const nextTree = applyProjectMoveToTree(folders, rootProjects, project, result.project);
      setFolders(nextTree.folders);
      setRootProjects(nextTree.rootProjects);

      applyWorkflowProjectPathMoves(result.movedProjectPaths);

      reconcileWorkflowTreeInBackground('Project renamed, but failed to refresh the tree');
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename project');
    } finally {
      setRenamingProjectPath((currentProjectPath) =>
        currentProjectPath === project.absolutePath ? null : currentProjectPath);
    }
  }, [applyWorkflowProjectPathMoves, folders, reconcileWorkflowTreeInBackground, rootProjects]);

  const handleAddProject = useCallback(async (folder: WorkflowFolderItem) => {
    const name = normalizePromptValue(prompt(`New Rivet project name in folder "${folder.name}":`));
    if (!name) {
      return;
    }

    try {
      const project = await createWorkflowProject(folder.relativePath, name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh(false);
      onOpenProject(project.absolutePath);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create project');
    }
  }, [onOpenProject, refresh]);

  const handleDeleteFolder = useCallback(async (folder: WorkflowFolderItem) => {
    const shouldDelete = window.confirm(`Delete empty folder "${folder.name}"?`);
    if (!shouldDelete) {
      return;
    }

    try {
      await deleteWorkflowFolder(folder.relativePath);
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete folder');
    }
  }, [refresh]);

  const closeProjectContextMenu = useCallback(() => {
    setProjectContextMenuState(null);
  }, []);

  const closeFolderContextMenu = useCallback(() => {
    setFolderContextMenuState(null);
  }, []);

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

    setEditingFolderId(null);
    setEditingProjectPath(null);
    setProjectContextMenuState(null);
    setFolderContextMenuState({
      folder,
      x: event.clientX,
      y: event.clientY,
    });
  }, [comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

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

    setEditingFolderId(null);
    setEditingProjectPath(null);
    setFolderContextMenuState(null);
    setProjectContextMenuState({
      project,
      x: event.clientX,
      y: event.clientY,
    });
  }, [comparingProjectPath, downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

  const handleUploadProjectFromFolder = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    let selectedFile: File | null;
    try {
      selectedFile = await pickWorkflowProjectFile();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to open upload picker');
      return;
    }

    if (!selectedFile) {
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith('.rivet-project')) {
      toast.error('Choose a .rivet-project file to upload');
      return;
    }

    setUploadingFolderPath(targetFolder.relativePath);

    try {
      const contents = await selectedFile.text();
      await uploadWorkflowProject(targetFolder.relativePath, selectedFile.name, contents);
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to upload project');
    } finally {
      setUploadingFolderPath((currentPath) =>
        currentPath === targetFolder.relativePath ? null : currentPath);
    }
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    refresh,
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

  const closeProjectModal = useCallback(() => {
    if (downloadingVersion || duplicatingVersion || comparingVersion) {
      return;
    }

    setProjectModalState(null);
  }, [comparingVersion, downloadingVersion, duplicatingVersion]);

  const startDuplicateProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    startOptions?: { closeModal?: boolean },
  ) => {
    setDuplicateState({
      projectPath: project.relativePath,
      version,
    });

    try {
      await duplicateWorkflowProjectVersion(project.relativePath, version);
      if (startOptions?.closeModal) {
        setProjectModalState(null);
      }

      try {
        await refresh(false);
      } catch (refreshError: any) {
        toast.error(refreshError?.message || 'Project duplicated, but failed to refresh the tree');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to duplicate project');
    } finally {
      setDuplicateState((current) =>
        current.projectPath === project.relativePath && current.version === version
          ? { projectPath: null, version: null }
          : current);
    }
  }, [refresh]);

  const handleDuplicateProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setProjectModalState({
        mode: 'duplicate',
        project: targetProject,
      });
      return;
    }

    void startDuplicateProject(
      targetProject,
      targetProject.settings.status === 'published' ? 'published' : 'live',
    );
  }, [
    closeProjectContextMenu,
    duplicatingProjectPath,
    projectContextMenuState,
    startDuplicateProject,
    uploadingFolderPath,
  ]);

  const startDownloadProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    startOptions?: { closeModal?: boolean },
  ) => {
    setDownloadState({
      projectPath: project.relativePath,
      version,
    });

    try {
      await downloadWorkflowProject(project.relativePath, version);
      if (startOptions?.closeModal) {
        setProjectModalState(null);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to download project');
    } finally {
      setDownloadState((current) =>
        current.projectPath === project.relativePath && current.version === version
          ? { projectPath: null, version: null }
          : current);
    }
  }, []);

  const handleDownloadProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setProjectModalState({
        mode: 'download',
        project: targetProject,
      });
      return;
    }

    void startDownloadProject(
      targetProject,
      targetProject.settings.status === 'published' ? 'published' : 'live',
    );
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuState,
    startDownloadProject,
    uploadingFolderPath,
  ]);

  const startCompareProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    startOptions?: { closeModal?: boolean },
  ) => {
    const openedProjectAtStart = openedWorkflowProjectRef.current;
    if (
      !openedProjectAtStart ||
      normalizeWorkflowPath(openedProjectAtStart.absolutePath) === normalizeWorkflowPath(project.absolutePath)
    ) {
      return;
    }

    setCompareState({
      projectPath: project.relativePath,
      version,
    });

    try {
      const includeVersionInLabel = project.settings.status === 'unpublished_changes';
      const currentLabel = openedProjectAtStart.name;
      let comparePath = project.absolutePath;
      let referencePath = project.relativePath || project.fileName;
      let referenceLabel = includeVersionInLabel ? `${project.name} (Unpublished changes)` : project.name;

      if (version === 'published') {
        const currentVersion = await fetchCurrentWorkflowPublishedVersion(project.relativePath);
        comparePath = getWorkflowPublishedVersionPreviewVirtualProjectPath(
          project.relativePath,
          currentVersion.id,
        );
        referencePath = `Published version of ${project.fileName}`;
        referenceLabel = includeVersionInLabel ? `${project.name} (Published)` : project.name;
      }

      const latestOpenedProject = openedWorkflowProjectRef.current;
      const sameProjectStillOpen = latestOpenedProject &&
        normalizeWorkflowPath(latestOpenedProject.absolutePath) === normalizeWorkflowPath(openedProjectAtStart.absolutePath);
      if (!sameProjectStillOpen) {
        return;
      }

      onCompareOpenProjectWith(
        comparePath,
        referencePath,
        {
          referenceLabel,
          currentLabel,
        },
      );

      if (startOptions?.closeModal) {
        setProjectModalState(null);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to load compare reference');
    } finally {
      setCompareState((current) =>
        current.projectPath === project.relativePath && current.version === version
          ? { projectPath: null, version: null }
          : current);
    }
  }, [onCompareOpenProjectWith]);

  const canCompareWithProject = useCallback((project: WorkflowProjectItem): boolean => {
    return Boolean(
      openedWorkflowProject &&
      normalizeWorkflowPath(openedWorkflowProject.absolutePath) !== normalizeWorkflowPath(project.absolutePath),
    );
  }, [openedWorkflowProject]);

  const canCompareOpenedProjectToPublishedVersion = useCallback((project: WorkflowProjectItem): boolean => {
    return Boolean(
      openedWorkflowProject &&
      project.settings.status === 'unpublished_changes' &&
      normalizeWorkflowPath(openedWorkflowProject.absolutePath) === normalizeWorkflowPath(project.absolutePath),
    );
  }, [openedWorkflowProject]);

  const handleCompareProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (
      !targetProject ||
      !canCompareWithProject(targetProject) ||
      comparingProjectPath ||
      downloadingProjectPath ||
      duplicatingProjectPath ||
      uploadingFolderPath
    ) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setProjectModalState({
        mode: 'compare',
        project: targetProject,
      });
      return;
    }

    void startCompareProject(targetProject, 'live');
  }, [
    canCompareWithProject,
    closeProjectContextMenu,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuState,
    startCompareProject,
    uploadingFolderPath,
  ]);

  const handleCompareOpenedProjectToPublishedVersionFromContextMenu = useCallback(async () => {
    const targetProject = projectContextMenuState?.project;
    if (
      !targetProject ||
      !canCompareOpenedProjectToPublishedVersion(targetProject) ||
      comparingProjectPath ||
      downloadingProjectPath ||
      duplicatingProjectPath ||
      uploadingFolderPath
    ) {
      return;
    }

    closeProjectContextMenu();
    setCompareState({
      projectPath: targetProject.relativePath,
      version: 'published',
    });

    try {
      const currentVersion = await fetchCurrentWorkflowPublishedVersion(targetProject.relativePath);
      const previewPath = getWorkflowPublishedVersionPreviewVirtualProjectPath(
        targetProject.relativePath,
        currentVersion.id,
      );
      const latestOpenedProject = openedWorkflowProjectRef.current;
      if (
        !latestOpenedProject ||
        latestOpenedProject.settings.status !== 'unpublished_changes' ||
        normalizeWorkflowPath(latestOpenedProject.absolutePath) !== normalizeWorkflowPath(targetProject.absolutePath)
      ) {
        return;
      }

      onCompareOpenProjectWith(
        previewPath,
        `Published version of ${targetProject.fileName}`,
        {
          referenceLabel: 'Published',
          currentLabel: 'Unpublished',
        },
      );
    } catch (err: any) {
      toast.error(err.message || 'Failed to load the current published version');
    } finally {
      setCompareState((current) =>
        current.projectPath === targetProject.relativePath && current.version === 'published'
          ? { projectPath: null, version: null }
          : current);
    }
  }, [
    canCompareOpenedProjectToPublishedVersion,
    closeProjectContextMenu,
    comparingProjectPath,
    downloadingProjectPath,
    duplicatingProjectPath,
    onCompareOpenProjectWith,
    projectContextMenuState,
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

    if (targetProject.settings.status !== 'unpublished') {
      toast.error('To delete a project, unpublish it first', {
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
    handleStartProjectRename(targetProject);
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    handleStartProjectRename,
    projectContextMenuState,
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

  const projectModalProject = projectModalState?.project ?? null;
  const projectModalMode = projectModalState?.mode ?? 'download';
  const projectModalActiveVersion = projectModalProject == null
    ? null
    : projectModalMode === 'download'
      ? downloadingProjectPath === projectModalProject.relativePath ? downloadingVersion : null
      : projectModalMode === 'duplicate'
        ? duplicatingProjectPath === projectModalProject.relativePath ? duplicatingVersion : null
        : comparingProjectPath === projectModalProject.relativePath ? comparingVersion : null;

  const handleProjectModalSelectPublished = useCallback(() => {
    if (!projectModalProject) {
      return;
    }

    if (projectModalMode === 'download') {
      void startDownloadProject(projectModalProject, 'published', { closeModal: true });
      return;
    }

    if (projectModalMode === 'duplicate') {
      void startDuplicateProject(projectModalProject, 'published', { closeModal: true });
      return;
    }

    void startCompareProject(projectModalProject, 'published', { closeModal: true });
  }, [projectModalMode, projectModalProject, startCompareProject, startDownloadProject, startDuplicateProject]);

  const handleProjectModalSelectUnpublishedChanges = useCallback(() => {
    if (!projectModalProject) {
      return;
    }

    if (projectModalMode === 'download') {
      void startDownloadProject(projectModalProject, 'live', { closeModal: true });
      return;
    }

    if (projectModalMode === 'duplicate') {
      void startDuplicateProject(projectModalProject, 'live', { closeModal: true });
      return;
    }

    void startCompareProject(projectModalProject, 'live', { closeModal: true });
  }, [projectModalMode, projectModalProject, startCompareProject, startDownloadProject, startDuplicateProject]);

  const setProjectRowRef = useCallback((projectPath: string, node: HTMLElement | null) => {
    projectRowRefs.current[projectPath] = node;
  }, []);

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
      if (event.key !== 'F2') {
        return;
      }

      if (
        project.absolutePath !== activePath ||
        editingProjectPath === project.absolutePath ||
        renamingProjectPath === project.absolutePath ||
        downloadingProjectPath ||
        duplicatingProjectPath ||
        uploadingFolderPath
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleStartProjectRename(project);
    },
    [
      activePath,
      downloadingProjectPath,
      duplicatingProjectPath,
      editingProjectPath,
      handleStartProjectRename,
      renamingProjectPath,
      uploadingFolderPath,
    ],
  );

  const handleProjectPreviewOpen = useCallback((path: string) => {
    setSelectedProjectPath(path);
    onOpenProject(path, { preview: true });
  }, [onOpenProject]);

  const handleProjectPersistentOpen = useCallback((path: string) => {
    setSelectedProjectPath(path);
    onOpenProject(path);
  }, [onOpenProject]);

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
    runRecordingsOpen,
    runRecordingsRetained,
    runRecordingsFoundCount,
    runRecordingsResetToken,
    aboutOpen,
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
    openRunRecordingsModal,
    hideRunRecordingsModal,
    closeRunRecordingsModal,
    handleRunRecordingsFoundCountChange,
    setAboutOpen,
    onOpenRecording: (recordingId: string) => {
      setRunRecordingsOpen(false);
      setRunRecordingsRetained(true);
      onOpenRecording(recordingId);
    },
    onOpenPublishedVersionPreview: (relativePath: string, versionId: string) => {
      setPublishedHistoryProject(null);
      setSettingsModalProject(null);
      onOpenPublishedVersionPreview(relativePath, versionId);
    },
    onProjectPreviewOpen: handleProjectPreviewOpen,
    onProjectPersistentOpen: handleProjectPersistentOpen,
    onWorkflowPathsMoved: applyWorkflowProjectPathMoves,
    onDeleteProject,
    setProjectRowRef,
    isFolderEmpty,
  };
}
