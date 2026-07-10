import type { FC } from 'react';
import {
  type GraphId,
  getGraphBoundary,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  newId,
  type Project,
  type UiComponentId,
  type UiGraphComponent,
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

  return (
    <>
      <label className="ui-graph-builder-field">
        Graph to run
        <select
          value={component.action.graphId ?? ''}
          onChange={(event) =>
            onUpdate((draft) => {
              const button = draft as UiGraphButtonComponent;
              const graphId = event.target.value as GraphId;
              button.action.graphId = graphId;
              normalizeButtonActionToGraphBoundary(button, getGraphBoundary(project, graphId));
            })
          }
        >
          {component.action.graphId ? null : (
            <option value="" disabled>
              {Object.keys(project.graphs).length === 0 ? 'No graphs available' : 'Select graph...'}
            </option>
          )}
          {Object.values(project.graphs).map((graph) => (
            <option key={graph.metadata?.id} value={graph.metadata?.id}>
              {graph.metadata?.name ?? graph.metadata?.id}
            </option>
          ))}
        </select>
      </label>
      <ButtonInputMappingsEditor
        boundary={boundary}
        component={component}
        dataKeyOptions={dataKeyOptions}
        onUpdate={onUpdate}
      />
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
        <select
          disabled={dataKeyOptions.length === 0}
          value={component.stateKey}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).stateKey = event.target.value;
            })
          }
        >
          {dataKeyOptions.includes(component.stateKey) ? null : (
            <option value={component.stateKey} disabled>
              {component.stateKey ? `${component.stateKey} (missing)` : 'No data keys available'}
            </option>
          )}
          {dataKeyOptions.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      <label className="ui-graph-builder-field">
        Render as
        <select
          value={component.renderAs ?? 'text'}
          onChange={(event) =>
            onUpdate((draft) => {
              (draft as typeof component).renderAs = event.target.value as 'text' | 'json' | 'markdown';
            })
          }
        >
          <option value="text">Text</option>
          <option value="json">JSON</option>
          <option value="markdown">Markdown</option>
        </select>
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
      {rows.map((row, index) => (
        <div className="ui-graph-action-mapping-row" key={`input-${index}`}>
          <label className="ui-graph-builder-field">
            Graph input ID
            <input className="ui-graph-action-port-id" value={row.inputKey} readOnly disabled title={row.inputKey} />
          </label>
          <label className="ui-graph-builder-field">
            Data key to send
            <select
              disabled={dataKeyOptions.length === 0}
              value={row.stateKey}
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as UiGraphButtonComponent;
                  const nextRows = getButtonInputRows(button, boundary);
                  nextRows[index] = { ...nextRows[index]!, stateKey: event.target.value };
                  setButtonInputRows(button, nextRows);
                })
              }
            >
              {dataKeyOptions.includes(row.stateKey) ? null : (
                <option value={row.stateKey} disabled>
                  {row.stateKey ? `${row.stateKey} (missing)` : 'No data keys available'}
                </option>
              )}
              {dataKeyOptions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
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
      {rows.map((row, index) => (
        <div className="ui-graph-action-mapping-block" key={`output-${index}`}>
          <div className="ui-graph-action-mapping-row">
            <label className="ui-graph-builder-field">
              Graph output ID
              <input
                className="ui-graph-action-port-id"
                value={row.outputKey ?? ''}
                readOnly
                disabled
                title={row.outputKey}
              />
            </label>
            <label className="ui-graph-builder-field">
              Data key to save to
              <input
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
            </label>
          </div>
          {isDataKeyAlreadyUsed(row.stateKey, { componentId: component.id, outputIndex: index }) && (
            <div className="ui-graph-data-key-warning">This data key is already used.</div>
          )}
        </div>
      ))}
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
