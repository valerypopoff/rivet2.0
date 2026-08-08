import Portal from '@atlaskit/portal';
import Select from '@atlaskit/select';
import { type ComponentProps, type FC, type ReactNode, useState } from 'react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import AlertCircleIcon from 'majesticons/line/alert-circle-line.svg?react';
import {
  type GraphId,
  getGraphBoundary,
  initializeUiGraphChatActionBindings,
  type Project,
  UI_GRAPH_GAP_SIZES,
  type UiComponentId,
  type UiGraphChatRunGraphAction,
  type UiGraphComponent,
  type UiGraphGapSize,
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
import {
  createChatAdditionalInputBinding,
  getUiGraphGraphOptions,
  UI_GRAPH_COMPONENT_MODELS,
  type UiGraphComponentDataKeys,
  type UiGraphDataKeyWrite,
  type UiGraphSelectOption,
} from './uiGraphComponentModel.js';
import { isUiGraphDataKeyMissing } from './dataKeys.js';
import { Tooltip } from '../Tooltip.js';
import { LabeledToggle } from '../LabeledToggle.js';

export {
  createChatAdditionalInputBinding,
  createUiGraphComponent,
  getUiGraphComponentDataKeys,
  getUiGraphComponentLabel,
  getUiGraphGraphOptions,
  UI_GRAPH_COMPONENT_PALETTE,
  UI_GRAPH_COMPONENT_PALETTE_GROUPS,
} from './uiGraphComponentModel.js';
export type { UiGraphComponentDataKeys, UiGraphDataKeyWrite, UiGraphSelectOption } from './uiGraphComponentModel.js';

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

const UiGraphSelect: FC<{
  ariaLabel?: string;
  hasMissingDataKey?: boolean;
  isDisabled?: boolean;
  onChange(value: string): void;
  options: readonly UiGraphSelectOption[];
  placeholder?: string;
  value: string | undefined;
}> = ({ ariaLabel, hasMissingDataKey, isDisabled, onChange, options, placeholder, value }) => {
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
        styles={
          hasMissingDataKey
            ? {
                control: (base) => ({
                  ...base,
                  '&:hover': { borderColor: 'var(--error)' },
                  borderColor: 'var(--error)',
                  boxShadow: '0 0 0 1px var(--error)',
                }),
                singleValue: (base) => ({ ...base, color: 'var(--error)' }),
              }
            : undefined
        }
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

const DATA_KEY_CONFLICT_TOOLTIP =
  'This data key is also written by an earlier component. Running this component still works and replaces the value.';

const DataKeyInput: FC<ComponentProps<'input'> & { hasConflict?: boolean }> = ({
  hasConflict = false,
  ...inputProps
}) => (
  <div className="ui-graph-data-key-input">
    <input {...inputProps} />
    {hasConflict ? (
      <Tooltip content={DATA_KEY_CONFLICT_TOOLTIP} tag="span" className="ui-graph-data-key-warning-tooltip">
        <AlertCircleIcon className="ui-graph-data-key-warning-icon" aria-label="Data key is already used" />
      </Tooltip>
    ) : null}
  </div>
);

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

const TextLikeSettings: FC<UiGraphComponentSettingsProps> = ({ component, onUpdate }) => {
  if (component.type !== 'text' && component.type !== 'markdown') {
    return null;
  }
  return (
    <label className="ui-graph-builder-field">
      {component.type === 'text' ? 'Text' : 'Markdown'}
      <textarea
        value={component.type === 'text' ? component.text : component.markdown}
        onChange={(event) =>
          onUpdate((draft) => {
            if (draft.type === 'text') draft.text = event.target.value;
            else if (draft.type === 'markdown') draft.markdown = event.target.value;
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
      <StateProducerFields {...{ component, isDataKeyAlreadyUsed, onUpdate }} />
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

const DropdownSettings: FC<UiGraphComponentSettingsProps> = ({ component, isDataKeyAlreadyUsed, onUpdate }) => {
  if (component.type !== 'dropdown') {
    return null;
  }

  const dropdown = component;

  const updateItem = (index: number, updater: (item: (typeof dropdown.items)[number]) => void) =>
    onUpdate((draft) => {
      const dropdown = draft as typeof component;
      const items = dropdown.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const nextItem = { ...item };
        updater(nextItem);
        return nextItem;
      });
      dropdown.items = items;
    });

  return (
    <>
      <StateProducerFields {...{ component, isDataKeyAlreadyUsed, onUpdate }} />
      <div className="ui-graph-dropdown-items">
        {dropdown.items.map((item, index) => (
          <div className="ui-graph-dropdown-item-row" key={`dropdown-item-${index}`}>
            <ActionMappingField label="Label" showLabel={index === 0}>
              <input
                aria-label={index === 0 ? undefined : `Label for item ${index + 1}`}
                value={item.label}
                onChange={(event) => updateItem(index, (draft) => (draft.label = event.target.value))}
              />
            </ActionMappingField>
            <ActionMappingField label="Value" showLabel={index === 0}>
              <input
                aria-label={index === 0 ? undefined : `Value for item ${index + 1}`}
                value={item.value}
                onChange={(event) => updateItem(index, (draft) => (draft.value = event.target.value))}
              />
            </ActionMappingField>
            <button
              type="button"
              className="ui-graph-dropdown-item-remove"
              aria-label={`Remove ${item.label || `item ${index + 1}`}`}
              title="Remove item"
              onClick={() =>
                onUpdate((draft) => {
                  const dropdown = draft as typeof component;
                  dropdown.items = dropdown.items.filter((_, itemIndex) => itemIndex !== index);
                })
              }
            >
              <DeleteIcon aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ui-graph-builder-settings-action-button ui-graph-dropdown-add-item"
          onClick={() =>
            onUpdate((draft) => {
              const dropdown = draft as typeof component;
              const itemNumber = getNextDropdownItemNumber(dropdown.items);
              dropdown.items = [...dropdown.items, { label: `Option ${itemNumber}`, value: `option-${itemNumber}` }];
            })
          }
        >
          <PlusIcon aria-hidden="true" />
          <span>Add item</span>
        </button>
      </div>
    </>
  );
};

const StateProducerFields: FC<
  Pick<UiGraphComponentSettingsProps, 'isDataKeyAlreadyUsed' | 'onUpdate'> & {
    component: Extract<UiGraphComponent, { type: 'input' | 'textarea' | 'dropdown' }>;
  }
> = ({ component, isDataKeyAlreadyUsed, onUpdate }) => (
  <>
    <label className="ui-graph-builder-field">
      Label
      <input
        value={component.label}
        onChange={(event) =>
          onUpdate((draft) => {
            if (draft.type === component.type) draft.label = event.target.value;
          })
        }
      />
    </label>
    <label className="ui-graph-builder-field">
      Data key
      <DataKeyInput
        hasConflict={isDataKeyAlreadyUsed(component.stateKey, { componentId: component.id })}
        value={component.stateKey}
        onChange={(event) =>
          onUpdate((draft) => {
            if (draft.type === component.type) draft.stateKey = event.target.value;
          })
        }
      />
    </label>
  </>
);

function getNextDropdownItemNumber(items: readonly { value: string }[]): number {
  const values = new Set(items.map((item) => item.value));
  let itemNumber = 1;

  while (values.has(`option-${itemNumber}`)) {
    itemNumber += 1;
  }

  return itemNumber;
}

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

  return (
    <>
      <GraphTargetField
        graphId={component.action.graphId}
        project={project}
        onChange={(graphId) =>
          onUpdate((draft) => {
            const button = draft as UiGraphButtonComponent;
            const isInitialTarget = button.action.graphId == null;
            button.action.graphId = graphId;
            const boundary = getGraphBoundary(project, graphId);
            if (isInitialTarget) initializeButtonActionToGraphBoundary(button, boundary);
            else normalizeButtonActionToGraphBoundary(button, boundary);
          })
        }
      />
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
  const additionalInputs = component.action.inputMappings ?? [];
  const additionalInputIds = additionalInputs.map((binding) => binding.inputKey);
  const updateAction = (updater: (action: UiGraphChatRunGraphAction) => void) =>
    onUpdate((draft) => updater((draft as UiGraphChatComponent).action));

  return (
    <>
      <GraphTargetField
        graphId={component.action.graphId}
        project={project}
        onChange={(graphId) =>
          onUpdate((draft) => {
            const chat = draft as UiGraphChatComponent;
            chat.action = initializeUiGraphChatActionBindings(
              { graphId, type: 'runGraph' },
              getGraphBoundary(project, graphId),
            );
          })
        }
      />
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
      <LabeledToggle
        id={`ui-graph-chat-response-inspection-${component.id}`}
        isChecked={component.allowResponseInspection === true}
        label="Allow response inspection"
        helperMessage="Lets users inspect privacy-bounded timing, model, tool, usage, and cost metadata."
        onChange={(allowResponseInspection) =>
          onUpdate((draft) => {
            (draft as UiGraphChatComponent).allowResponseInspection = allowResponseInspection;
          })
        }
      />
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

const GraphTargetField: FC<{
  graphId: GraphId | undefined;
  onChange(graphId: GraphId): void;
  project: Project;
}> = ({ graphId, onChange, project }) => {
  const options = getUiGraphGraphOptions(project, graphId);
  const hasSelectableGraph = options.some((option) => !option.isDisabled);
  return (
    <label className="ui-graph-builder-field">
      Graph to run
      <UiGraphSelect
        isDisabled={!hasSelectableGraph}
        options={options}
        placeholder={hasSelectableGraph ? 'Select graph...' : 'No graphs available'}
        value={graphId}
        onChange={(value) => onChange(value as GraphId)}
      />
    </label>
  );
};

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
                hasMissingDataKey={isUiGraphDataKeyMissing(row.stateKey, dataKeyOptions)}
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
        className="ui-graph-builder-settings-action-button ui-graph-chat-add-input"
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
          hasMissingDataKey={isUiGraphDataKeyMissing(component.stateKey, dataKeyOptions)}
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
      {boundary?.inputs.length === 0 && <div className="ui-graph-action-empty">The selected graph has no inputs.</div>}
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
                hasMissingDataKey={isUiGraphDataKeyMissing(row.stateKey, dataKeyOptions)}
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
      {boundary?.outputs.length === 0 && (
        <div className="ui-graph-action-empty">The selected graph has no outputs.</div>
      )}
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
                <DataKeyInput
                  aria-label={showLabels ? undefined : `Data key to save for ${row.outputKey ?? ''}`}
                  hasConflict={isDataKeyAlreadyUsed(row.stateKey, { componentId: component.id, outputIndex: index })}
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
          </div>
        );
      })}
    </div>
  );
};

export const UI_GRAPH_COMPONENT_DESCRIPTORS = {
  text: {
    ...UI_GRAPH_COMPONENT_MODELS.text,
    Settings: TextLikeSettings,
  },
  markdown: {
    ...UI_GRAPH_COMPONENT_MODELS.markdown,
    Settings: TextLikeSettings,
  },
  gap: {
    ...UI_GRAPH_COMPONENT_MODELS.gap,
    Settings: GapSettings,
  },
  input: {
    ...UI_GRAPH_COMPONENT_MODELS.input,
    Settings: InputLikeSettings,
  },
  textarea: {
    ...UI_GRAPH_COMPONENT_MODELS.textarea,
    Settings: InputLikeSettings,
  },
  dropdown: {
    ...UI_GRAPH_COMPONENT_MODELS.dropdown,
    Settings: DropdownSettings,
  },
  button: {
    ...UI_GRAPH_COMPONENT_MODELS.button,
    Settings: ButtonSettings,
  },
  chat: {
    ...UI_GRAPH_COMPONENT_MODELS.chat,
    Settings: ChatSettings,
  },
  output: {
    ...UI_GRAPH_COMPONENT_MODELS.output,
    Settings: OutputSettings,
  },
} satisfies UiGraphComponentDescriptorMap;

export function getUiGraphComponentDescriptor(type: UiGraphComponent['type']): UiGraphComponentDescriptor {
  return UI_GRAPH_COMPONENT_DESCRIPTORS[type];
}
