import Portal from '@atlaskit/portal';
import Select from '@atlaskit/select';
import { type FC, type ReactNode, useState } from 'react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import {
  type GraphBoundary,
  type GraphId,
  getGraphBoundary,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  initializeUiGraphChatActionBindings,
  newId,
  type Project,
  UI_GRAPH_GAP_SIZES,
  type UiComponentId,
  type UiGraphComponent,
  type UiGraphGapSize,
  type UiGraphChatRunGraphAction,
  type UiGraphInputBinding,
  type UiGraphOutputRenderMode,
} from '@valerypopoff/rivet2-core';
import {
  getButtonInputRows,
  getButtonOutputRows,
  initializeButtonActionToGraphBoundary,
  normalizeButtonActionToGraphBoundary,
  setButtonInputRows,
  setButtonOutputRows,
  type UiGraphButtonComponent,
} from './buttonBindings.js';

export type UiGraphDataKeyWrite = {
  key: string;
  outputIndex?: number;
};

export type UiGraphComponentDataKeys = {
  reads: readonly string[];
  writes: readonly UiGraphDataKeyWrite[];
};

export type UiGraphComponentSettingsProps = {
  component: UiGraphComponent;
  dataKeyOptions: readonly string[];
  isDataKeyAlreadyUsed(key: string, currentUsage: { componentId: UiComponentId; outputIndex?: number }): boolean;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
  project: Project;
};

type UiGraphComponentDescriptor = {
  Settings: FC<UiGraphComponentSettingsProps>;
  create(options: { graphId: GraphId | undefined; id: UiComponentId }): UiGraphComponent;
  getDataKeys(component: UiGraphComponent): UiGraphComponentDataKeys;
  label: string;
};

type UiGraphComponentDescriptorMap = {
  [Type in UiGraphComponent['type']]: UiGraphComponentDescriptor;
};

const noDataKeys = (): UiGraphComponentDataKeys => ({ reads: [], writes: [] });

type UiGraphSelectOption = {
  isDisabled?: boolean;
  label: string;
  value: string;
};

const UiGraphSelect: FC<{
  ariaLabel?: string;
  isDisabled?: boolean;
  onChange(value: string): void;
  options: readonly UiGraphSelectOption[];
  placeholder?: string;
  value: string | undefined;
}> = ({ ariaLabel, isDisabled, onChange, options, placeholder, value }) => {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;

  return (
    <>
      <Select
        aria-label={ariaLabel}
        isDisabled={isDisabled}
        menuPlacement="auto"
        menuPortalTarget={menuPortalTarget}
        menuPosition="fixed"
        menuShouldScrollIntoView={false}
        options={options}
        placeholder={placeholder}
        value={selectedOption}
        onChange={(selected) => selected && onChange(selected.value)}
      />
      <Portal>
        <div ref={setMenuPortalTarget} data-ui-graph-builder-owned-portal />
      </Portal>
    </>
  );
};

