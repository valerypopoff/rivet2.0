import type { Opaque } from 'type-fest';
import type { GraphId } from './NodeGraph.js';
import { newId } from '../utils/newId.js';
import type { DataValue } from './DataValue.js';

export type UiGraphId = Opaque<string, 'UiGraphId'>;
export type UiComponentId = Opaque<string, 'UiComponentId'>;
export type UiGraphOutputs = Record<string, DataValue>;

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
      renderAs?: 'text' | 'json' | 'markdown';
    };

export type UiGraph = {
  id: UiGraphId;
  name: string;
  description?: string;
  components: UiGraphComponent[];
};

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
export function getUiGraphActionState(action: UiGraphRunGraphAction, state: Record<string, unknown>): Record<string, unknown> {
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
