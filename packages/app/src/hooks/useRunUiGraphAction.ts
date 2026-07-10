import {
  type GraphInputs,
  type GraphOutputs,
  type UiComponentId,
  type UiGraph,
  getUiGraphActionComponent,
  jsonValueToDataValue,
  normalizeUiGraphComponentIds,
  resolveUiGraphActionOutputStatePatch,
  resolveUiGraphActionInputs,
} from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import type { EditorGraphRun } from './editorGraphRunOptions.js';

export function useRunUiGraphAction(tryRunGraph: EditorGraphRun) {
  return useStableCallback(async (uiGraph: UiGraph, componentId: UiComponentId, state: Record<string, unknown>) => {
    return await runUiGraphAction({ componentId, state, tryRunGraph, uiGraph });
  });
}

export async function runUiGraphAction(options: {
  componentId: UiComponentId;
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

  const rawInputs = resolveUiGraphActionInputs(component.action, options.state);
  const outputs = await options.tryRunGraph({
    graphId: component.action.graphId,
    inputs: toGraphInputs(rawInputs),
    requireLiveRun: true,
    throwOnError: true,
    waitForResults: true,
  });

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