const OUTPUT_RENDER_OPTIONS: UiGraphSelectOption[] = [
  { label: 'Text', value: 'text' },
  { label: 'JSON', value: 'json' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Image', value: 'image' },
];

function getDataKeySelectOptions(value: string, dataKeyOptions: readonly string[]): UiGraphSelectOption[] {
  const options = dataKeyOptions.map((key) => ({ label: key, value: key }));

  if (!value) {
    return options.length > 0 ? options : [{ isDisabled: true, label: 'No data keys available', value: '' }];
  }
  if (dataKeyOptions.includes(value)) {
    return options;
  }

  return [
    {
      isDisabled: true,
      label: `${value} (missing)`,
      value,
    },
    ...options,
  ];
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

const TextSettings: FC<UiGraphComponentSettingsProps> = ({ component, onUpdate }) => {
  if (component.type !== 'text') {
    return null;
  }

  return (
    <label className="ui-graph-builder-field">
      Text
      <textarea
        value={component.text}
        onChange={(event) =>
          onUpdate((draft) => {
            (draft as typeof component).text = event.target.value;
          })
        }
      />
    </label>
  );
};

const MarkdownSettings: FC<UiGraphComponentSettingsProps> = ({ component, onUpdate }) => {
  if (component.type !== 'markdown') {
    return null;
  }

  return (
    <label className="ui-graph-builder-field">
      Markdown
      <textarea
        value={component.markdown}
        onChange={(event) =>
          onUpdate((draft) => {
            (draft as typeof component).markdown = event.target.value;
          })
        }
      />
    </label>
  );
};

const GapSettings: FC<UiGraphComponentSettingsProps> = ({ component, onUpdate }) => {
  if (component.type !== 'gap') {
    return null;
  }

  return (
    <label className="ui-graph-builder-field">
      Size
      <UiGraphSelect
        options={UI_GRAPH_GAP_SIZES.map((size) => ({
          label: size[0]!.toUpperCase() + size.slice(1),
          value: size,
        }))}
        value={component.size}
        onChange={(value) =>
          onUpdate((draft) => {
            (draft as typeof component).size = value as UiGraphGapSize;
          })
        }
      />
    </label>
  );
};

const InputLikeSettings: FC<UiGraphComponentSettingsProps> = ({ component, isDataKeyAlreadyUsed, onUpdate }) => {
  if (component.type !== 'input' && component.type !== 'textarea') {
    return null;
  }

  return (
    <>
      <label className="ui-graph-builder-field">
        Label
        <input
          value={component.label}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).label = event.target.value;
            })
          }
        />
      </label>
      <label className="ui-graph-builder-field">
        Data key
        <input
          value={component.stateKey}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).stateKey = event.target.value;
            })
          }
        />
        {isDataKeyAlreadyUsed(component.stateKey, { componentId: component.id }) && (
          <span className="ui-graph-data-key-warning">This data key is already used.</span>
        )}
      </label>
      <label className="ui-graph-builder-field">
        Placeholder
        <input
          value={component.placeholder ?? ''}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).placeholder = event.target.value;
            })
          }
        />
      </label>
    </>
  );
};

const ButtonSettings: FC<UiGraphComponentSettingsProps> = ({
  component,
  dataKeyOptions,
  isDataKeyAlreadyUsed,
  onUpdate,
  project,
}) => {
  if (component.type !== 'button') {
    return null;
  }

  const boundary = getGraphBoundary(project, component.action.graphId);
  const graphOptions = getUiGraphGraphOptions(project, component.action.graphId);
  const hasSelectableGraph = graphOptions.some((option) => !option.isDisabled);

  return (
    <>
      <label className="ui-graph-builder-field">
        Graph to run
        <UiGraphSelect
          isDisabled={!hasSelectableGraph}
          options={graphOptions}
          placeholder={hasSelectableGraph ? 'Select graph...' : 'No graphs available'}
          value={component.action.graphId}
          onChange={(value) =>
            onUpdate((draft) => {
              const button = draft as UiGraphButtonComponent;
              const graphId = value as GraphId;
              const isInitialTarget = button.action.graphId == null;
              button.action.graphId = graphId;
              const boundary = getGraphBoundary(project, graphId);
              if (isInitialTarget) {
                initializeButtonActionToGraphBoundary(button, boundary);
              } else {
                normalizeButtonActionToGraphBoundary(button, boundary);
              }
            })
          }
        />
      </label>
      <div className="ui-graph-builder-separator" />
      <ButtonInputMappingsEditor
        boundary={boundary}
        component={component}
        dataKeyOptions={dataKeyOptions}
        onUpdate={onUpdate}
      />
      <div className="ui-graph-builder-separator" />
      <ButtonOutputMappingsEditor
        boundary={boundary}
        component={component}
        isDataKeyAlreadyUsed={isDataKeyAlreadyUsed}
        onUpdate={onUpdate}
      />
      <div className="ui-graph-builder-separator" />
      <label className="ui-graph-builder-field">
        Label
        <input
          value={component.label}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).label = event.target.value;
            })
          }
        />
      </label>
    </>
  );
};

