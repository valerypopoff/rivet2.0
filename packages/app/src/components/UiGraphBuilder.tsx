import { css } from '@emotion/react';
import { type CSSProperties, type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { arrayMove } from '@dnd-kit/sortable';
import BrowserIcon from 'majesticons/line/browser-line.svg?react';
import { getGraphBoundary, type UiComponentId, type UiGraphComponent } from '@valerypopoff/rivet2-core';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
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
import { useRunUiGraphAction } from '../hooks/useRunUiGraphAction.js';
import type { EditorGraphRun } from '../hooks/editorGraphRunOptions.js';
import { createUiGraphComponent, UI_GRAPH_COMPONENT_PALETTE } from './uiGraphBuilder/componentDescriptors.js';
import { normalizeButtonActionToGraphBoundary } from './uiGraphBuilder/buttonBindings.js';
import { UiGraphComponentEditor } from './uiGraphBuilder/UiGraphComponentEditor.js';
import { UiGraphPreviewEditor } from './uiGraphBuilder/UiGraphPreviewEditor.js';
import { canRunDesktopWebAppPreview } from './uiGraphBuilder/uiGraphBuilderPolicy.js';
import { useUiGraphMutations } from './uiGraphBuilder/useUiGraphMutations.js';
import { collectUiGraphDataKeyUsages } from './uiGraphBuilder/dataKeys.js';
import { useProjectWorkspaceTarget } from '../hooks/useProjectWorkspaceTarget.js';
import { revealUiGraphComponent } from './uiGraphBuilder/revealUiGraphComponent.js';

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

  .ui-graph-builder-field > input,
  .ui-graph-builder-field > textarea {
    min-width: 0;
    border: 1px solid var(--form-control-border);
    border-radius: 7px;
    background: var(--form-control-bg);
    color: var(--foreground);
    font: inherit;
    font-weight: 400;
    padding: 8px 10px;
  }

  .ui-graph-builder-field > textarea {
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

  .ui-graph-component-delete-icon {
    display: block;
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    color: var(--foreground-muted);
    cursor: pointer;
    outline: none;
  }

  .ui-graph-component-delete-icon:hover,
  .ui-graph-component-delete-icon:focus-visible {
    color: var(--error);
  }

  .ui-graph-component-delete-icon:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
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
  const project = useAtomValue(projectState);
  const store = useStore();
  const workspaceTarget = useProjectWorkspaceTarget();
  const selectedUiGraphId = workspaceTarget?.type === 'uiGraph' ? workspaceTarget.uiGraphId : undefined;
  const { updateComponent, updateUiGraph } = useUiGraphMutations(selectedUiGraphId);
  const runUiGraphAction = useRunUiGraphAction(runGraph);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const hostUiConfig = useRivetAppHostUiConfig();
  const canRunDesktopPreview = canRunDesktopWebAppPreview(hostUiConfig);
  const [activeComponentId, setActiveComponentId] = useState<UiComponentId | undefined>();
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const uiGraph = selectedUiGraphId ? project.uiGraphs?.[selectedUiGraphId] : undefined;
  const dataKeyUsages = useMemo(() => (uiGraph ? collectUiGraphDataKeyUsages(uiGraph) : []), [uiGraph]);

  useEffect(() => {
    setActiveComponentId(undefined);
  }, [selectedUiGraphId]);

  const addComponent = useStableCallback((type: UiGraphComponent['type']) => {
    updateUiGraph((draft) => {
      const component = createUiGraphComponent(type, project.metadata.mainGraphId);
      if (component.type === 'button') {
        normalizeButtonActionToGraphBoundary(component, getGraphBoundary(project, component.action.graphId));
      }

      draft.components.push(component);
    });
  });

  const deleteComponent = useStableCallback((componentId: UiComponentId) => {
    if (!window.confirm('Are you sure you want to delete this component?')) {
      return;
    }

    setActiveComponentId((activeComponentId) => (activeComponentId === componentId ? undefined : activeComponentId));
    updateUiGraph((draft) => {
      draft.components = draft.components.filter((component) => component.id !== componentId);
    });
  });

  const reorderComponents = useStableCallback((draggedComponentId: UiComponentId, targetComponentId: UiComponentId) => {
    updateUiGraph((draft) => {
      const fromIndex = draft.components.findIndex((component) => component.id === draggedComponentId);
      const toIndex = draft.components.findIndex((component) => component.id === targetComponentId);

      if (fromIndex >= 0 && toIndex >= 0) {
        draft.components = arrayMove(draft.components, fromIndex, toIndex);
      }
    });
  });

  const activateComponent = useStableCallback(
    (componentId: UiComponentId, counterpartScrollContainer: HTMLElement | null) => {
      setActiveComponentId(componentId);
      revealUiGraphComponent(counterpartScrollContainer, componentId);
    },
  );
  const activateSettingsComponent = useStableCallback((componentId: UiComponentId) =>
    activateComponent(componentId, previewScrollRef.current),
  );
  const activatePreviewComponent = useStableCallback((componentId: UiComponentId) =>
    activateComponent(componentId, settingsScrollRef.current),
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
        <div ref={settingsScrollRef} className="ui-graph-builder-scroll">
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
              {UI_GRAPH_COMPONENT_PALETTE.map(({ label, type }) => (
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
              <UiGraphComponentEditor
                key={component.id}
                activeComponentId={activeComponentId}
                component={component}
                dataKeyUsages={dataKeyUsages}
                project={project}
                onActivate={activateSettingsComponent}
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
        <UiGraphPreviewEditor
          activeComponentId={activeComponentId}
          onActiveComponentChange={activatePreviewComponent}
          onReorder={reorderComponents}
          scrollContainerRef={previewScrollRef}
          uiGraph={uiGraph}
          onRunAction={(componentId, state) => runUiGraphAction(uiGraph, componentId, state)}
        />
      </section>
    </div>
  );
};

function getUiGraphBuilderStyle(sidebarOpen: boolean, leftSidebarWidth: number): CSSProperties {
  return {
    '--ui-graph-left-offset': sidebarOpen ? `${leftSidebarWidth}px` : '0px',
  } as CSSProperties;
}
