import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';

import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowTreeResponse, WorkflowTreeSyncState } from './types';
import { fetchWorkflowTree } from './workflowApi';
import { flattenFolders, flattenProjects } from './workflowLibraryHelpers';
import { reconcileExpandedFolders } from './workflowTreeOps';
import type { LibraryMutationCompletion } from './workflowNamespaceReconciliation';

export function useWorkflowLibraryTree() {
  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [explicitBundles, setExplicitBundles] = useState(false);
  const [namespaceMutations, setNamespaceMutations] = useState(false);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefreshSequence, setLocalRefreshSequence] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const refreshRequestIdRef = useRef(0);
  const syncRef = useRef<WorkflowTreeSyncState | null>(null);
  const mutationRefreshErrorRef = useRef<string | null>(null);
  const mutationCallbacks = useRef<Array<(tree: WorkflowTreeResponse | null) => void>>([]);
  const mounted = useRef(true);
  const acceptedFolders = useRef<WorkflowFolderItem[]>([]);

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
        setNamespaceMutations(tree.capabilities?.namespaceMutations === true);
        setRootProjects(tree.projects);
        syncRef.current = tree.sync;
        const before = acceptedFolders.current;
        acceptedFolders.current = tree.folders;
        setExpandedFolders((previous) => reconcileExpandedFolders(previous, before, tree.folders));
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

  const reconcileInBackground: LibraryMutationCompletion = useCallback((fallbackMessage, afterRead) => {
    if (!mounted.current) return;
    // The synchronization owner captures editor authority before its fetch.
    // Do not issue a preliminary fetch that would immediately be repeated.
    mutationRefreshErrorRef.current = fallbackMessage;
    if (afterRead) mutationCallbacks.current.push(afterRead);
    setLocalRefreshSequence((sequence) => sequence + 1);
  }, []);

  const refreshFromRemoteChange = useCallback(() => {
    // Only this fetch's batch can be settled by its snapshot. A completion
    // queued during the fetch must wait for the next authoritative read.
    const callbacks = mutationCallbacks.current.splice(0);
    const fallback = mutationRefreshErrorRef.current;
    mutationRefreshErrorRef.current = null;
    return refresh(false, {
      preserveVisibleTreeOnError: true,
      reconcileEditors: false,
      onError: () => {
        if (fallback) toast.warn(fallback);
      },
    }).then((tree) => {
      if (!mounted.current) return null;
      for (const callback of callbacks) {
        try {
          callback(tree);
        } catch (error) {
          console.error('Saved operation UI completion failed:', error);
        }
      }
      return tree;
    });
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      refreshRequestIdRef.current++;
      mutationCallbacks.current = [];
    };
  }, [refresh]);

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);
  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);
  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  return {
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
