import {
  type GraphInputs,
  type GraphOutputs,
  type Project,
  type UiComponentId,
  type UiGraph,
  type GraphProgress,
  type RivetWebAppStorage,
  formatUiGraphActionBindingIssues,
  getUiGraphActionComponent,
  jsonValueToDataValue,
  normalizeUiGraph,
  resolveUiGraphComponentActionInputs,
  resolveUiGraphComponentActionOutputStatePatch,
  validateUiGraphActionBindings,
  createRivetStoredValueSnapshotStore,
} from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { useStableCallback } from './useStableCallback.js';
import type { EditorGraphRun } from './editorGraphRunOptions.js';
import { projectState } from '../state/savedGraphs.js';

export function useRunUiGraphAction(tryRunGraph: EditorGraphRun) {
  const project = useAtomValue(projectState);

  return useStableCallback(
    async (
      uiGraph: UiGraph,
      componentId: UiComponentId,
      state: Record<string, unknown>,
      abortSignal?: AbortSignal,
      onProgress?: (progress: GraphProgress) => void,
      storage?: Record<string, unknown>,
    ) => {
      return await runUiGraphAction({
        abortSignal,
        componentId,
        onProgress,
        project,
        state,
        storage,
        tryRunGraph,
        uiGraph,
      });
    },
  );
}

export async function runUiGraphAction(options: {
  abortSignal?: AbortSignal;
  componentId: UiComponentId;
  onProgress?: (progress: GraphProgress) => void;
  project: Project;
  state: Record<string, unknown>;
  storage?: Record<string, unknown>;
  tryRunGraph: EditorGraphRun;
  uiGraph: UiGraph;
}): Promise<{
  outputs: GraphOutputs;
  statePatch: Record<string, unknown>;
  storagePatch: Record<string, unknown>;
}> {
  const uiGraph = normalizeUiGraph(options.uiGraph);
  const component = getUiGraphActionComponent(uiGraph, options.componentId);
  if (!component) {
    throw new Error('UI action component not found.');
  }

  if (component.action.type !== 'runGraph') {
    throw new Error(`Unsupported UI action type: ${component.action.type}`);
  }

  if (!component.action.graphId) {
    throw new Error('This UI action is not connected to a graph.');
  }

  const bindingErrors = validateUiGraphActionBindings(options.project, uiGraph, options.componentId);
  if (bindingErrors.length > 0) {
    throw new Error(`Invalid web app ${component.type} bindings: ${formatUiGraphActionBindingIssues(bindingErrors)}`);
  }

  options.abortSignal?.throwIfAborted();
  const browserStoredValues = createRivetStoredValueSnapshotStore(options.storage ?? {});
  let remoteStoragePatch: Record<string, unknown> = {};
  const rawInputs = resolveUiGraphComponentActionInputs(component, options.state);
  const runOptions = {
    graphId: component.action.graphId,
    inputs: toGraphInputs(rawInputs),
    onProgress: options.onProgress,
    onWebAppStoragePatch: (storagePatch: Record<string, unknown>) => {
      remoteStoragePatch = { ...remoteStoragePatch, ...storagePatch };
    },
    requireLiveRun: true,
    returnWhenGraphOutputsReady: true,
    throwOnError: true,
    waitForResults: true,
    storedValueStore: browserStoredValues.store,
    webAppStorage: (options.storage ?? {}) as RivetWebAppStorage,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
  const outputs = await options.tryRunGraph(runOptions);
  options.abortSignal?.throwIfAborted();

  if (!outputs) {
    throw new Error('The web app action did not return graph outputs.');
  }

  return {
    outputs,
    statePatch: resolveUiGraphComponentActionOutputStatePatch(component, outputs, options.state),
    storagePatch: { ...browserStoredValues.getPatch(), ...remoteStoragePatch },
  };
}

function toGraphInputs(values: Record<string, unknown>): GraphInputs {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, jsonValueToDataValue(value)]));
}
