import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useReducer } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { ChartNode } from '@valerypopoff/rivet2-core';
import { graphState, isReadOnlyGraphState } from '../../state/graph.js';
import { projectState, projectsState } from '../../state/savedGraphs.js';
import { editingNodeState, nodeEditorSessionRevisionState } from '../../state/graphBuilder.js';
import { projectWorkspaceTargetsState } from '../../state/workspaceTarget.js';
import { createNodeEditorSession } from '../../utils/nodeEditorSession.js';
import type { NodeChanged } from '../NodeEditor.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';

type NodeEditorSession = ReturnType<typeof createNodeEditorSession> & {
  getNode(): ChartNode | undefined;
  canWrite(): boolean;
  modelScope: string;
  setAttached(attached: boolean): void;
};

export const NodeEditorSessionContext = createContext<NodeEditorSession | undefined>(undefined);
export const useNodeEditorSessionContext = () => useContext(NodeEditorSessionContext);

/** Stable within a lifetime, but a retained callback never borrows a newer owner. */
export function useNodeEditorSessionCallback<Arguments extends unknown[]>(
  session: NodeEditorSession,
  callback: (...args: Arguments) => void,
) {
  const latest = useStableCallback(callback);
  return useCallback(
    (...args: Arguments) => {
      if (session.isCurrent()) latest(...args);
    },
    [session, latest],
  );
}

export function useNodeEditorSession(node: ChartNode, library: boolean, variant?: string): NodeEditorSession {
  const store = useStore();
  const projectId = useAtomValue(projectState).metadata.id;
  const graphId = useAtomValue(graphState).metadata?.id;
  const revision = useAtomValue(nodeEditorSessionRevisionState);
  const readOnly = useAtomValue(isReadOnlyGraphState);
  const target = useAtomValue(projectWorkspaceTargetsState)[projectId];
  const prefabId = library && target?.type === 'nodeLibrary' ? target.editingPrefabId : undefined;
  const [lifetime, renewLifetime] = useReducer((value: number) => value + 1, 0);
  const session = useMemo(() => {
    let attached = true;
    const tabWasOpen = store.get(projectsState).openedProjects[projectId] != null;
    const getNode = () =>
      library
        ? prefabId
          ? store.get(projectState).nodePrefabs?.[prefabId]?.sourceNode
          : undefined
        : store.get(graphState).nodes.find((entry) => entry.id === node.id);
    const token = createNodeEditorSession(() => {
      const target = store.get(projectWorkspaceTargetsState)[projectId];
      return (
        store.get(projectState).metadata.id === projectId &&
        store.get(graphState).metadata?.id === graphId &&
        store.get(nodeEditorSessionRevisionState) === revision &&
        store.get(isReadOnlyGraphState) === readOnly &&
        (!tabWasOpen || store.get(projectsState).openedProjects[projectId] != null) &&
        getNode()?.id === node.id &&
        getNode()?.type === node.type &&
        (library
          ? target?.type === 'nodeLibrary' && prefabId != null && target.editingPrefabId === prefabId
          : (target == null || target.type === 'graph') && store.get(editingNodeState) === node.id)
      );
    });
    return {
      ...token,
      isCurrent: () => attached && token.isCurrent(),
      setAttached: (value: boolean) => {
        attached = value;
      },
      getNode,
      canWrite: () => attached && token.isCurrent() && variant == null && !store.get(isReadOnlyGraphState),
      modelScope: JSON.stringify([
        library ? 'library' : 'graph',
        prefabId ?? null,
        node.type,
        variant ?? 'current',
        readOnly ? revision : 'live',
      ]),
    };
    // lifetime explicitly invalidates a retired token with identical final IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, projectId, graphId, revision, readOnly, node.id, node.type, library, variant, prefabId, lifetime]);

  useLayoutEffect(() => {
    session.setAttached(true);
    const check = () => {
      // Jotai observes intermediate ownership changes even when React batches
      // them back to the same final identity. Never revive the retired token,
      // but ensure that the returned owner gets a new writable lifetime.
      if (!session.isCurrent()) renewLifetime();
    };
    const unsubscribe = [
      projectState,
      projectsState,
      graphState,
      editingNodeState,
      nodeEditorSessionRevisionState,
      projectWorkspaceTargetsState,
      isReadOnlyGraphState,
    ].map((state) => store.sub(state, check));
    return () => {
      session.setAttached(false);
      // StrictMode probes effect cleanup/setup without leaving the owner.
      // Writes are rejected immediately; irreversible retirement follows only
      // if this session was actually detached rather than reattached.
      queueMicrotask(() => {
        if (!session.isCurrent()) session.retire();
      });
      unsubscribe.forEach((dispose) => dispose());
    };
  }, [store, session]);
  return session;
}

/** Patch the latest owning node instead of replaying a field's render snapshot. */
export function useNodeEditorDataChange(node: ChartNode, onChange: NodeChanged) {
  const session = useNodeEditorSessionContext();
  return (key: string, value: unknown) => {
    if (session && !session.canWrite()) return;
    const current = session?.getNode() ?? node;
    onChange({ ...current, data: { ...(current.data as Record<string, unknown>), [key]: value } }, undefined, current);
  };
}
