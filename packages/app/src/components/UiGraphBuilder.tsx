import { css } from '@emotion/react';
import { produce } from 'immer';
import { type CSSProperties, type FC, useEffect, useState } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { DndContext, PointerSensor, closestCenter, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import BrowserIcon from 'majesticons/line/browser-line.svg?react';
import {
  type GraphId,
  getGraphBoundary,
  type GraphBoundary,
  type Project,
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
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { createWebviewWindowHandle } from '../utils/platform/window.js';
import {
  createRivetWebAppPreviewUrl,
  type PreviewActionRequest,
  type PreviewActionResponse,
  RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX,
  writeRivetWebAppPreviewPayload,
} from './rivetWebApps/RivetWebAppPreviewWindow.js';
import { RivetWebAppRenderer, type RivetWebAppComponentFrameProps } from './rivetWebApps/RivetWebAppRenderer.js';
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
    overflow: hidden;
    padding: 18px;
  }

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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--primary);
    color: var(--foreground-on-primary);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 8px 12px;
  }

  .ui-graph-builder-button svg {
    width: 1.15em;
    height: 1.15em;
    flex: 0 0 auto;
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
    color: var(--foreground-muted);
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

  .ui-graph-component-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--foreground);
    font-weight: 800;
    user-select: none;
  }

  .ui-graph-component-card-title-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .ui-graph-preview-sortable-row {
    position: relative;
    min-width: 0;
  }

  .ui-graph-preview-sortable-row.dragging {
    opacity: 0.68;
    z-index: 1;
  }

  .ui-graph-preview-sortable-body {
    min-width: 0;
  }

  .ui-graph-preview-drag-handle {
    position: absolute;
    top: 50%;
    right: -66px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 60px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--foreground-muted);
    cursor: grab;
    font-size: calc(var(--ui-font-size-sm) * 2);
    line-height: 1;
    padding: 0;
    transform: translateY(-50%);
    user-select: none;
  }

  .ui-graph-preview-drag-handle:hover {
    background: var(--grey-dark-colorish);
    color: var(--foreground);
  }

  .ui-graph-preview-drag-handle:active {
    cursor: grabbing;
  }

  .ui-graph-action-section {
    display: grid;
    gap: 8px;
  }

  .ui-graph-action-mapping-block {
    display: grid;
    gap: 5px;
  }

  .ui-graph-action-mapping-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    align-items: end;
  }

  .ui-graph-component-delete-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--grey-dark-colorish);
    color: var(--foreground);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    font-size: var(--ui-font-size-xl);
    line-height: 1;
    padding: 0;
  }

  .ui-graph-action-empty {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
  }

  .ui-graph-action-port-id {
    min-width: 0;
    border: 1px solid var(--form-control-border);
    border-radius: 7px;
    background: var(--form-control-bg);
    color: var(--foreground-muted);
    font-weight: 400;
    overflow: hidden;
    padding: 8px 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: none;
  }

  .ui-graph-action-port-id:disabled {
    cursor: default;
    opacity: 0.72;
    -webkit-text-fill-color: var(--foreground-muted);
  }

  .ui-graph-data-key-warning {
    display: block;
    color: var(--warning);
    font-size: var(--ui-font-size-xs);
    font-weight: 600;
    line-height: 1.25;
  }

  .ui-graph-builder-separator {
    height: 1px;
    background: var(--foldable-section-border);
    margin: 4px 0;
  }

  .ui-graph-builder-preview {
    position: relative;
    overflow: hidden;
  }

  .ui-graph-builder-preview-action {
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 3;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.22);
  }