type UiGraphChatComponent = Extract<UiGraphComponent, { type: 'chat' }>;

const ChatSettings: FC<UiGraphComponentSettingsProps> = ({ component, dataKeyOptions, onUpdate, project }) => {
  if (component.type !== 'chat') {
    return null;
  }

  const boundary = getGraphBoundary(project, component.action.graphId);
  const graphOptions = getUiGraphGraphOptions(project, component.action.graphId);
  const hasSelectableGraph = graphOptions.some((option) => !option.isDisabled);
  const additionalInputs = component.action.inputMappings ?? [];
  const additionalInputIds = additionalInputs.map((binding) => binding.inputKey);
  const updateAction = (updater: (action: UiGraphChatRunGraphAction) => void) =>
    onUpdate((draft) => updater((draft as UiGraphChatComponent).action));

  return (
    <>
      <label className="ui-graph-builder-field">
        Graph to run
        <UiGraphSelect
          isDisabled={!hasSelectableGraph}
          options={graphOptions}
          placeholder={hasSelectableGraph ? 'Select graph...' : 'No graphs available'}
          value={component.action.graphId}
          onChange={(value) =>
            onUpdate((draft) => {
              const chat = draft as UiGraphChatComponent;
              const graphId = value as GraphId;
              chat.action = initializeUiGraphChatActionBindings(
                { graphId, type: 'runGraph' },
                getGraphBoundary(project, graphId),
              );
            })
          }
        />
      </label>
      <div className="ui-graph-builder-separator" />
      <ChatPortField
        label="User message input"
        emptyLabel="The selected graph has no inputs"
        ports={boundary?.inputs ?? []}
        value={component.action.userInputId}
        unavailableIds={new Set([component.action.historyInputId, ...additionalInputIds].filter(Boolean))}
        onChange={(userInputId) =>
          updateAction((action) => {
            action.userInputId = userInputId;
          })
        }
      />
      <ChatPortField
        label="Conversation history input"
        emptyLabel="The selected graph has no inputs"
        ports={boundary?.inputs ?? []}
        value={component.action.historyInputId}
        unavailableIds={new Set([component.action.userInputId, ...additionalInputIds].filter(Boolean))}
        onChange={(historyInputId) =>
          updateAction((action) => {
            action.historyInputId = historyInputId;
          })
        }
      />
      <ChatPortField
        label="Assistant response output"
        emptyLabel="The selected graph has no outputs"
        ports={boundary?.outputs ?? []}
        value={component.action.responseOutputId}
        onChange={(responseOutputId) =>
          updateAction((action) => {
            action.responseOutputId = responseOutputId;
          })
        }
      />
      <div className="ui-graph-builder-separator" />
      <ChatAdditionalInputsEditor
        boundary={boundary}
        component={component}
        dataKeyOptions={dataKeyOptions}
        onUpdate={onUpdate}
      />
      <div className="ui-graph-builder-separator" />
      <label className="ui-graph-builder-field">
        Message placeholder
        <input
          value={component.placeholder ?? ''}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as UiGraphChatComponent).placeholder = event.target.value;
            })
          }
        />
      </label>
    </>
  );
};

const ChatPortField: FC<{
  emptyLabel: string;
  label: string;
  onChange(value: string): void;
  ports: readonly { id: string }[];
  unavailableIds?: ReadonlySet<string | undefined>;
  value?: string;
}> = ({ emptyLabel, label, onChange, ports, unavailableIds, value }) => (
  <label className="ui-graph-builder-field">
    {label}
    <UiGraphSelect
      isDisabled={ports.length === 0}
      options={getGraphPortOptions(value, ports, unavailableIds)}
      placeholder={ports.length > 0 ? `Select ${label.toLowerCase()}...` : emptyLabel}
      value={value}
      onChange={onChange}
    />
  </label>
);

