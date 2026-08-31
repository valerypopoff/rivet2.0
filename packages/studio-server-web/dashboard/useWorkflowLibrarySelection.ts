import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectOpenOptions } from './types';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';

export function useWorkflowLibrarySelection({
  allProjects,
  expandedFolders,
  flattenedFolders,
  loading,
  onActiveWorkflowProjectPathChange,
  onOpenProject,
  onWorkflowProjectOpenIntent,
  openedProjectPath,
  setExpandedFolders,
}: {
  allProjects: WorkflowProjectItem[];
  expandedFolders: Record<string, boolean>;
  flattenedFolders: WorkflowFolderItem[];
  loading: boolean;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  onOpenProject: (path: string, options?: WorkflowProjectOpenOptions) => void;
  onWorkflowProjectOpenIntent: (path: string) => void;
  openedProjectPath: string;
  setExpandedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const projectRowRefs = useRef<Record<string, HTMLElement | null>>({});
  const previewOpenTimeoutRef = useRef<number | null>(null);
  const lastAutoExpandedActivePathRef = useRef<string | null>(null);
  const suppressedActiveAncestorExpansionIdsRef = useRef<Set<string>>(new Set());
  const openedWorkflowProjectRef = useRef<WorkflowProjectItem | null>(null);
  const activePath = selectedProjectPath;
  const openedWorkflowProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === openedProjectPath) ?? null,
    [allProjects, openedProjectPath],
  );
  const activeProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === activePath) ?? null,
    [activePath, allProjects],
  );
  if (openedWorkflowProject) {
    openedWorkflowProjectRef.current = openedWorkflowProject;
  } else if (
    !openedProjectPath ||
    openedWorkflowProjectRef.current?.absolutePath !== openedProjectPath
  ) {
    // Keep the last known tree item only for the still-open document. A
    // remote rename/delete removes its row before the synchronization hook
    // can explain that the editor intentionally remains unchanged.
    openedWorkflowProjectRef.current = null;
  }

  const clearPendingPreviewOpen = useCallback(() => {
    if (previewOpenTimeoutRef.current != null) {
      window.clearTimeout(previewOpenTimeoutRef.current);
      previewOpenTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearPendingPreviewOpen, [clearPendingPreviewOpen]);

  useEffect(() => {
    if (openedProjectPath) {
      setSelectedProjectPath(openedProjectPath);
    }
  }, [openedProjectPath]);

  useEffect(() => {
    if (
      selectedProjectPath &&
      !allProjects.some((project) => project.absolutePath === selectedProjectPath)
    ) {
      setSelectedProjectPath(openedWorkflowProject?.absolutePath ?? '');
    }
  }, [allProjects, openedWorkflowProject, selectedProjectPath]);

  useEffect(() => {
    // A remote tree refresh can remove or move an open project. The editor
    // deliberately keeps that document open, so retain its active path even
    // while there is no longer a matching sidebar row.
    onActiveWorkflowProjectPathChange(openedProjectPath);
  }, [onActiveWorkflowProjectPathChange, openedProjectPath]);

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
    if (
      activeAncestorFolderIds.length === 0 ||
      lastAutoExpandedActivePathRef.current === normalizedActivePath
    ) {
      return;
    }
    lastAutoExpandedActivePathRef.current = normalizedActivePath;

    const suppressedFolderIds = suppressedActiveAncestorExpansionIdsRef.current;
    if (activeAncestorFolderIds.some((folderId) => suppressedFolderIds.has(folderId))) {
      activeAncestorFolderIds.forEach((folderId) => suppressedFolderIds.delete(folderId));
      return;
    }

    setExpandedFolders((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const folderId of activeAncestorFolderIds) {
        if (!next[folderId]) {
          next[folderId] = true;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [activeAncestorFolderIds, activePath, setExpandedFolders]);

  useEffect(() => {
    if (!activePath || loading) {
      return;
    }
    const activeRow = projectRowRefs.current[activePath];
    if (!activeRow) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => activeRow.scrollIntoView({ block: 'nearest' }));
    return () => window.cancelAnimationFrame(frameId);
  }, [activePath, expandedFolders, loading]);

  const setProjectRowRef = useCallback((projectPath: string, node: HTMLElement | null) => {
    projectRowRefs.current[projectPath] = node;
  }, []);
  const clearSelection = useCallback(() => setSelectedProjectPath(''), []);
  const remapSelectedPath = useCallback((moves: Array<{ fromAbsolutePath: string; toAbsolutePath: string }>) => {
    setSelectedProjectPath((previous) => (
      moves.find((move) => move.fromAbsolutePath === previous)?.toAbsolutePath ?? previous
    ));
  }, []);
  const toggleFolderExpanded = useCallback((folderId: string) => {
    setExpandedFolders((previous) => ({ ...previous, [folderId]: !(previous[folderId] ?? false) }));
  }, [setExpandedFolders]);
  const suppressAncestorExpansion = useCallback((folderIds: string[]) => {
    suppressedActiveAncestorExpansionIdsRef.current = new Set([
      ...suppressedActiveAncestorExpansionIdsRef.current,
      ...folderIds,
    ]);
  }, []);
  const openPreview = useCallback((project: WorkflowProjectItem) => {
    clearPendingPreviewOpen();
    setSelectedProjectPath(project.absolutePath);
    onWorkflowProjectOpenIntent(project.absolutePath);
    previewOpenTimeoutRef.current = window.setTimeout(() => {
      previewOpenTimeoutRef.current = null;
      onOpenProject(project.absolutePath, { preview: true, title: project.name });
    }, 180);
  }, [clearPendingPreviewOpen, onOpenProject, onWorkflowProjectOpenIntent]);
  const openPersistent = useCallback((project: WorkflowProjectItem) => {
    clearPendingPreviewOpen();
    setSelectedProjectPath(project.absolutePath);
    onOpenProject(project.absolutePath, { title: project.name });
  }, [clearPendingPreviewOpen, onOpenProject]);

  return {
    activePath,
    activeProject,
    clearSelection,
    isActiveProjectOpen: activeProject != null && activeProject.absolutePath === openedProjectPath,
    openedWorkflowProject,
    openedWorkflowProjectRef,
    openPersistent,
    openPreview,
    remapSelectedPath,
    selectedProjectPath,
    setProjectRowRef,
    setSelectedProjectPath,
    suppressAncestorExpansion,
    toggleFolderExpanded,
  };
}
