import type { Opaque } from 'type-fest';
import type { GraphId } from './NodeGraph.js';
import { newId } from '../utils/newId.js';
import type { DataValue } from './DataValue.js';

export type UiGraphId = Opaque<string, 'UiGraphId'>;
export type UiComponentId = Opaque<string, 'UiComponentId'>;
export type UiGraphOutputs = Record<string, DataValue>;
export const UI_GRAPH_GAP_SIZES = ['small', 'medium', 'large'] as const;
export type UiGraphGapSize = (typeof UI_GRAPH_GAP_SIZES)[number];
export const UI_GRAPH_OUTPUT_RENDER_MODES = ['text', 'json', 'markdown'] as const;
export type UiGraphOutputRenderMode = (typeof UI_GRAPH_OUTPUT_RENDER_MODES)[number];

export type UiGraphValueBinding =
  | {
      type: 'state';
      key: string;
    }
  | {
      type: 'literal';
      value: unknown;
    };

export type UiGraphRunGraphAction = {
  type: 'runGraph';
  graphId?: GraphId;
  inputMappings?: UiGraphInputBinding[];
  inputs?: Record<string, UiGraphValueBinding>;
  outputs?: UiGraphOutputBinding[];
  outputKey?: string;
  outputStateKey?: string;
};

export type UiGraphInputBinding = {
  inputKey: string;
  stateKey: string;
};

export type UiGraphOutputBinding = {
  outputKey?: string;
  stateKey: string;
};

export type UiGraphAction = UiGraphRunGraphAction;

export type UiGraphComponent =
  | {
      id: UiComponentId;
      type: 'text';
      text: string;
    }
  | {
      id: UiComponentId;
      type: 'markdown';
      markdown: string;
    }
  | {
      id: UiComponentId;
      type: 'gap';
      size: UiGraphGapSize;
    }
  | {
      id: UiComponentId;
      type: 'input';
      label: string;
      stateKey: string;
      placeholder?: string;
      defaultValue?: string;
    }
  | {
      id: UiComponentId;
      type: 'textarea';
      label: string;
      stateKey: string;
      placeholder?: string;
      defaultValue?: string;
    }
  | {
      id: UiComponentId;
      type: 'button';
      label: string;
      action: UiGraphAction;
    }
  | {
      id: UiComponentId;
      type: 'output';
      label?: string;
      stateKey: string;
      renderAs?: UiGraphOutputRenderMode;
    };

export type UiGraph = {
  id: UiGraphId;
  name: string;
  description?: string;
  components: UiGraphComponent[];
};

export function hasValidUiGraphComponentIds(uiGraph: UiGraph): boolean {
  const componentIds = new Set<string>();

  for (const component of uiGraph.components) {
    const componentId = typeof component.id === 'string' ? component.id : '';
    if (!componentId.trim() || componentIds.has(componentId)) {
      return false;
    }

    componentIds.add(componentId);
  }

  return true;
}

/**
 * Returns an immutable component-ID repair for legacy or externally assembled
 * UI graphs. Full untrusted-data validation belongs to normalizeUiGraph().
 */
export function normalizeUiGraphComponentIds(uiGraph: UiGraph): UiGraph {
  if (hasValidUiGraphComponentIds(uiGraph)) {
    return uiGraph;
  }

  const reservedIds = new Set(
    uiGraph.components
      .map((component) => (typeof component.id === 'string' ? component.id : ''))
      .filter((componentId) => Boolean(componentId.trim())),
  );
  const usedIds = new Set<string>();
  const graphId = typeof uiGraph.id === 'string' && uiGraph.id.trim() ? uiGraph.id : 'ui-graph';
  const components = uiGraph.components.map((component, index) => {
    const componentId = typeof component.id === 'string' ? component.id : '';
    if (componentId.trim() && !usedIds.has(componentId)) {
      usedIds.add(componentId);
      return component;
    }

    const repairedId = getRepairedUiGraphComponentId(graphId, index, reservedIds, usedIds);
    usedIds.add(repairedId);
    return { ...component, id: repairedId as UiComponentId };
  });

  return { ...uiGraph, components };
}