function getGraphPortOptions(
  value: string | undefined,
  ports: readonly { id: string }[],
  unavailableIds: ReadonlySet<string | undefined> = new Set(),
): UiGraphSelectOption[] {
  const options = ports.map(({ id }) => ({ isDisabled: id !== value && unavailableIds.has(id), label: id, value: id }));
  if (!value || options.some((option) => option.value === value)) {
    return options;
  }
  return [{ isDisabled: true, label: `${value} (missing)`, value }, ...options];
}

const ChatAdditionalInputsEditor: FC<{
  boundary: ReturnType<typeof getGraphBoundary>;
  component: UiGraphChatComponent;
  dataKeyOptions: readonly string[];
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ boundary, component, dataKeyOptions, onUpdate }) => {
  const rows = component.action.inputMappings ?? [];
  const nextBinding = createChatAdditionalInputBinding(component.action, boundary, dataKeyOptions);

  return (
    <div className="ui-graph-action-section">
      {rows.map((row, index) => {
        const unavailableIds = new Set([
          component.action.userInputId,
          component.action.historyInputId,
          ...rows.filter((_, rowIndex) => rowIndex !== index).map((binding) => binding.inputKey),
        ]);
        const showLabels = index === 0;

        return (
          <div className="ui-graph-chat-input-row" key={`chat-input-${index}`}>
            <ActionMappingField label="Graph input ID" showLabel={showLabels}>
              <UiGraphSelect
                ariaLabel={showLabels ? undefined : `Graph input ID for additional input ${index + 1}`}
                isDisabled={!boundary}
                options={getGraphPortOptions(row.inputKey, boundary?.inputs ?? [], unavailableIds)}
                placeholder="Select graph input..."
                value={row.inputKey}
                onChange={(inputKey) =>
                  onUpdate((draft) => {
                    const chat = draft as UiGraphChatComponent;
                    chat.action.inputMappings = (chat.action.inputMappings ?? []).map((binding, rowIndex) =>
                      rowIndex === index ? { ...binding, inputKey } : binding,
                    );
                  })
                }
              />
            </ActionMappingField>
            <ActionMappingField label="Data key to send" showLabel={showLabels}>
              <UiGraphSelect
                ariaLabel={showLabels ? undefined : `Data key to send for additional input ${index + 1}`}
                isDisabled={dataKeyOptions.length === 0}
                options={getDataKeySelectOptions(row.stateKey, dataKeyOptions)}
                placeholder="Select data key..."
                value={row.stateKey}
                onChange={(stateKey) =>
                  onUpdate((draft) => {
                    const chat = draft as UiGraphChatComponent;
                    chat.action.inputMappings = (chat.action.inputMappings ?? []).map((binding, rowIndex) =>
                      rowIndex === index ? { ...binding, stateKey } : binding,
                    );
                  })
                }
              />
            </ActionMappingField>
            <button
              type="button"
              className="ui-graph-chat-input-remove"
              aria-label={`Remove additional input ${row.inputKey || index + 1}`}
              title="Remove additional input"
              onClick={() =>
                onUpdate((draft) => {
                  const action = (draft as UiGraphChatComponent).action;
                  const nextRows = (action.inputMappings ?? []).filter((_, rowIndex) => rowIndex !== index);
                  if (nextRows.length > 0) {
                    action.inputMappings = nextRows;
                  } else {
                    delete action.inputMappings;
                  }
                })
              }
            >
              <DeleteIcon aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="ui-graph-builder-button secondary ui-graph-chat-add-input"
        title="Add another graph input mapping"
        onClick={() =>
          onUpdate((draft) => {
            const action = (draft as UiGraphChatComponent).action;
            action.inputMappings = [...(action.inputMappings ?? []), nextBinding];
          })
        }
      >
        <PlusIcon aria-hidden="true" />
        <span>Add input</span>
      </button>
    </div>
  );
};

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

function ActionMappingField({
  children,
  label,
  showLabel,
}: {
  children: ReactNode;
  label: string;
  showLabel: boolean;
}): ReactNode {
  return showLabel ? (
    <label className="ui-graph-builder-field">
      {label}
      {children}
    </label>
  ) : (
    <div className="ui-graph-builder-field">{children}</div>
  );
}

const OutputSettings: FC<UiGraphComponentSettingsProps> = ({ component, dataKeyOptions, onUpdate }) => {
  if (component.type !== 'output') {
    return null;
  }

  return (
    <>
      <label className="ui-graph-builder-field">
        Label
        <input
          value={component.label ?? ''}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).label = event.target.value;
            })
          }
        />
      </label>
      <label className="ui-graph-builder-field">
        Data key
        <UiGraphSelect
          isDisabled={dataKeyOptions.length === 0}
          options={getDataKeySelectOptions(component.stateKey, dataKeyOptions)}
          value={component.stateKey}
          onChange={(value) =>
            onUpdate((draft) => {
              (draft as typeof component).stateKey = value;
            })
          }
        />
      </label>
      <label className="ui-graph-builder-field">
        Render as
        <UiGraphSelect
          options={OUTPUT_RENDER_OPTIONS}
          value={component.renderAs ?? 'text'}
          onChange={(value) =>
            onUpdate((draft) => {
              (draft as typeof component).renderAs = value as UiGraphOutputRenderMode;
            })
          }
        />
      </label>
    </>
  );
};

