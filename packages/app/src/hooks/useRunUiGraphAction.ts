import {
  type GraphInputs,
  type GraphOutputs,
  type Project,
  type UiComponentId,
  type UiGraph,
  formatUiGraphButtonBindingIssues,
  getUiGraphActionComponent,
  jsonValueToDataValue,
  normalizeUiGraphComponentIds,
  resolveUiGraphActionOutputStatePatch,
  resolveUiGraphActionInputs,
  validateUiGraphButtonBindings,
} from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { useStableCallback } from './useStableCallback.js';
import type { EditorGraphRun } from './editorGraphRunOptions.js';
import { projectState } from '../state/savedGraphs.js';

export function useRunUiGraphAction(tryRunGraph: EditorGraphRun) {
  const project = useAtomValue(projectState);

  return useStableCallback(
    async (uiGraph: UiGraph, componentId: UiComponentId, state: Record<string, unknown>, abortSignal?: AbortSignal) => {
      return await runUiGraphAction({ abortSignal, componentId, project, state, tryRunGraph, uiGraph });
    },
  );
}

export async function runUiGraphAction(options: {
  abortSignal?: AbortSignal;
  componentId: UiComponentId;
  project: Project;
  state: Record<string, unknown>;
  tryRunGraph: EditorGraphRun;
  uiGraph: UiGraph;
}): Promise<{ outputs: GraphOutputs; statePatch: Record<string, unknown> }> {
  const uiGraph = normalizeUiGraphComponentIds(options.uiGraph);
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

  const bindingErrors = validateUiGraphButtonBindings(options.project, uiGraph, options.componentId);
  if (bindingErrors.length > 0) {
    throw new Error(`Invalid web app button bindings: ${formatUiGraphButtonBindingIssues(bindingErrors)}`);
  }

  options.abortSignal?.throwIfAborted();
  const rawInputs = resolveUiGraphActionInputs(component.action, options.state);
  const runOptions = {
    graphId: component.action.graphId,
    inputs: toGraphInputs(rawInputs),
    requireLiveRun: true,
    throwOnError: true,
    waitForResults: true,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
  const outputs = await options.tryRunGraph(runOptions);
  options.abortSignal?.throwIfAborted();

  if (!outputs) {
    throw new Error('The web app action did not return graph outputs.');
  }

  return {
    outputs,
    statePatch: resolveUiGraphActionOutputStatePatch(component.action, outputs),
  };
}

function toGraphInputs(values: Record<string, unknown>): GraphInputs {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, jsonValueToDataValue(value)]));
}