`;

export const UiGraphBuilder: FC<{ runGraph: EditorGraphRun }> = ({ runGraph }) => {
  const [project, setProject] = useAtom(projectState);
  const store = useStore();
  const selectedUiGraphId = useAtomValue(selectedUiGraphIdState);
  const runUiGraphAction = useRunUiGraphAction(runGraph);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const hostUiConfig = useRivetAppHostUiConfig();
  const canRunDesktopPreview = hostUiConfig.webApps?.desktopPreview !== false;
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeComponentId, setActiveComponentId] = useState<UiComponentId | undefined>();
  const uiGraph = selectedUiGraphId ? project.uiGraphs?.[selectedUiGraphId] : undefined;

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
      const component = createUiComponent(type, project.metadata.mainGraphId);
      if (component.type === 'button') {
        normalizeButtonActionToGraphBoundary(component, getGraphBoundary(project, component.action.graphId));
      }

      draft.components.push(component);
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

  useEffect(() => {
    if (!selectedUiGraphId) {
      return;
    }

    updateUiGraph((draft) => {
      for (const component of draft.components) {
        if (component.type === 'button') {
          normalizeButtonActionToGraphBoundary(component, getGraphBoundary(project, component.action.graphId));
        }
      }
    });
  }, [project, selectedUiGraphId, updateUiGraph]);

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
            {uiGraph.components.map((component) => (
              <UiComponentEditor
                key={component.id}
                activeComponentId={activeComponentId}
                component={component}
                project={project}
                uiGraph={uiGraph}
                onActivate={setActiveComponentId}
                onDelete={() => deleteComponent(component.id)}
                onUpdate={(updater) => updateComponent(component.id, updater)}
              />
            ))}
          </div>
        </div>
      </section>
      <section className="ui-graph-builder-preview">
        {canRunDesktopPreview ? (
          <button
            type="button"
            className="ui-graph-builder-button ui-graph-builder-preview-action"
            onClick={() => void openPreviewWindow()}
          >
            <BrowserIcon aria-hidden="true" />
            <span>Run detached</span>
          </button>
        ) : null}
        <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleComponentDragEnd}>
          <SortableContext
            items={uiGraph.components.map((component) => component.id)}
            strategy={verticalListSortingStrategy}
          >
            <RivetWebAppRenderer
              activeComponentId={activeComponentId}
              onActiveComponentChange={setActiveComponentId}
              renderComponentFrame={(frameProps) => <SortablePreviewComponentFrame {...frameProps} />}
              uiGraph={uiGraph}
              onRunAction={(componentId, state) => runUiGraphAction(uiGraph, componentId, state)}
            />
          </SortableContext>
        </DndContext>
      </section>
    </div>
  );
};

const UiComponentEditor: FC<{
  activeComponentId: UiComponentId | undefined;
  component: UiGraphComponent;
  project: Project;
  uiGraph: UiGraph;
  onActivate(componentId: UiComponentId): void;
  onDelete(): void;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ activeComponentId, component, project, uiGraph, onActivate, onDelete, onUpdate }) => {
  return (
    <div
      className={`ui-graph-component-card${activeComponentId === component.id ? ' active' : ''}`}
      onFocusCapture={() => onActivate(component.id)}
      onPointerDownCapture={() => onActivate(component.id)}
    >
      <div className="ui-graph-component-card-title">
        <span className="ui-graph-component-card-title-main">
          <span>{formatUiComponentTypeName(component.type)}</span>
        </span>
        <button
          type="button"
          className="ui-graph-component-delete-button"
          aria-label="Delete component"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDelete}
        >
          &times;
        </button>
      </div>
      {renderComponentFields(component, project, uiGraph, onUpdate)}
    </div>
  );
};

const SortablePreviewComponentFrame: FC<RivetWebAppComponentFrameProps> = ({
  children,
  className,
  component,
  onFocusCapture,
  onPointerDownCapture,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: component.id });

  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`ui-graph-preview-sortable-row${isDragging ? ' dragging' : ''}`}
      style={style}
      onFocusCapture={onFocusCapture}
      onPointerDownCapture={onPointerDownCapture}
    >
      <button
        type="button"
        className="ui-graph-preview-drag-handle"
        title="Drag to reorder"
        aria-label={`Drag ${formatUiComponentTypeName(component.type)} component to reorder`}
        {...attributes}
        {...listeners}
      >
        ::
      </button>
      <div className="ui-graph-preview-sortable-body">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
};

function renderComponentFields(
  component: UiGraphComponent,
  project: Project,
  uiGraph: UiGraph,
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
    case 'textarea': {
      const dataKeyUsages = collectUiGraphDataKeyUsages(uiGraph);
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
            {isDataKeyAlreadyUsedEarlier(dataKeyUsages, component.stateKey, { componentId: component.id }) && (
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
    }
    case 'button': {
      const boundary = getGraphBoundary(project, component.action.graphId);
      const dataKeyUsages = collectUiGraphDataKeyUsages(uiGraph);
      return (
        <>
          <label className="ui-graph-builder-field">
            Graph to run
            <select
              value={component.action.graphId ?? ''}
              onChange={(event) =>
                onUpdate((draft) => {
                  const button = draft as typeof component;
                  const graphId = event.target.value as GraphId;
                  const nextBoundary = getGraphBoundary(project, graphId);
                  button.action.graphId = graphId;
                  normalizeButtonActionToGraphBoundary(button, nextBoundary);
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
            dataKeyUsages={dataKeyUsages}
            onUpdate={onUpdate}
          />
          <ButtonOutputMappingsEditor
            boundary={boundary}
            component={component}
            dataKeyUsages={dataKeyUsages}
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
    }
    case 'output': {
      const dataKeyOptions = getUniqueDataKeyOptions(collectUiGraphDataKeyUsages(uiGraph));
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
    }
  }
}

type ButtonComponent = Extract<UiGraphComponent, { type: 'button' }>;

type UiGraphDataKeyUsage = {
  componentId: UiComponentId;
  key: string;
  outputIndex?: number;
};

const ButtonInputMappingsEditor: FC<{
  boundary: GraphBoundary | undefined;
  component: ButtonComponent;
  dataKeyUsages: UiGraphDataKeyUsage[];
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ boundary, component, dataKeyUsages, onUpdate }) => {
  const rows = getButtonInputRows(component, boundary);
  const dataKeyOptions = getUniqueDataKeyOptions(dataKeyUsages);

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
                  const button = draft as ButtonComponent;
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
  boundary: GraphBoundary | undefined;
  component: ButtonComponent;
  dataKeyUsages: UiGraphDataKeyUsage[];
  onUpdate(updater: (component: UiGraphComponent) => void): void;
}> = ({ boundary, component, dataKeyUsages, onUpdate }) => {
  const rows = getButtonOutputRows(component, boundary);

  return (
    <div className="ui-graph-action-section">
      {boundary && rows.length === 0 && <div className="ui-graph-action-empty">The selected graph has no outputs.</div>}
      {rows.map((row, index) => (
        <div className="ui-graph-action-mapping-block" key={`output-${index}`}>
          <div className="ui-graph-action-mapping-row">
            <label className="ui-graph-builder-field">
              Graph output ID
              <input className="ui-graph-action-port-id" value={row.outputKey ?? ''} readOnly disabled title={row.outputKey} />
            </label>
            <label className="ui-graph-builder-field">
              Data key to save to
              <input
                value={row.stateKey}
                onChange={(event) =>
                  onUpdate((draft) => {
                    const button = draft as ButtonComponent;
                    const nextRows = getButtonOutputRows(button, boundary);
                    nextRows[index] = { ...nextRows[index]!, stateKey: event.target.value };
                    setButtonOutputRows(button, nextRows);
                  })
                }
              />
            </label>
          </div>
          {isDataKeyAlreadyUsedEarlier(dataKeyUsages, row.stateKey, { componentId: component.id, outputIndex: index }) && (
            <div className="ui-graph-data-key-warning">This data key is already used.</div>
          )}
        </div>
      ))}
    </div>
  );
};

function getButtonInputRows(
  component: ButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphInputBinding[] {
  const rows = getUiGraphActionInputBindings(component.action);
  if (!boundary) {
    return [];
  }

  return alignInputRowsToBoundary(boundary, rows);
}

function getButtonOutputRows(
  component: ButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphOutputBinding[] {
  const rows = getUiGraphActionOutputBindings(component.action);
  if (!boundary) {
    return [];
  }

  return alignOutputRowsToBoundary(boundary, rows);
}

function setButtonInputRows(component: ButtonComponent, rows: UiGraphInputBinding[]) {
  component.action.inputMappings = rows;
  delete component.action.inputs;
}

function setButtonOutputRows(component: ButtonComponent, rows: UiGraphOutputBinding[]) {
  const outputs = rows.map((row) => ({
    outputKey: row.outputKey || undefined,
    stateKey: row.stateKey,
  }));

  component.action.outputs = outputs;

  delete component.action.outputKey;
  delete component.action.outputStateKey;
}

function collectUiGraphDataKeyUsages(uiGraph: UiGraph): UiGraphDataKeyUsage[] {
  const usages: UiGraphDataKeyUsage[] = [];

  for (const component of uiGraph.components) {
    if ((component.type === 'input' || component.type === 'textarea') && component.stateKey) {
      usages.push({ componentId: component.id, key: component.stateKey });
    } else if (component.type === 'button') {
      getUiGraphActionOutputBindings(component.action).forEach((binding, outputIndex) => {
        if (binding.stateKey) {
          usages.push({
            componentId: component.id,
            key: binding.stateKey,
            outputIndex,
          });
        }
      });
    }
  }

  return usages;
}

function getUniqueDataKeyOptions(usages: readonly UiGraphDataKeyUsage[]): string[] {
  return Array.from(new Set(usages.map((usage) => usage.key)));
}

function isDataKeyAlreadyUsedEarlier(
  usages: readonly UiGraphDataKeyUsage[],
  key: string,
  currentUsage: { componentId: UiComponentId; outputIndex?: number },
): boolean {
  if (!key) {
    return false;
  }

  const currentIndex = usages.findIndex(
    (usage) => usage.componentId === currentUsage.componentId && usage.outputIndex === currentUsage.outputIndex,
  );
  const searchableUsages = currentIndex >= 0 ? usages.slice(0, currentIndex) : usages;

  return searchableUsages.some((usage) => usage.key === key);
}

function normalizeButtonActionToGraphBoundary(component: ButtonComponent, boundary: GraphBoundary | undefined) {
  const currentInputRows = getUiGraphActionInputBindings(component.action);
  const currentOutputRows = getUiGraphActionOutputBindings(component.action);
  const nextInputRows = boundary ? alignInputRowsToBoundary(boundary, currentInputRows) : [];
  const nextOutputRows = boundary ? alignOutputRowsToBoundary(boundary, currentOutputRows) : [];

  if (component.action.inputs || !areInputRowsEqual(currentInputRows, nextInputRows)) {
    setButtonInputRows(component, nextInputRows);
  }

  if (
    component.action.outputKey ||
    component.action.outputStateKey ||
    !areOutputRowsEqual(currentOutputRows, nextOutputRows)
  ) {
    setButtonOutputRows(component, nextOutputRows);
  }
}

function alignInputRowsToBoundary(
  boundary: GraphBoundary,
  rows: readonly UiGraphInputBinding[],
): UiGraphInputBinding[] {
  const inputIds = boundary.inputs.map((input) => input.id);

  return inputIds.map((inputId, index) => {
    const matchingRow = rows.find((row) => row.inputKey === inputId);
    const existingRow = matchingRow ?? rows[index];

    return {
      inputKey: matchingRow ? matchingRow.inputKey : inputId,
      stateKey: existingRow?.stateKey || inputId,
    };
  });
}

function alignOutputRowsToBoundary(
  boundary: GraphBoundary,
  rows: readonly UiGraphOutputBinding[],
): UiGraphOutputBinding[] {
  const outputIds = boundary.outputs.map((output) => output.id);

  return outputIds.map((outputId, index) => {
    const matchingRow = rows.find((row) => row.outputKey === outputId);
    const existingRow = matchingRow ?? rows[index];

    return {
      outputKey: matchingRow ? matchingRow.outputKey : outputId,
      stateKey: existingRow?.stateKey || outputId,
    };
  });
}

function areInputRowsEqual(left: readonly UiGraphInputBinding[], right: readonly UiGraphInputBinding[]): boolean {
  return left.length === right.length && left.every((row, index) => row.inputKey === right[index]?.inputKey && row.stateKey === right[index]?.stateKey);
}

function areOutputRowsEqual(left: readonly UiGraphOutputBinding[], right: readonly UiGraphOutputBinding[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => row.outputKey === right[index]?.outputKey && row.stateKey === right[index]?.stateKey)
  );
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
