import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';

import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowTreeResponse,
  WorkflowTreeSyncState,
} from './types';
import { fetchWorkflowTree } from './workflowApi';
import { collectFolderIds, flattenFolders, flattenProjects } from './workflowLibraryHelpers';

const PROJECT_SAVE_REFRESH_DELAY_MS = 150;

export function useWorkflowLibraryTree(projectSaveSequence: number) {
  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const refreshRequestIdRef = useRef(0);
  const projectSaveRefreshTimeoutRef = useRef<number | null>(null);
  const syncRef = useRef<WorkflowTreeSyncState | null>(null);

  const refresh = useCallback(async (
    showLoading = true,
    options?: {
      preserveVisibleTreeOnError?: boolean;
      onError?: (message: string) => void;
    },
  ): Promise<WorkflowTreeResponse | null> => {
    const requestId = ++refreshRequestIdRef.current;
    const preserveVisibleTreeOnError = options?.preserveVisibleTreeOnError ?? false;
    if (showLoading) {
      setLoading(true);
    }
    if (!preserveVisibleTreeOnError) {
      setError(null);
    }

    try {
      const tree = await fetchWorkflowTree();
      if (requestId !== refreshRequestIdRef.current) {
        return null;
      }

      setFolders(tree.folders);
      setRootProjects(tree.projects);
      syncRef.current = tree.sync;
      setExpandedFolders((previous) => {
        const validFolderIds = new Set(collectFolderIds(tree.folders));
        const next: Record<string, boolean> = {};
        let changed = false;
        for (const [folderId, isExpanded] of Object.entries(previous)) {
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
        return changed ? next : previous;
      });
      return tree;
    } catch (caughtError) {
      if (requestId !== refreshRequestIdRef.current) {
        return null;
      }
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to load workflow folders';
      if (!preserveVisibleTreeOnError) {
        setError(message);
      }
      options?.onError?.(message);
      return null;
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const reconcileInBackground = useCallback((fallbackMessage: string) => {
    void refresh(false, {
      preserveVisibleTreeOnError: true,
      onError: (message) => toast.error(message || fallbackMessage),
    });
  }, [refresh]);

  const refreshFromRemoteChange = useCallback(() => refresh(false, {
    preserveVisibleTreeOnError: true,
  }), [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (projectSaveSequence === 0) {
      return;
    }

    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }
    projectSaveRefreshTimeoutRef.current = window.setTimeout(() => {
      projectSaveRefreshTimeoutRef.current = null;
      reconcileInBackground('Failed to refresh the project list after save.');
    }, PROJECT_SAVE_REFRESH_DELAY_MS);
  }, [projectSaveSequence, reconcileInBackground]);

  useEffect(() => () => {
    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }
  }, []);

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);
  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);
  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  return {
    allProjects,
    error,
    expandedFolders,
    flattenedFolders,
    folderIds,
    folders,
    loading,
    reconcileInBackground,
    refresh,
    rootProjects,
    refreshFromRemoteChange,
    setExpandedFolders,
    setFolders,
    setRootProjects,
    syncRef,
  };
}