function getRepairedUiGraphComponentId(
  graphId: string,
  componentIndex: number,
  reservedIds: ReadonlySet<string>,
  usedIds: ReadonlySet<string>,
): string {
  const baseId = `${graphId}-component-${componentIndex + 1}`;
  let repairedId = baseId;
  let suffix = 2;

  while (reservedIds.has(repairedId) || usedIds.has(repairedId)) {
    repairedId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return repairedId;
}

export function createDefaultUiGraph(options: { graphId?: GraphId; name?: string } = {}): UiGraph {
  const promptStateKey = 'input';
  const resultStateKey = 'result';

  return {
    id: newId<UiGraphId>(),
    name: options.name ?? 'Untitled web app',
    components: [
      {
        id: newId<UiComponentId>(),
        type: 'markdown',
        markdown: '## New Rivet web app\n\nEnter a value and run a graph.',
      },
      {
        id: newId<UiComponentId>(),
        type: 'textarea',
        label: 'Input',
        stateKey: promptStateKey,
        placeholder: 'Type something...',
      },
      {
        id: newId<UiComponentId>(),
        type: 'button',
        label: 'Run graph',
        action: {
          type: 'runGraph',
          graphId: options.graphId,
          inputMappings: [{ inputKey: 'input', stateKey: promptStateKey }],
          outputs: [{ stateKey: resultStateKey }],
        },
      },
      {
        id: newId<UiComponentId>(),
        type: 'output',
        label: 'Result',
        stateKey: resultStateKey,
        renderAs: 'json',
      },
    ],
  };
}

export function getUiGraphInitialState(uiGraph: UiGraph): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  for (const component of uiGraph.components) {
    if (component.type === 'input' || component.type === 'textarea') {
      state[component.stateKey] = component.defaultValue ?? '';
    }
  }

  return state;
}

export function getUiGraphActionComponent(
  uiGraph: UiGraph,
  componentId: UiComponentId,
): Extract<UiGraphComponent, { type: 'button' }> | undefined {
  return uiGraph.components.find(
    (component): component is Extract<UiGraphComponent, { type: 'button' }> =>
      component.id === componentId && component.type === 'button',
  );
}

export function resolveUiGraphActionInputs(
  action: UiGraphRunGraphAction,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  if (action.inputMappings) {
    for (const binding of action.inputMappings) {
      if (binding.inputKey) {
        inputs[binding.inputKey] = state[binding.stateKey];
      }
    }

    return inputs;
  }

  for (const [inputId, binding] of Object.entries(action.inputs ?? {})) {
    inputs[inputId] = binding.type === 'state' ? state[binding.key] : binding.value;
  }

  return inputs;
}

/**
 * Selects the UI state that a button action is explicitly allowed to send.
 * Outputs and unrelated form fields stay local to the rendered web app.
 */
export function getUiGraphActionState(
  action: UiGraphRunGraphAction,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set(getUiGraphActionInputBindings(action).map((binding) => binding.stateKey))]
      .filter(Boolean)
      .filter((stateKey) => Object.prototype.hasOwnProperty.call(state, stateKey))
      .map((stateKey) => [stateKey, state[stateKey]]),
  );
}

export function resolveUiGraphActionOutputStateValue(action: UiGraphRunGraphAction, outputs: UiGraphOutputs): unknown {
  if (!action.outputKey) {
    return outputs;
  }

  if (!Object.prototype.hasOwnProperty.call(outputs, action.outputKey)) {
    throw new Error(`Graph output "${action.outputKey}" was not returned by the target graph.`);
  }

  return outputs[action.outputKey]?.value;
}

export function resolveUiGraphActionOutputStatePatch(
  action: UiGraphRunGraphAction,
  outputs: UiGraphOutputs,
): Record<string, unknown> {
  const bindings = getUiGraphActionOutputBindings(action);
  const statePatch: Record<string, unknown> = {};

  for (const binding of bindings) {
    const stateKey = binding.stateKey.trim();
    if (!stateKey) {
      continue;
    }

    statePatch[stateKey] = resolveUiGraphOutputBindingValue(binding, outputs);
  }

  return statePatch;
}

export function getUiGraphActionOutputBindings(action: UiGraphRunGraphAction): UiGraphOutputBinding[] {
  if (action.outputs) {
    return action.outputs;
  }

  return action.outputStateKey ? [{ outputKey: action.outputKey, stateKey: action.outputStateKey }] : [];
}

export function getUiGraphActionInputBindings(action: UiGraphRunGraphAction): UiGraphInputBinding[] {
  if (action.inputMappings) {
    return action.inputMappings;
  }

  return Object.entries(action.inputs ?? {}).map(([inputKey, binding]) => ({
    inputKey,
    stateKey: binding.type === 'state' ? binding.key : '',
  }));
}

function resolveUiGraphOutputBindingValue(binding: UiGraphOutputBinding, outputs: UiGraphOutputs): unknown {
  if (!binding.outputKey) {
    return outputs;
  }

  if (!Object.prototype.hasOwnProperty.call(outputs, binding.outputKey)) {
    throw new Error(`Graph output "${binding.outputKey}" was not returned by the target graph.`);
  }

  return outputs[binding.outputKey]?.value;
}
