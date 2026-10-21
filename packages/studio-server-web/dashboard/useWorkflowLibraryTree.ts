import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';

import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowTreeResponse, WorkflowTreeSyncState } from './types';
import { fetchWorkflowTree } from './workflowApi';
import { collectFolderIds, flattenFolders, flattenProjects } from './workflowLibraryHelpers';

export function useWorkflowLibraryTree() {
  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [explicitBundles, setExplicitBundles] = useState(false);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshSequence, setLocalRefreshSequence] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const refreshRequestIdRef = useRef(0);
  const syncRef = useRef<WorkflowTreeSyncState | null>(null);

  const refresh = useCallback(
    async (
      showLoading = true,
      options?: {
        preserveVisibleTreeOnError?: boolean;
        onError?: (message: string) => void;
        reconcileEditors?: boolean;
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

        // A successful background retry also recovers an earlier foreground
        // failure. Only an accepted response may clear that error.
        setError(null);
        setFolders(tree.folders);
        setExplicitBundles(tree.capabilities?.explicitBundles === true);
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
          // A local mutation's event echo is suppressed. Wake the fresh-tree
          // owner even if this list refresh failed, so membership can recover
          // through its normal retry path without trusting cached revisions.
          if (options?.reconcileEditors !== false) setLocalRefreshSequence((sequence) => sequence + 1);
        }
      }
    },
    [],
  );

  const reconcileInBackground = useCallback(
    (fallbackMessage: string) => {
      void refresh(false, {
        preserveVisibleTreeOnError: true,
        onError: (message) => toast.error(message || fallbackMessage),
      });
    },
    [refresh],
  );

  const refreshFromRemoteChange = useCallback(
    () =>
      refresh(false, {
        preserveVisibleTreeOnError: true,
        reconcileEditors: false,
      }),
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);
  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);
  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  return {
    explicitBundles,
    allProjects,
    error,
    expandedFolders,
    flattenedFolders,
    folderIds,
    folders,
    loading,
    localRefreshSequence,
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