const ButtonInputMappingsEditor: FC<{
  boundary: ReturnType<typeof getGraphBoundary>;
  component: UiGraphButtonComponent;
  dataKeyOptions: readonly string[];
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ boundary, component, dataKeyOptions, onUpdate }) => {
  const rows = getButtonInputRows(component, boundary);

  return (
    <div className="ui-graph-action-section">
      {boundary && rows.length === 0 && <div className="ui-graph-action-empty">The selected graph has no inputs.</div>}
      {rows.map((row, index) => {
        const showLabels = index === 0;

        return (
          <div className="ui-graph-action-mapping-row" key={`input-${index}`}>
            <ActionMappingField label="Graph input ID" showLabel={showLabels}>
              <input
                aria-label={showLabels ? undefined : `Graph input ID: ${row.inputKey}`}
                className="ui-graph-action-port-id"
                value={row.inputKey}
                readOnly
                disabled
                title={row.inputKey}
              />
            </ActionMappingField>
            <ActionMappingField label="Data key to send" showLabel={showLabels}>
              <UiGraphSelect
                ariaLabel={showLabels ? undefined : `Data key to send for ${row.inputKey}`}
                isDisabled={dataKeyOptions.length === 0}
                options={getDataKeySelectOptions(row.stateKey, dataKeyOptions)}
                value={row.stateKey}
                onChange={(value) =>
                  onUpdate((draft) => {
                    const button = draft as UiGraphButtonComponent;
                    const nextRows = getButtonInputRows(button, boundary);
                    nextRows[index] = { ...nextRows[index]!, stateKey: value };
                    setButtonInputRows(button, nextRows);
                  })
                }
              />
            </ActionMappingField>
          </div>
        );
      })}
    </div>
  );
};

