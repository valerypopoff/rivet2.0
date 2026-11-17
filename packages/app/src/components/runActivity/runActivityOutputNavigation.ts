import type { createStore } from 'jotai';
import {
  currentGraphViewState,
  lastRunDataByNodeState,
  selectedGraphRunByViewState,
  selectedProcessPageNodesState,
} from '../../state/dataFlow.js';
import { graphState } from '../../state/graph.js';
import { fullscreenOutputNodeState, nodeEditorSessionRevisionState } from '../../state/graphBuilder.js';
import {
  clearInvalidFullscreenOutputSelectionState,
  fullscreenOutputSelectionState,
} from '../../state/fullscreenOutput.js';
import { projectBindingRegistryState } from '../../state/projectBindings.js';
import { projectState, projectsState } from '../../state/savedGraphs.js';
import { hasStoredPortMapValues, hasStoredSplitOutputValues } from '../../utils/executionDataReaders.js';
import {
  findExactProcessData,
  findExactProcessPage,
  processHasStoredOutputPort,
} from './runActivityInspectorLifecycle.js';
import type { RunActivityInvocationIdentity, RunActivityToolResultTarget } from './types.js';

/** Own only a pending presentation action, never an execution or a data copy.
 * The lightweight renderer keeps this alive when narrow-screen navigation
 * closes its expensive drawer before the graph's layout effects have settled. */
export function createRunActivityOutputNavigation(
  store: ReturnType<typeof createStore>,
  frames = {
    request: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
  },
) {
  let pending: number | undefined;
  let revision = 0;
  let stopSelectionWatch: (() => void) | undefined;
  const stopWatching = () => {
    stopSelectionWatch?.();
    stopSelectionWatch = undefined;
  };
  const cancel = () => {
    revision++;
    stopWatching();
    if (pending != null) frames.cancel(pending);
    pending = undefined;
  };
  return {
    dispose: cancel,
    schedule(target: RunActivityInvocationIdentity | RunActivityToolResultTarget) {
      cancel();
      store.get(projectsState); // Reconcile the existing binding registry.
      // Retire an obsolete modal before watching for a genuinely newer choice.
      const selection = store.get(fullscreenOutputSelectionState);
      if (selection) store.set(clearInvalidFullscreenOutputSelectionState, selection);
      const project = store.get(projectState);
      const bindings = store.get(projectBindingRegistryState);
      const token = bindings.get(project.metadata.id)?.token;
      const workspace = bindings.getWorkspaceToken();
      const viewKey = store.get(currentGraphViewState)?.key;
      const editorSessionRevision = store.get(nodeEditorSessionRevisionState);
      const intent = revision;
      // Observe only while pending: a newer inline open/close owns the UI,
      // including an open -> close round trip before this frame can execute.
      stopSelectionWatch = store.sub(fullscreenOutputSelectionState, cancel);
      if (intent !== revision) {
        stopWatching();
        return;
      }
      pending = frames.request(() => {
        if (intent !== revision) return;
        pending = undefined;
        stopWatching();
        store.get(projectsState);
        const current = store.get(projectState);
        if (
          current.metadata.id !== project.metadata.id ||
          store.get(nodeEditorSessionRevisionState) !== editorSessionRevision ||
          bindings.getWorkspaceToken() !== workspace ||
          (token == null
            ? bindings.get(current.metadata.id) != null || current !== project
            : !bindings.isCurrent(current.metadata.id, token)) ||
          store.get(graphState).metadata?.id !== target.graphId ||
          !store.get(graphState).nodes.some((node) => node.id === target.nodeId) ||
          viewKey == null ||
          store.get(currentGraphViewState)?.key !== viewKey ||
          store.get(selectedGraphRunByViewState)[viewKey] !== target.graphRunId
        )
          return;
        const data = store.get(lastRunDataByNodeState);
        const process = findExactProcessData(data, target);
        if (
          process == null ||
          !(
            hasStoredPortMapValues(process.data.outputData) || hasStoredSplitOutputValues(process.data.splitOutputData)
          ) ||
          findExactProcessPage(data, target) !== (store.get(selectedProcessPageNodesState)[target.nodeId] ?? 0) ||
          ('outputPortId' in target && !processHasStoredOutputPort(process, target.outputPortId))
        )
          return;
        store.set(fullscreenOutputNodeState, target.nodeId);
      });
    },
  };
}
