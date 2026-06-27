import { css } from '@emotion/react';
import { produce } from 'immer';
import { type CSSProperties, type FC, useState } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { DndContext, PointerSensor, closestCenter, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  type GraphId,
  type NodeGraph,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  type UiGraphId,
  type UiGraphInputBinding,
  type UiGraphOutputBinding,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  newId,
} from '@valerypopoff/rivet2-core';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
import { selectedUiGraphIdState } from '../state/uiGraphs.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { leftSidebarLiveWidthState } from '../state/ui.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { createWebviewWindowHandle } from '../utils/platform/window.js';
import {
  createRivetWebAppPreviewUrl,
  type PreviewActionRequest,
  type PreviewActionResponse,
  RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX,
  writeRivetWebAppPreviewPayload,
} from './rivetWebApps/RivetWebAppPreviewWindow.js';
import { RivetWebAppRenderer } from './rivetWebApps/RivetWebAppRenderer.js';
import { useRunUiGraphAction } from '../hooks/useRunUiGraphAction.js';
import type { EditorGraphRun } from '../hooks/editorGraphRunOptions.js';

const styles = css`
  position: fixed;
  inset: var(--project-selector-height) 0 0 var(--ui-graph-left-offset, 0px);
  display: grid;
  grid-template-columns: minmax(360px, 520px) minmax(360px, 1fr);
  gap: 18px;
  padding: 28px;
  overflow: auto;
  background: var(--canvas-background-color, var(--grey-darker));
  color: var(--foreground);

  .ui-graph-builder-panel,
  .ui-graph-builder-preview {
    min-height: 0;
    border: 1px solid var(--foldable-section-border);
    border-radius: 10px;
    background: var(--modal-surface-bg);
  }

  .ui-graph-builder-panel {
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow: hidden;
    padding: 18px;
  }

  .ui-graph-builder-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .ui-graph-builder-title {
    margin: 0;
    font-size: var(--ui-font-size-xl);
  }

  .ui-graph-builder-actions,
  .ui-graph-builder-add {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .ui-graph-builder-scroll {
    align-content: start;
    display: grid;
    flex: 1 1 auto;
    gap: 18px;
    grid-auto-rows: max-content;
    min-height: 0;
    overflow: auto;
    padding-right: 4px;
  }

  .ui-graph-builder-button {
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--primary);
    color: var(--foreground-on-primary);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 8px 12px;
  }

  .ui-graph-builder-button.secondary {
    background: var(--grey-dark-colorish);
    color: var(--foreground);
  }

  .ui-graph-builder-fields,
  .ui-graph-component-card {
    display: grid;
    gap: 10px;
  }

  .ui-graph-builder-field {
    display: grid;
    gap: 5px;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
  }

  .ui-graph-builder-field input,
  .ui-graph-builder-field textarea,
  .ui-graph-builder-field select {
    min-width: 0;
    border: 1px solid var(--form-control-border);
    border-radius: 7px;
    background: var(--form-control-bg);
    color: var(--foreground);
    font: inherit;
    font-weight: 400;
    padding: 8px 10px;
  }

  .ui-graph-builder-field select {
    appearance: none;
    background-color: var(--form-control-bg);
    background-image: linear-gradient(45deg, transparent 50%, var(--foreground-muted) 50%),
      linear-gradient(135deg, var(--foreground-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50%;
    background-repeat: no-repeat;
    background-size:
      5px 5px,
      5px 5px;
    padding-right: 36px;
  }

  .ui-graph-builder-field textarea {
    appearance: none;
    min-height: 78px;
    resize: vertical;
  }

  .ui-graph-builder-palette {
    display: grid;
    gap: 8px;
  }

  .ui-graph-builder-palette-title {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    font-weight: 800;
  }

  .ui-graph-builder-add .ui-graph-builder-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .ui-graph-builder-add-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    color: var(--primary-text);
    opacity: 0;
    transform: translateX(-2px);
    transition:
      opacity 120ms ease,
      transform 120ms ease;
  }

  .ui-graph-builder-add .ui-graph-builder-button:hover .ui-graph-builder-add-icon {
    opacity: 1;
    transform: translateX(0);
  }

  .ui-graph-components {
    display: grid;
    gap: 12px;
  }

  .ui-graph-component-card {
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    padding: 12px;
    background: color-mix(in srgb, var(--modal-surface-bg) 88%, var(--foreground) 4%);
  }

  .ui-graph-component-card.active {
    background: color-mix(in srgb, var(--modal-surface-bg) 82%, var(--primary) 13%);
  }

  .ui-graph-component-card.dragging {
    opacity: 0.56;
    z-index: 1;
  }

  .ui-graph-component-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--primary-text);
    cursor: grab;
    font-weight: 800;
    user-select: none;

    &:active {
      cursor: grabbing;
    }
  }

  .ui-graph-component-card-title-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .ui-graph-component-drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    line-height: 1;
    padding: 0;
    user-select: none;
  }

  .ui-graph-action-section {
    display: grid;
    gap: 8px;
  }

  .ui-graph-action-mapping-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: end;
  }

  .ui-graph-action-add-button,
  .ui-graph-action-delete-button {
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--grey-dark-colorish);
    color: var(--foreground);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 8px 10px;
  }

  .ui-graph-action-delete-button {
    min-height: 35px;
  }

  .ui-graph-action-delete-button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .ui-graph-builder-separator {
    height: 1px;
    background: var(--foldable-section-border);
    margin: 4px 0;
  }

  .ui-graph-builder-preview {
    overflow: hidden;
  }
`;

