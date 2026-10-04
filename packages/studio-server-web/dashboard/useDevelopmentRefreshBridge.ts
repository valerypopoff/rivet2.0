import { useStore } from 'jotai';
import { useEffect } from 'react';
import { useExecutorSessionRuntime } from '../../app/src/host';
import { graphRunningState } from '../../app/src/state/dataFlow';
import { evaluationsRunningState } from '../../app/src/state/evaluations';
import { draggingWireState, editingNodeState } from '../../app/src/state/graphBuilder';
import { openingProjectTabsState } from '../../app/src/state/openingProjectTabs';
import {
  projectState,
  projectDataState,
  projectsState,
  projectUnsavedChangesState,
  projectDataUnsavedChangesState,
  savedProjectContentDigestsState,
} from '../../app/src/state/savedGraphs';
import { graphState } from '../../app/src/state/graph';
import { flushWorkspaceRecovery, getWorkspaceRecoveryStorage } from '../../app/src/state/storage';
import { overlayOpenState } from '../../app/src/state/ui';
import { getProjectActivationStatus } from '../../app/src/utils/projectActivationCoordinator';
import { hasPendingProjectSaves } from '../../app/src/utils/projectSaveCoordinator';
import { isValidBridgeOrigin } from '../../studio-server-shared/editor-bridge';
import { hasDevelopmentCommands } from './developmentActivity';
import {
  canRefreshDevelopmentWorkspace,
  getDevelopmentGeneration,
  type DevelopmentRefreshWindow,
} from './developmentRefreshGuard';

export function useDevelopmentRefreshBridge(): void {
  const store = useStore();
  const executor = useExecutorSessionRuntime();
  useEffect(() => {
    if (import.meta.env.VITE_TUNNEL_DEV !== 'true' || !getDevelopmentGeneration()) return;
    let pending: string | undefined;
    let revision = 0;
    let preparedRevision = -1;
    let preparedStorage: ReturnType<typeof getWorkspaceRecoveryStorage> | undefined;
    let previousInert: boolean | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const win = window as DevelopmentRefreshWindow;
    const safety = () => {
      const projects = store.get(projectsState);
      const baselines = store.get(savedProjectContentDigestsState);
      // Providers can be reconfigured while this mounted bridge stays alive.
      // Read the authority used by flushWorkspaceRecovery, never a retired one.
      const health = getWorkspaceRecoveryStorage().getHealth();
      return {
        dirty:
          Object.values(store.get(projectUnsavedChangesState)).some(Boolean) ||
          Object.values(store.get(projectDataUnsavedChangesState)).some(Boolean) ||
          projects.openedProjectsSortedIds.some((id) => !baselines[id]),
        busy:
          store.get(graphRunningState) ||
          store.get(evaluationsRunningState) ||
          store.get(overlayOpenState) !== undefined ||
          store.get(editingNodeState) !== null ||
          document.querySelector('.node-canvas.dragging-node, .node-canvas.dragging-canvas') !== null ||
          store.get(draggingWireState) !== undefined ||
          (document.activeElement instanceof HTMLElement &&
            (document.activeElement.matches('input, textarea, select') || document.activeElement.isContentEditable)) ||
          Object.values(store.get(openingProjectTabsState)).some(Boolean) ||
          getProjectActivationStatus(store).pending ||
          hasPendingProjectSaves(store) ||
          hasDevelopmentCommands() ||
          previousInert === true ||
          executor.getActiveGraphRunRequestId() !== null,
        recoverySaved: health.status === 'saved' && health.revision === health.committedRevision,
        reloadAvailable: health.reloadAvailable,
      };
    };
    const release = () => {
      pending = undefined;
      preparedRevision = -1;
      preparedStorage = undefined;
      clearTimeout(deadline);
      if (previousInert !== undefined) document.documentElement.inert = previousInert;
      previousInert = undefined;
    };
    // Final synchronous check in the parent closes the postMessage/reload gap.
    win.__rivetDevelopmentRefreshReady = (id) =>
      pending === id &&
      preparedRevision === revision &&
      preparedStorage === getWorkspaceRecoveryStorage() &&
      canRefreshDevelopmentWorkspace(safety());
    const unsubscribe = [
      projectState,
      projectDataState,
      graphState,
      projectsState,
      projectUnsavedChangesState,
      projectDataUnsavedChangesState,
      savedProjectContentDigestsState,
      draggingWireState,
    ].map((atom) =>
      store.sub(atom, () => {
        revision++;
      }),
    );
    const handler = async (event: MessageEvent) => {
      if (!isValidBridgeOrigin(event, window.parent) || typeof event.data?.requestId !== 'string') return;
      const { type, requestId } = event.data;
      if (type === 'cancel-development-refresh') {
        if (pending === requestId) release();
        return;
      }
      if (type !== 'prepare-development-refresh') return;
      release();
      // Inert can blur an inline editor. Capture its activity before locking input.
      const initial = safety();
      pending = requestId;
      previousInert = document.documentElement.inert;
      document.documentElement.inert = true;
      deadline = setTimeout(release, 8_000);
      const before = revision;
      let ready = false;
      const storage = getWorkspaceRecoveryStorage();
      try {
        if (!initial.dirty && !initial.busy) {
          await flushWorkspaceRecovery();
          ready =
            pending === requestId &&
            revision === before &&
            storage === getWorkspaceRecoveryStorage() &&
            canRefreshDevelopmentWorkspace(safety());
        }
      } catch {
        /* Keep editing available; a failed checkpoint forbids automatic refresh. */
      }
      if (pending !== requestId) return;
      if (ready) {
        preparedRevision = revision;
        preparedStorage = storage;
      } else release();
      window.parent.postMessage({ type: 'development-refresh-prepared', requestId, ready }, window.location.origin);
    };
    window.addEventListener('message', handler);
    return () => {
      release();
      unsubscribe.forEach((stop) => stop());
      delete win.__rivetDevelopmentRefreshReady;
      window.removeEventListener('message', handler);
    };
  }, [store, executor]);
}
