import Portal from '@atlaskit/portal';
import Select from '@atlaskit/select';
import { type FC, type ReactNode, useState } from 'react';
import {
  type GraphId,
  getGraphBoundary,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  newId,
  type Project,
  UI_GRAPH_GAP_SIZES,
  type UiComponentId,
  type UiGraphComponent,
  type UiGraphGapSize,
} from '@valerypopoff/rivet2-core';
import {
  getButtonInputRows,
  getButtonOutputRows,
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
        menuPortalTarget={menuPortalTarget}
        options={options}
        placeholder={placeholder}
        value={selectedOption}
        onChange={(selected) => selected && onChange(selected.value)}
      />
      <Portal>
        <div ref={setMenuPortalTarget} />
      </Portal>
    </>
  );
};

function getDataKeySelectOptions(value: string, dataKeyOptions: readonly string[]): UiGraphSelectOption[] {
  const options = dataKeyOptions.map((key) => ({ label: key, value: key }));

  if (dataKeyOptions.includes(value)) {
    return options;
  }

  return [
    {
      isDisabled: true,
      label: value ? `${value} (missing)` : 'No data keys available',
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
              button.action.graphId = graphId;
              normalizeButtonActionToGraphBoundary(button, getGraphBoundary(project, graphId));
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

const ButtonMappingField: FC<{ children: ReactNode; label: string; showLabel: boolean }> = ({
  children,
  label,
  showLabel,
}) =>
  showLabel ? (
    <label className="ui-graph-builder-field">
      {label}
      {children}
    </label>
  ) : (
    <div className="ui-graph-builder-field">{children}</div>
  );

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
          options={[
            { label: 'Text', value: 'text' },
            { label: 'JSON', value: 'json' },
            { label: 'Markdown', value: 'markdown' },
          ]}
          value={component.renderAs ?? 'text'}
          onChange={(value) =>
            onUpdate((draft) => {
              (draft as typeof component).renderAs = value as 'text' | 'json' | 'markdown';
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
            <ButtonMappingField label="Graph input ID" showLabel={showLabels}>
              <input
                aria-label={showLabels ? undefined : `Graph input ID: ${row.inputKey}`}
                className="ui-graph-action-port-id"
                value={row.inputKey}
                readOnly
                disabled
                title={row.inputKey}
              />
            </ButtonMappingField>
            <ButtonMappingField label="Data key to send" showLabel={showLabels}>
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
            </ButtonMappingField>
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
              <ButtonMappingField label="Graph output ID" showLabel={showLabels}>
                <input
                  aria-label={showLabels ? undefined : `Graph output ID: ${row.outputKey ?? ''}`}
                  className="ui-graph-action-port-id"
                  value={row.outputKey ?? ''}
                  readOnly
                  disabled
                  title={row.outputKey}
                />
              </ButtonMappingField>
              <ButtonMappingField label="Data key to save to" showLabel={showLabels}>
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
              </ButtonMappingField>
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
