import type { Opaque } from 'type-fest';
import type { GraphId } from './NodeGraph.js';
import { newId } from '../utils/newId.js';
import type { ChatMessage, DataValue } from './DataValue.js';

export type UiGraphId = Opaque<string, 'UiGraphId'>;
export type UiComponentId = Opaque<string, 'UiComponentId'>;
export type UiGraphOutputs = Record<string, DataValue>;
export const UI_GRAPH_GAP_SIZES = ['small', 'medium', 'large'] as const;
export type UiGraphGapSize = (typeof UI_GRAPH_GAP_SIZES)[number];
export const UI_GRAPH_OUTPUT_RENDER_MODES = ['text', 'json', 'markdown', 'image'] as const;
export type UiGraphOutputRenderMode = (typeof UI_GRAPH_OUTPUT_RENDER_MODES)[number];
export type UiGraphDropdownItem = {
  label: string;
  value: string;
};

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

export type UiGraphChatRunGraphAction = {
  type: 'runGraph';
  graphId?: GraphId;
  userInputId?: string;
  historyInputId?: string;
  responseOutputId?: string;
  inputMappings?: UiGraphInputBinding[];
};

export type UiGraphChatMessage = {
  role: 'assistant' | 'user';
  content: string;
};

export type UiGraphChatPin = {
  messageIndex: number;
  promptMessageIndex?: number;
  prompt?: UiGraphChatMessage;
  response: UiGraphChatMessage;
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
      type: 'dropdown';
      label: string;
      stateKey: string;
      items: UiGraphDropdownItem[];
    }
  | {
      id: UiComponentId;
      type: 'button';
      label: string;
      action: UiGraphAction;
    }
  | {
      id: UiComponentId;
      type: 'chat';
      action: UiGraphChatRunGraphAction;
      placeholder?: string;
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

export type UiGraphActionComponent = Extract<UiGraphComponent, { type: 'button' | 'chat' }>;

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
    } else if (component.type === 'dropdown') {
      state[component.stateKey] = '';
    } else if (component.type === 'chat') {
      state[getUiGraphChatDraftStateKey(component.id)] = '';
      state[getUiGraphChatMessagesStateKey(component.id)] = [];
      state[getUiGraphChatPinsStateKey(component.id)] = [];
    }
  }

  return state;
}

export function getUiGraphActionComponent(
  uiGraph: UiGraph,
  componentId: UiComponentId,
): UiGraphActionComponent | undefined {
  return uiGraph.components.find(
    (component): component is UiGraphActionComponent =>
      component.id === componentId && (component.type === 'button' || component.type === 'chat'),
  );
}

export function getUiGraphChatDraftStateKey(componentId: UiComponentId): string {
  return `__rivet_chat_${componentId}_draft`;
}

export function getUiGraphChatMessagesStateKey(componentId: UiComponentId): string {
  return `__rivet_chat_${componentId}_messages`;
}

export function getUiGraphChatPinsStateKey(componentId: UiComponentId): string {
  return `__rivet_chat_${componentId}_pins`;
}

export function getUiGraphChatMessages(
  componentId: UiComponentId,
  state: Readonly<Record<string, unknown>>,
): UiGraphChatMessage[] {
  const messages = state[getUiGraphChatMessagesStateKey(componentId)];
  return Array.isArray(messages) ? messages.filter(isUiGraphChatMessage) : [];
}

export function getUiGraphChatPins(
  componentId: UiComponentId,
  state: Readonly<Record<string, unknown>>,
): UiGraphChatPin[] {
  const messages = getUiGraphChatMessages(componentId, state);
  const storedPins = state[getUiGraphChatPinsStateKey(componentId)];
  const messageIndexes = Array.isArray(storedPins)
    ? [
        ...new Set(
          storedPins.filter(
            (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
          ),
        ),
      ].sort((left, right) => left - right)
    : [];
  const pinnedIndexes = new Set(messageIndexes);
  const pins: UiGraphChatPin[] = [];
  let prompt: UiGraphChatMessage | undefined;
  let promptMessageIndex: number | undefined;

  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      prompt = message;
      promptMessageIndex = messageIndex;
    } else if (pinnedIndexes.has(messageIndex)) {
      pins.push({ messageIndex, prompt, promptMessageIndex, response: message });
    }
  });

  return pins;
}

export function createUiGraphChatPinStatePatch(
  componentId: UiComponentId,
  state: Readonly<Record<string, unknown>>,
  messageIndex: number,
): Record<string, unknown> | undefined {
  const messages = getUiGraphChatMessages(componentId, state);
  if (messages[messageIndex]?.role !== 'assistant') {
    return undefined;
  }

  const pinsStateKey = getUiGraphChatPinsStateKey(componentId);
  const pinnedIndexes = getUiGraphChatPins(componentId, state).map((pin) => pin.messageIndex);
  return {
    [pinsStateKey]: pinnedIndexes.includes(messageIndex)
      ? pinnedIndexes.filter((index) => index !== messageIndex)
      : [...pinnedIndexes, messageIndex].sort((left, right) => left - right),
  };
}