const ButtonOutputMappingsEditor: FC<{
  boundary: ReturnType<typeof getGraphBoundary>;
  component: UiGraphButtonComponent;
  isDataKeyAlreadyUsed: UiGraphComponentSettingsProps['isDataKeyAlreadyUsed'];
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ boundary, component, isDataKeyAlreadyUsed, onUpdate }) => {
  const rows = getButtonOutputRows(component, boundary);

  return (
    <div className="ui-graph-action-section">
      {boundary && rows.length === 0 && <div className="ui-graph-action-empty">The selected graph has no outputs.</div>}
      {rows.map((row, index) => {
        const showLabels = index === 0;

        return (
          <div className="ui-graph-action-mapping-block" key={`output-${index}`}>
            <div className="ui-graph-action-mapping-row">
              <ActionMappingField label="Graph output ID" showLabel={showLabels}>
                <input
                  aria-label={showLabels ? undefined : `Graph output ID: ${row.outputKey ?? ''}`}
                  className="ui-graph-action-port-id"
                  value={row.outputKey ?? ''}
                  readOnly
                  disabled
                  title={row.outputKey}
                />
              </ActionMappingField>
              <ActionMappingField label="Data key to save to" showLabel={showLabels}>
                <input
                  aria-label={showLabels ? undefined : `Data key to save for ${row.outputKey ?? ''}`}
                  value={row.stateKey}
                  onChange={(event) =>
                    onUpdate((draft) => {
                      const button = draft as UiGraphButtonComponent;
                      const nextRows = getButtonOutputRows(button, boundary);
                      nextRows[index] = { ...nextRows[index]!, stateKey: event.target.value };
                      setButtonOutputRows(button, nextRows);
                    })
                  }
                />
              </ActionMappingField>
            </div>
            {isDataKeyAlreadyUsed(row.stateKey, { componentId: component.id, outputIndex: index }) && (
              <div className="ui-graph-data-key-warning">This data key is already used.</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const UI_GRAPH_COMPONENT_DESCRIPTORS = {
  text: {
    Settings: TextSettings,
    create: ({ id }) => ({ id, text: 'Text', type: 'text' }),
    getDataKeys: noDataKeys,
    label: 'Text',
  },
  markdown: {
    Settings: MarkdownSettings,
    create: ({ id }) => ({ id, markdown: '## Heading', type: 'markdown' }),
    getDataKeys: noDataKeys,
    label: 'Markdown',
  },
  gap: {
    Settings: GapSettings,
    create: ({ id }) => ({ id, size: 'medium', type: 'gap' }),
    getDataKeys: noDataKeys,
    label: 'Gap',
  },
  input: {
    Settings: InputLikeSettings,
    create: ({ id }) => ({ id, label: 'Input', stateKey: 'input', type: 'input' }),
    getDataKeys: (component) =>
      component.type === 'input' && component.stateKey
        ? { reads: [], writes: [{ key: component.stateKey }] }
        : noDataKeys(),
    label: 'Input',
  },
  textarea: {
    Settings: InputLikeSettings,
    create: ({ id }) => ({ id, label: 'Input', stateKey: 'input', type: 'textarea' }),
    getDataKeys: (component) =>
      component.type === 'textarea' && component.stateKey
        ? { reads: [], writes: [{ key: component.stateKey }] }
        : noDataKeys(),
    label: 'Textarea',
  },
  button: {
    Settings: ButtonSettings,
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
    Settings: ChatSettings,
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
    Settings: OutputSettings,
    create: ({ id }) => ({ id, label: 'Result', renderAs: 'json', stateKey: 'result', type: 'output' }),
    getDataKeys: (component) =>
      component.type === 'output' && component.stateKey ? { reads: [component.stateKey], writes: [] } : noDataKeys(),
    label: 'Output',
  },
} satisfies UiGraphComponentDescriptorMap;

export const UI_GRAPH_COMPONENT_PALETTE = (
  Object.keys(UI_GRAPH_COMPONENT_DESCRIPTORS) as UiGraphComponent['type'][]
).map((type) => ({ label: UI_GRAPH_COMPONENT_DESCRIPTORS[type].label, type }));

export function createUiGraphComponent(type: UiGraphComponent['type'], graphId: GraphId | undefined): UiGraphComponent {
  return UI_GRAPH_COMPONENT_DESCRIPTORS[type].create({ graphId, id: newId<UiComponentId>() });
}

export function getUiGraphComponentDataKeys(component: UiGraphComponent): UiGraphComponentDataKeys {
  return UI_GRAPH_COMPONENT_DESCRIPTORS[component.type].getDataKeys(component);
}

export function getUiGraphComponentDescriptor(type: UiGraphComponent['type']): UiGraphComponentDescriptor {
  return UI_GRAPH_COMPONENT_DESCRIPTORS[type];
}

export function getUiGraphComponentLabel(type: UiGraphComponent['type']): string {
  return UI_GRAPH_COMPONENT_DESCRIPTORS[type].label;
}
