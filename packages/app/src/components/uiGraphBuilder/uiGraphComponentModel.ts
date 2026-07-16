import {
  type GraphBoundary,
  type GraphId,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  newId,
  type Project,
  type UiComponentId,
  type UiGraphChatRunGraphAction,
  type UiGraphComponent,
  type UiGraphInputBinding,
} from '@valerypopoff/rivet2-core';

export type UiGraphDataKeyWrite = {
  key: string;
  outputIndex?: number;
};

export type UiGraphComponentDataKeys = {
  reads: readonly string[];
  writes: readonly UiGraphDataKeyWrite[];
};

export type UiGraphSelectOption = {
  isDisabled?: boolean;
  label: string;
  value: string;
};

type UiGraphComponentModel = {
  create(options: { graphId: GraphId | undefined; id: UiComponentId }): UiGraphComponent;
  getDataKeys(component: UiGraphComponent): UiGraphComponentDataKeys;
  label: string;
};

type UiGraphComponentModelMap = {
  [Type in UiGraphComponent['type']]: UiGraphComponentModel;
};

const noDataKeys = (): UiGraphComponentDataKeys => ({ reads: [], writes: [] });

export const UI_GRAPH_COMPONENT_MODELS = {
  text: {
    create: ({ id }) => ({ id, text: 'Text', type: 'text' }),
    getDataKeys: noDataKeys,
    label: 'Text',
  },
  markdown: {
    create: ({ id }) => ({ id, markdown: '## Heading', type: 'markdown' }),
    getDataKeys: noDataKeys,
    label: 'Markdown',
  },
  gap: {
    create: ({ id }) => ({ id, size: 'medium', type: 'gap' }),
    getDataKeys: noDataKeys,
    label: 'Gap',
  },
  input: {
    create: ({ id }) => ({ id, label: 'Input', stateKey: 'input', type: 'input' }),
    getDataKeys: (component) =>
      component.type === 'input' && component.stateKey
        ? { reads: [], writes: [{ key: component.stateKey }] }
        : noDataKeys(),
    label: 'Input',
  },
  textarea: {
    create: ({ id }) => ({ id, label: 'Input', stateKey: 'input', type: 'textarea' }),
    getDataKeys: (component) =>
      component.type === 'textarea' && component.stateKey
        ? { reads: [], writes: [{ key: component.stateKey }] }
        : noDataKeys(),
    label: 'Textarea',
  },
  dropdown: {
    create: ({ id }) => ({
      id,
      items: [{ label: 'Option 1', value: 'option-1' }],
      label: 'Dropdown',
      stateKey: 'selection',
      type: 'dropdown',
    }),
    getDataKeys: (component) =>
      component.type === 'dropdown' && component.stateKey
        ? { reads: [], writes: [{ key: component.stateKey }] }
        : noDataKeys(),
    label: 'Dropdown',
  },
  button: {
    create: ({ graphId, id }) => ({
      action: {
        graphId,
        inputMappings: [{ inputKey: 'input', stateKey: 'input' }],
        outputs: [{ stateKey: 'result' }],
        type: 'runGraph',
      },
      id,
      label: 'Run graph',
      type: 'button',
    }),
    getDataKeys: (component) => {
      if (component.type !== 'button') {
        return noDataKeys();
      }

      return {
        reads: getUiGraphActionInputBindings(component.action)
          .map((binding) => binding.stateKey)
          .filter(Boolean),
        writes: getUiGraphActionOutputBindings(component.action)
          .filter((binding) => Boolean(binding.stateKey))
          .map((binding, outputIndex) => ({ key: binding.stateKey, outputIndex })),
      };
    },
    label: 'Button',
  },
  chat: {
    create: ({ graphId, id }) => ({
      action: { graphId, type: 'runGraph' },
      id,
      placeholder: 'Message...',
      type: 'chat',
    }),
    getDataKeys: (component) =>
      component.type === 'chat'
        ? {
            reads: (component.action.inputMappings ?? []).map((binding) => binding.stateKey).filter(Boolean),
            writes: [],
          }
        : noDataKeys(),
    label: 'Chat',
  },
  output: {
    create: ({ id }) => ({ id, label: 'Result', renderAs: 'json', stateKey: 'result', type: 'output' }),
    getDataKeys: (component) =>
      component.type === 'output' && component.stateKey ? { reads: [component.stateKey], writes: [] } : noDataKeys(),
    label: 'Output',
  },
} satisfies UiGraphComponentModelMap;

export const UI_GRAPH_COMPONENT_PALETTE = (Object.keys(UI_GRAPH_COMPONENT_MODELS) as UiGraphComponent['type'][]).map(
  (type) => ({ label: UI_GRAPH_COMPONENT_MODELS[type].label, type }),
);

export const UI_GRAPH_COMPONENT_PALETTE_GROUPS = [
  { label: 'Layout', types: ['text', 'markdown', 'gap'] },
  { label: 'Input', types: ['input', 'textarea', 'dropdown'] },
  { label: 'Action', types: ['button'] },
  { label: 'Other', types: ['chat', 'output'] },
] as const satisfies readonly { label: string; types: readonly UiGraphComponent['type'][] }[];

export function createUiGraphComponent(type: UiGraphComponent['type'], graphId: GraphId | undefined): UiGraphComponent {
  return UI_GRAPH_COMPONENT_MODELS[type].create({ graphId, id: newId<UiComponentId>() });
}

export function getUiGraphComponentDataKeys(component: UiGraphComponent): UiGraphComponentDataKeys {
  return UI_GRAPH_COMPONENT_MODELS[component.type].getDataKeys(component);
}

export function getUiGraphComponentLabel(type: UiGraphComponent['type']): string {
  return UI_GRAPH_COMPONENT_MODELS[type].label;
}

export function getUiGraphGraphOptions(project: Project, selectedGraphId: GraphId | undefined): UiGraphSelectOption[] {
  const options = Object.values(project.graphs).flatMap((graph) => {
    const graphId = graph.metadata?.id;

    return graphId ? [{ label: graph.metadata?.name || graphId, value: graphId }] : [];
  });

  if (!selectedGraphId || options.some((option) => option.value === selectedGraphId)) {
    return options;
  }

  return [{ isDisabled: true, label: `${selectedGraphId} (missing)`, value: selectedGraphId }, ...options];
}

export function createChatAdditionalInputBinding(
  action: UiGraphChatRunGraphAction,
  boundary: GraphBoundary | undefined,
  dataKeyOptions: readonly string[],
): UiGraphInputBinding {
  const reservedInputIds = new Set([
    action.userInputId,
    action.historyInputId,
    ...(action.inputMappings ?? []).map((binding) => binding.inputKey),
  ]);
  const inputKey = boundary?.inputs.find((input) => !reservedInputIds.has(input.id))?.id ?? '';
  return { inputKey, stateKey: dataKeyOptions[0] ?? '' };
}