/** Clears a Chat's conversation and pins without discarding an unsent draft. */
export function createUiGraphChatHistoryFlushStatePatch(componentId: UiComponentId): Record<string, unknown> {
  return {
    [getUiGraphChatMessagesStateKey(componentId)]: [],
    [getUiGraphChatPinsStateKey(componentId)]: [],
  };
}

export function createUiGraphChatSubmissionStatePatch(
  componentId: UiComponentId,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const draftStateKey = getUiGraphChatDraftStateKey(componentId);
  const content = `${state[draftStateKey] ?? ''}`.trim();
  if (!content) {
    return undefined;
  }

  return {
    [draftStateKey]: '',
    [getUiGraphChatMessagesStateKey(componentId)]: [
      ...getUiGraphChatMessages(componentId, state),
      { role: 'user', content } satisfies UiGraphChatMessage,
    ],
  };
}

export function getUiGraphComponentActionState(
  component: UiGraphActionComponent,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (component.type === 'button') {
    return getUiGraphActionState(component.action, state);
  }

  const messagesStateKey = getUiGraphChatMessagesStateKey(component.id);
  return {
    ...getUiGraphActionState(component.action, state),
    [messagesStateKey]: getUiGraphChatMessages(component.id, state),
  };
}

export function resolveUiGraphComponentActionInputs(
  component: UiGraphActionComponent,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (component.type === 'button') {
    return resolveUiGraphActionInputs(component.action, state);
  }

  const messages = getUiGraphChatMessages(component.id, state);
  const latestMessage = messages[messages.length - 1];
  const latestUserMessage = latestMessage?.role === 'user' ? latestMessage : undefined;
  const historyMessages = latestUserMessage ? messages.slice(0, -1) : messages;
  const inputs = resolveUiGraphActionInputs(component.action, state);
  if (component.action.userInputId) {
    inputs[component.action.userInputId] = latestUserMessage?.content ?? '';
  }
  if (component.action.historyInputId) {
    inputs[component.action.historyInputId] = {
      type: 'chat-message[]',
      value: historyMessages.map(toRivetChatMessage),
    } satisfies DataValue;
  }
  return inputs;
}

export function resolveUiGraphComponentActionOutputStatePatch(
  component: UiGraphActionComponent,
  outputs: UiGraphOutputs,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (component.type === 'button') {
    return resolveUiGraphActionOutputStatePatch(component.action, outputs);
  }

  const outputId = component.action.responseOutputId;
  if (!outputId || !Object.prototype.hasOwnProperty.call(outputs, outputId)) {
    throw new Error(
      outputId
        ? `Graph output "${outputId}" was not returned by the target graph.`
        : 'The Chat component has no response graph output.',
    );
  }

  const messagesStateKey = getUiGraphChatMessagesStateKey(component.id);
  return {
    [messagesStateKey]: [
      ...getUiGraphChatMessages(component.id, state),
      { role: 'assistant', content: getUiGraphChatResponseText(outputs[outputId]!) } satisfies UiGraphChatMessage,
    ],
  };
}

export function getUiGraphComponentActionOutputStateKeys(component: UiGraphActionComponent): string[] {
  return component.type === 'button'
    ? getUiGraphActionOutputBindings(component.action)
        .map((binding) => binding.stateKey.trim())
        .filter(Boolean)
    : [getUiGraphChatMessagesStateKey(component.id)];
}

export function resolveUiGraphActionInputs(
  action: UiGraphRunGraphAction,
  state: Readonly<Record<string, unknown>>,
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
  state: Readonly<Record<string, unknown>>,
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

function isUiGraphChatMessage(value: unknown): value is UiGraphChatMessage {
  return (
    value != null &&
    typeof value === 'object' &&
    ((value as UiGraphChatMessage).role === 'user' || (value as UiGraphChatMessage).role === 'assistant') &&
    typeof (value as UiGraphChatMessage).content === 'string'
  );
}

function toRivetChatMessage(message: UiGraphChatMessage): ChatMessage {
  return message.role === 'user'
    ? { type: 'user', message: message.content }
    : {
        type: 'assistant',
        message: message.content,
        function_call: undefined,
        function_calls: undefined,
      };
}

function getUiGraphChatResponseText(output: DataValue): string {
  if (output.type === 'chat-message') {
    const message = output.value.message;
    if (typeof message === 'string') {
      return message;
    }
    return (Array.isArray(message) ? message : [message])
      .flatMap((part) => (typeof part === 'string' ? [part] : []))
      .join('\n');
  }

  if (typeof output.value === 'string') {
    return output.value;
  }
  if (output.value == null) {
    return '';
  }

  try {
    return JSON.stringify(output.value, null, 2);
  } catch {
    return String(output.value);
  }
}