export const UiGraphBuilder: FC<{ runGraph: EditorGraphRun }> = ({ runGraph }) => {
  const [project, setProject] = useAtom(projectState);
  const store = useStore();
  const selectedUiGraphId = useAtomValue(selectedUiGraphIdState);
  const runUiGraphAction = useRunUiGraphAction(runGraph);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeComponentId, setActiveComponentId] = useState<UiComponentId | undefined>();
  const uiGraph = selectedUiGraphId ? project.uiGraphs?.[selectedUiGraphId] : undefined;
  const graphs = Object.values(project.graphs);

  const updateUiGraph = useStableCallback((updater: (uiGraph: UiGraph) => void) => {
    if (!selectedUiGraphId) {
      return;
    }

    setProject((currentProject) =>
      produce(currentProject, (draft) => {
        const draftUiGraph = draft.uiGraphs?.[selectedUiGraphId];
        if (draftUiGraph) {
          updater(draftUiGraph);
        }
      }),
    );
  });

  const addComponent = useStableCallback((type: UiGraphComponent['type']) => {
    updateUiGraph((draft) => {
      draft.components.push(createUiComponent(type, project.metadata.mainGraphId));
    });
  });

  const deleteComponent = useStableCallback((componentId: UiComponentId) => {
    updateUiGraph((draft) => {
      draft.components = draft.components.filter((component) => component.id !== componentId);
    });
  });

  const handleComponentDragEnd = useStableCallback((event: DragEndEvent) => {
    const draggedComponentId = event.active.id as UiComponentId;
    const targetComponentId = event.over?.id as UiComponentId | undefined;

    if (!targetComponentId || draggedComponentId === targetComponentId) {
      return;
    }

    updateUiGraph((draft) => {
      const fromIndex = draft.components.findIndex((component) => component.id === draggedComponentId);
      const toIndex = draft.components.findIndex((component) => component.id === targetComponentId);

      if (fromIndex >= 0 && toIndex >= 0) {
        draft.components = arrayMove(draft.components, fromIndex, toIndex);
      }
    });
  });

  const updateComponent = useStableCallback(
    (componentId: UiComponentId, updater: (component: UiGraphComponent) => void) => {
      updateUiGraph((draft) => {
        const component = draft.components.find((candidate) => candidate.id === componentId);
        if (component) {
          updater(component);
        }
      });
    },
  );

  const openPreviewWindow = useStableCallback(async () => {
    if (!uiGraph) {
      return;
    }

    const token = crypto.randomUUID();
    const previewProjectId = project.metadata.id;
    const storageKey = `${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`;
    writeRivetWebAppPreviewPayload(token, { uiGraph });
    const channel = new BroadcastChannel(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`);
    let previewWindow: Awaited<ReturnType<typeof createWebviewWindowHandle>> | undefined;
    let unlistenClose: (() => unknown) | undefined;
    let cleaned = false;

    const cleanup = (options: { closeWindow?: boolean } = {}) => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      channel.removeEventListener('message', handleMessage);
      channel.close();
      localStorage.removeItem(storageKey);
      void unlistenClose?.();

      if (options.closeWindow) {
        void previewWindow?.close();
      }
    };
    const handleMessage = (event: MessageEvent<PreviewActionRequest>) => {
      void handlePreviewAction(event);
    };
    const handlePreviewAction = async (event: MessageEvent<PreviewActionRequest>) => {
      if (event.data.type !== 'runAction') {
        if (event.data.type === 'requestPayload') {
          channel.postMessage({
            payload: { uiGraph },
            requestId: event.data.requestId,
            type: 'previewPayload',
          } satisfies PreviewActionResponse);
        }
        return;
      }

      try {
        const activeProject = store.get(projectState);
        if (activeProject.metadata.id !== previewProjectId) {
          throw new Error(
            'This web app preview belongs to another project tab. Select that project before running actions.',
          );
        }
        if (!activeProject.uiGraphs?.[uiGraph.id]) {
          throw new Error('This web app was deleted from the project. Open a new preview window.');
        }

        const result = await runUiGraphAction(uiGraph, event.data.componentId, event.data.state);
        if (cleaned) {
          return;
        }

        channel.postMessage({
          requestId: event.data.requestId,
          result,
          type: 'actionResult',
        } satisfies PreviewActionResponse);
      } catch (error) {
        if (cleaned) {
          return;
        }

        channel.postMessage({
          error: error instanceof Error ? error.message : String(error),
          requestId: event.data.requestId,
          type: 'actionError',
        } satisfies PreviewActionResponse);
      }
    };

    channel.addEventListener('message', handleMessage);

    try {
      previewWindow = await createWebviewWindowHandle(`rivet-web-app-preview-${token}`, {
        center: true,
        title: uiGraph.name,
        url: createRivetWebAppPreviewUrl(token),
      });

      unlistenClose = await previewWindow.onCloseRequested?.(() => cleanup());
    } catch (error) {
      cleanup({ closeWindow: true });
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });

  if (!uiGraph) {
    return (
      <div css={styles} style={getUiGraphBuilderStyle(sidebarOpen, leftSidebarWidth)}>
        Select or create a web app.
      </div>
    );
  }

  return (
    <div css={styles} style={getUiGraphBuilderStyle(sidebarOpen, leftSidebarWidth)}>
      <section className="ui-graph-builder-panel">
        <div className="ui-graph-builder-header">
          <h1 className="ui-graph-builder-title">Web app</h1>
          <div className="ui-graph-builder-actions">
            <button type="button" className="ui-graph-builder-button" onClick={() => void openPreviewWindow()}>
              Run web app
            </button>
          </div>
        </div>
        <div className="ui-graph-builder-scroll">
          <div className="ui-graph-builder-fields">
            <label className="ui-graph-builder-field">
              Name
              <input
                value={uiGraph.name}
                onChange={(event) =>
                  updateUiGraph((draft) => {
                    draft.name = event.target.value;
                  })
                }
              />
            </label>
            <label className="ui-graph-builder-field">
              Description
              <textarea
                value={uiGraph.description ?? ''}
                onChange={(event) =>
                  updateUiGraph((draft) => {
                    draft.description = event.target.value;
                  })
                }
              />
            </label>
          </div>
          <div className="ui-graph-builder-palette">
            <div className="ui-graph-builder-palette-title">Components</div>
            <div className="ui-graph-builder-add">
              {UI_GRAPH_COMPONENT_TYPES.map(({ label, type }) => (
                <button
                  key={type}
                  type="button"
                  className="ui-graph-builder-button secondary"
                  onClick={() => addComponent(type)}
                >
                  <span className="ui-graph-builder-add-icon" aria-hidden="true">
                    +
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="ui-graph-components">
            <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleComponentDragEnd}>
              <SortableContext
                items={uiGraph.components.map((component) => component.id)}
                strategy={verticalListSortingStrategy}
              >
                {uiGraph.components.map((component) => (
                  <UiComponentEditor
                    key={component.id}
                    activeComponentId={activeComponentId}
                    component={component}
                    graphs={graphs}
                    onActivate={setActiveComponentId}
                    onDelete={() => deleteComponent(component.id)}
                    onUpdate={(updater) => updateComponent(component.id, updater)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </section>
      <section className="ui-graph-builder-preview">
        <RivetWebAppRenderer
          activeComponentId={activeComponentId}
          onActiveComponentChange={setActiveComponentId}
          uiGraph={uiGraph}
          onRunAction={(componentId, state) => runUiGraphAction(uiGraph, componentId, state)}
        />
      </section>
    </div>
  );
};

const UiComponentEditor: FC<{
  activeComponentId: UiComponentId | undefined;
  component: UiGraphComponent;
  graphs: NodeGraph[];
  onActivate(componentId: UiComponentId): void;
  onDelete(): void;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ activeComponentId, component, graphs, onActivate, onDelete, onUpdate }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: component.id });

  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`ui-graph-component-card${isDragging ? ' dragging' : ''}${activeComponentId === component.id ? ' active' : ''}`}
      onFocusCapture={() => onActivate(component.id)}
      onPointerDownCapture={() => onActivate(component.id)}
    >
      <div className="ui-graph-component-card-title" {...attributes} {...listeners}>
        <span className="ui-graph-component-card-title-main">
          <span className="ui-graph-component-drag-handle" aria-hidden="true" title="Drag to reorder">
            ::
          </span>
          <span>{formatUiComponentTypeName(component.type)}</span>
        </span>
        <button
          type="button"
          className="ui-graph-builder-button secondary"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
      {renderComponentFields(component, graphs, onUpdate)}
    </div>
  );
};

function renderComponentFields(
  component: UiGraphComponent,
  graphs: { metadata?: { id?: GraphId; name?: string } }[],
  onUpdate: (updater: (component: UiGraphComponent) => void) => void,
) {
  switch (component.type) {
    case 'text':
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
    case 'markdown':
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
    case 'input':
    case 'textarea':
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
    case 'button':
      return (
        <>
          <label className="ui-graph-builder-field">
            Target graph
            <select
              value={component.action.graphId ?? ''}
              onChange={(event) =>
                onUpdate((draft) => {
                  (draft as typeof component).action.graphId = event.target.value
                    ? (event.target.value as GraphId)
                    : undefined;
                })
              }
            >
              <option value="">Select graph...</option>
              {graphs.map((graph) => (
                <option key={graph.metadata?.id} value={graph.metadata?.id}>
                  {graph.metadata?.name ?? graph.metadata?.id}
                </option>
              ))}
            </select>
          </label>
          <ButtonInputMappingsEditor component={component} onUpdate={onUpdate} />
          <ButtonOutputMappingsEditor component={component} onUpdate={onUpdate} />
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
    case 'output':
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
            <input
              value={component.stateKey}
              onChange={(event) =>
                onUpdate((draft) => {
                  (draft as typeof component).stateKey = event.target.value;
                })
              }
            />
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
  }
}

type ButtonComponent = Extract<UiGraphComponent, { type: 'button' }>;

const ButtonInputMappingsEditor: FC<{
  component: ButtonComponent;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ component, onUpdate }) => {
  const rows = getButtonInputRows(component);

  return (
    <div className="ui-graph-action-section">
      {rows.map((row, index) => (
        <div className="ui-graph-action-mapping-row" key={`input-${index}`}>
          <label className="ui-graph-builder-field">
            Graph input ID
            <input
              value={row.inputKey}
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as ButtonComponent;
                  const nextRows = getButtonInputRows(button);
                  nextRows[index] = { ...nextRows[index]!, inputKey: event.target.value };
                  setButtonInputRows(button, nextRows);
                })
              }
            />
          </label>
          <label className="ui-graph-builder-field">
            Data key to send
            <input
              value={row.stateKey}
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as ButtonComponent;
                  const nextRows = getButtonInputRows(button);
                  nextRows[index] = { ...nextRows[index]!, stateKey: event.target.value };
                  setButtonInputRows(button, nextRows);
                })
              }
            />
          </label>
          <button
            type="button"
            className="ui-graph-action-delete-button"
            onClick={() =>
              onUpdate((draft) => {
                const button = draft as ButtonComponent;
                const nextRows = getButtonInputRows(button).filter((_, rowIndex) => rowIndex !== index);
                setButtonInputRows(button, nextRows);
              })
            }
          >
            Delete
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ui-graph-action-add-button"
        onClick={() =>
          onUpdate((draft) => {
            const button = draft as ButtonComponent;
            setButtonInputRows(button, [...getButtonInputRows(button), createNextInputMappingRow(button)]);
          })
        }
      >
        Add graph input
      </button>
    </div>
  );
};

const ButtonOutputMappingsEditor: FC<{
  component: ButtonComponent;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ component, onUpdate }) => {
  const rows = getButtonOutputRows(component);

  return (
    <div className="ui-graph-action-section">
      {rows.map((row, index) => (
        <div className="ui-graph-action-mapping-row" key={`output-${index}`}>
          <label className="ui-graph-builder-field">
            Graph output ID
            <input
              value={row.outputKey ?? ''}
              placeholder="Empty saves all outputs"
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as ButtonComponent;
                  const nextRows = getButtonOutputRows(button);
                  nextRows[index] = { ...nextRows[index]!, outputKey: event.target.value || undefined };
                  setButtonOutputRows(button, nextRows);
                })
              }
            />
          </label>
          <label className="ui-graph-builder-field">
            Data key to save to
            <input
              value={row.stateKey}
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as ButtonComponent;
                  const nextRows = getButtonOutputRows(button);
                  nextRows[index] = { ...nextRows[index]!, stateKey: event.target.value };
                  setButtonOutputRows(button, nextRows);
                })
              }
            />
          </label>
          <button
            type="button"
            className="ui-graph-action-delete-button"
            disabled={rows.length <= 1}
            onClick={() =>
              onUpdate((draft) => {
                const button = draft as ButtonComponent;
                const nextRows = getButtonOutputRows(button).filter((_, rowIndex) => rowIndex !== index);
                setButtonOutputRows(button, nextRows);
              })
            }
          >
            Delete
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ui-graph-action-add-button"
        onClick={() =>
          onUpdate((draft) => {
            const button = draft as ButtonComponent;
            setButtonOutputRows(button, [...getButtonOutputRows(button), createNextOutputMappingRow(button)]);
          })
        }
      >
        Add graph output
      </button>
    </div>
  );
};

function getButtonInputRows(component: ButtonComponent): UiGraphInputBinding[] {
  const rows = getUiGraphActionInputBindings(component.action);
  return rows.length ? rows : [{ inputKey: 'input', stateKey: 'input' }];
}

function getButtonOutputRows(component: ButtonComponent): UiGraphOutputBinding[] {
  const rows = getUiGraphActionOutputBindings(component.action);
  return rows.length ? rows : [{ stateKey: 'result' }];
}

function setButtonInputRows(component: ButtonComponent, rows: UiGraphInputBinding[]) {
  component.action.inputMappings = rows;
  delete component.action.inputs;
}

function setButtonOutputRows(component: ButtonComponent, rows: UiGraphOutputBinding[]) {
  const outputs = (rows.length ? rows : [{ stateKey: 'result' }]).map((row) => ({
    outputKey: row.outputKey || undefined,
    stateKey: row.stateKey,
  }));

  component.action.outputs = outputs;

  delete component.action.outputKey;
  delete component.action.outputStateKey;
}

function createNextInputMappingRow(component: ButtonComponent): UiGraphInputBinding {
  const rows = getButtonInputRows(component);
  return {
    inputKey: createUniqueMappingKey(
      rows.map((row) => row.inputKey),
      'input',
    ),
    stateKey: createUniqueMappingKey(
      rows.map((row) => row.stateKey),
      'input',
    ),
  };
}

function createNextOutputMappingRow(component: ButtonComponent): UiGraphOutputBinding {
  return {
    outputKey: undefined,
    stateKey: createUniqueMappingKey(
      getButtonOutputRows(component).map((row) => row.stateKey),
      'result',
    ),
  };
}

function createUniqueMappingKey(existingKeys: string[], baseKey: string): string {
  const existing = new Set(existingKeys);
  if (!existing.has(baseKey)) {
    return baseKey;
  }

  for (let index = 2; ; index++) {
    const candidate = `${baseKey}${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function getUiGraphBuilderStyle(sidebarOpen: boolean, leftSidebarWidth: number): CSSProperties {
  return {
    '--ui-graph-left-offset': sidebarOpen ? `${leftSidebarWidth}px` : '0px',
  } as CSSProperties;
}

function createUiComponent(type: UiGraphComponent['type'], graphId: GraphId | undefined): UiGraphComponent {
  switch (type) {
    case 'text':
      return { id: newId<UiComponentId>(), type, text: 'Text' };
    case 'markdown':
      return { id: newId<UiComponentId>(), type, markdown: '## Heading' };
    case 'input':
      return { id: newId<UiComponentId>(), type, label: 'Input', stateKey: 'input' };
    case 'textarea':
      return { id: newId<UiComponentId>(), type, label: 'Input', stateKey: 'input' };
    case 'button':
      return {
        id: newId<UiComponentId>(),
        type,
        label: 'Run graph',
        action: {
          type: 'runGraph',
          graphId,
          inputMappings: [{ inputKey: 'input', stateKey: 'input' }],
          outputs: [{ stateKey: 'result' }],
        },
      };
    case 'output':
      return { id: newId<UiComponentId>(), type, label: 'Result', renderAs: 'json', stateKey: 'result' };
  }
}

const UI_GRAPH_COMPONENT_TYPES: { label: string; type: UiGraphComponent['type'] }[] = [
  { label: 'Text', type: 'text' },
  { label: 'Markdown', type: 'markdown' },
  { label: 'Input', type: 'input' },
  { label: 'Textarea', type: 'textarea' },
  { label: 'Button', type: 'button' },
  { label: 'Output', type: 'output' },
];

function formatUiComponentTypeName(type: UiGraphComponent['type']): string {
  return UI_GRAPH_COMPONENT_TYPES.find((componentType) => componentType.type === type)?.label ?? type;
}
