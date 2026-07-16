import { css } from '@emotion/react';
import { type CSSProperties, type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { arrayMove } from '@dnd-kit/sortable';
import BrowserIcon from 'majesticons/line/browser-line.svg?react';
import {
  getGraphBoundary,
  initializeUiGraphChatActionBindings,
  type UiComponentId,
  type UiGraphComponent,
} from '@valerypopoff/rivet2-core';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { leftSidebarLiveWidthState } from '../state/ui.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useGlobalHotkey } from '../hooks/useGlobalHotkey.js';
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
import {
  getCurrentUiGraphComponentDeletionIds,
  type PendingUiGraphComponentDeletion,
} from './uiGraphBuilder/componentDeletion.js';
import {
  initializeButtonActionToGraphBoundary,
  normalizeButtonActionToGraphBoundary,
} from './uiGraphBuilder/buttonBindings.js';
import { UiGraphComponentEditor } from './uiGraphBuilder/UiGraphComponentEditor.js';
import { UiGraphPreviewEditor } from './uiGraphBuilder/UiGraphPreviewEditor.js';
import { canRunDesktopWebAppPreview } from './uiGraphBuilder/uiGraphBuilderPolicy.js';
import { useUiGraphMutations } from './uiGraphBuilder/useUiGraphMutations.js';
import { collectUiGraphDataKeyUsages } from './uiGraphBuilder/dataKeys.js';
import { useProjectWorkspaceTarget } from '../hooks/useProjectWorkspaceTarget.js';
import { DeleteResourceConfirmModal } from './DeleteResourceConfirmModal.js';
import { isUiGraphComponentEventTarget, revealUiGraphComponent } from './uiGraphBuilder/revealUiGraphComponent.js';
import { getUiGraphPreviewInteractionController } from './rivetWebApps/uiGraphPreviewSession.js';
import { selectUiGraphComponent, type UiGraphComponentSelectionMode } from './uiGraphBuilder/componentSelection.js';
import { isMacOSPlatform } from '../utils/platform/os.js';

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

  .ui-graph-builder-button:disabled {
    cursor: default;
    opacity: 0.5;
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
  .ui-graph-builder-field > textarea,
  .ui-graph-data-key-input > input {
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

  .ui-graph-data-key-input {
    position: relative;
  }

  .ui-graph-data-key-input > input {
    width: 100%;
    padding-right: 34px;
  }

  .ui-graph-data-key-warning-tooltip {
    position: absolute;
    top: 50%;
    right: 9px;
    display: inline-flex;
    color: var(--warning);
    cursor: help;
    transform: translateY(-50%);
  }

  .ui-graph-data-key-warning-icon {
    width: 16px;
    height: 16px;
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

  .ui-graph-preview-sortable-row[data-rivet-web-app-component-type='chat'] {
    display: flex;
    flex: 1 0 var(--rivet-web-app-chat-min-height);
    min-height: var(--rivet-web-app-chat-min-height);
  }

  .ui-graph-preview-sortable-row.dragging {
    opacity: 0.68;
    z-index: 1;
  }

  .ui-graph-preview-sortable-body {
    min-width: 0;
  }

  .ui-graph-preview-sortable-row[data-rivet-web-app-component-type='chat'] .ui-graph-preview-sortable-body,
  .ui-graph-preview-sortable-row[data-rivet-web-app-component-type='chat'] .rivet-web-app-component-frame {
    display: flex;
    flex: 1;
    min-height: 0;
    width: 100%;
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

  .ui-graph-chat-input-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px;
    gap: 8px;
    align-items: end;
  }

  .ui-graph-chat-input-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 34px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--foreground-muted);
    cursor: pointer;
    padding: 5px;
  }

  .ui-graph-chat-input-remove:hover,
  .ui-graph-chat-input-remove:focus-visible {
    color: var(--error);
  }

  .ui-graph-chat-input-remove:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  .ui-graph-chat-input-remove svg {
    width: 18px;
    height: 18px;
  }

  .ui-graph-chat-add-input {
    justify-self: start;
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

  .ui-graph-preview-selection-rectangle {
    position: fixed;
    z-index: 2;
    pointer-events: none;
    border: 2px dashed var(--primary);
    background: var(--primary-5percent);
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
  const [selectedComponentIds, setSelectedComponentIds] = useState<UiComponentId[]>([]);
  const [pendingComponentDeletion, setPendingComponentDeletion] = useState<
    PendingUiGraphComponentDeletion | undefined
  >();
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const uiGraph = selectedUiGraphId ? project.uiGraphs?.[selectedUiGraphId] : undefined;
  const previewInteractionController = uiGraph
    ? getUiGraphPreviewInteractionController(project.metadata.id, uiGraph)
    : undefined;
  const dataKeyUsages = useMemo(() => (uiGraph ? collectUiGraphDataKeyUsages(uiGraph) : []), [uiGraph]);
  const selectedComponentIdSet = useMemo(() => new Set(selectedComponentIds), [selectedComponentIds]);
  const pendingDeleteComponentIds = getCurrentUiGraphComponentDeletionIds(
    pendingComponentDeletion,
    project.metadata.id,
    uiGraph,
  );

  useEffect(() => {
    setSelectedComponentIds([]);
    setPendingComponentDeletion(undefined);
  }, [project.metadata.id, selectedUiGraphId]);

  const addComponent = useStableCallback((type: UiGraphComponent['type']) => {
    updateUiGraph((draft) => {
      const boundary = getGraphBoundary(project, project.metadata.mainGraphId);
      const component = createUiGraphComponent(type, boundary ? project.metadata.mainGraphId : undefined);
      if (component.type === 'button') {
        initializeButtonActionToGraphBoundary(component, boundary);
      } else if (component.type === 'chat') {
        component.action = initializeUiGraphChatActionBindings(component.action, boundary);
      }

      draft.components.push(component);
    });
  });

  const confirmDeleteComponent = useStableCallback(() => {
    const componentIds = getCurrentUiGraphComponentDeletionIds(pendingComponentDeletion, project.metadata.id, uiGraph);
    if (componentIds.length === 0) {
      setPendingComponentDeletion(undefined);
      return;
    }

    setPendingComponentDeletion(undefined);
    const deletedComponentIds = new Set(componentIds);
    setSelectedComponentIds((selectedIds) =>
      selectedIds.filter((componentId) => !deletedComponentIds.has(componentId)),
    );
    updateUiGraph((draft) => {
      draft.components = draft.components.filter((component) => !deletedComponentIds.has(component.id));
    });
  });

  const requestDeleteComponents = useStableCallback((componentIds: readonly UiComponentId[]) => {
    if (!uiGraph) {
      return;
    }

    const existingComponentIds = new Set(uiGraph.components.map((component) => component.id));
    const idsToDelete = [...new Set(componentIds)].filter((componentId) => existingComponentIds.has(componentId));
    if (idsToDelete.length > 0) {
      setPendingComponentDeletion({ componentIds: idsToDelete, projectId: project.metadata.id, uiGraphId: uiGraph.id });
    }
  });

  const requestDeleteSelectedComponents = useStableCallback(() => requestDeleteComponents(selectedComponentIds));

  const reorderComponents = useStableCallback((draggedComponentId: UiComponentId, targetComponentId: UiComponentId) => {
    updateUiGraph((draft) => {
      const fromIndex = draft.components.findIndex((component) => component.id === draggedComponentId);
      const toIndex = draft.components.findIndex((component) => component.id === targetComponentId);

      if (fromIndex >= 0 && toIndex >= 0) {
        draft.components = arrayMove(draft.components, fromIndex, toIndex);
      }
    });
  });

  const selectComponent = useStableCallback(
    (
      componentId: UiComponentId,
      mode: UiGraphComponentSelectionMode,
      counterpartScrollContainer: HTMLElement | null,
    ) => {
      const wasSelected = selectedComponentIdSet.has(componentId);
      setSelectedComponentIds((selectedIds) => selectUiGraphComponent(selectedIds, componentId, mode));
      if (mode === 'replace' || !wasSelected) {
        revealUiGraphComponent(counterpartScrollContainer, componentId);
      }
    },
  );
  const activateSettingsComponent = useStableCallback((componentId: UiComponentId) =>
    selectComponent(componentId, 'replace', previewScrollRef.current),
  );
  const selectPreviewComponent = useStableCallback((componentId: UiComponentId, mode: UiGraphComponentSelectionMode) =>
    selectComponent(componentId, mode, settingsScrollRef.current),
  );
  const setPreviewComponentSelection = useStableCallback((componentIds: readonly UiComponentId[]) => {
    setSelectedComponentIds((selectedIds) =>
      selectedIds.length === componentIds.length &&
      selectedIds.every((componentId) => componentIds.includes(componentId))
        ? selectedIds
        : [...componentIds],
    );
  });

  const supportsBackspaceDeleteHotkey = isMacOSPlatform();
  const deleteSelectedComponentsFromHotkey = useStableCallback((event: KeyboardEvent) => {
    if (event.repeat || pendingComponentDeletion || selectedComponentIds.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    requestDeleteSelectedComponents();
  });

  useGlobalHotkey('Delete', deleteSelectedComponentsFromHotkey, { notWhenInputFocused: true });
  useGlobalHotkey(
    'Backspace',
    (event) => {
      if (supportsBackspaceDeleteHotkey) {
        deleteSelectedComponentsFromHotkey(event);
      }
    },
    { notWhenInputFocused: true },
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
    const actionAbortControllers = new Map<string, AbortController>();
    let previewWindow: Awaited<ReturnType<typeof createWebviewWindowHandle>> | undefined;
    let unlistenClose: (() => unknown) | undefined;
    let cleaned = false;

    const cleanup = (options: { closeWindow?: boolean } = {}) => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      for (const abortController of actionAbortControllers.values()) {
        abortController.abort();
      }
      actionAbortControllers.clear();
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
      if (event.data.type === 'requestPayload') {
        channel.postMessage({
          payload: { uiGraph },
          requestId: event.data.requestId,
          type: 'previewPayload',
        } satisfies PreviewActionResponse);
        return;
      }

      if (event.data.type === 'cancelAction') {
        actionAbortControllers.get(event.data.requestId)?.abort();
        return;
      }

      const abortController = new AbortController();
      actionAbortControllers.set(event.data.requestId, abortController);
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

        const result = await runUiGraphAction(
          uiGraph,
          event.data.componentId,
          event.data.state,
          abortController.signal,
          (progress) => {
            if (!cleaned) {
              channel.postMessage({
                progress,
                requestId: event.data.requestId,
                type: 'actionProgress',
              } satisfies PreviewActionResponse);
            }
          },
        );
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
      } finally {
        actionAbortControllers.delete(event.data.requestId);
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
    <div
      css={styles}
      style={getUiGraphBuilderStyle(sidebarOpen, leftSidebarWidth)}
      onPointerDownCapture={(event) => {
        if (!event.shiftKey && !isUiGraphComponentEventTarget(event.target)) {
          setSelectedComponentIds([]);
        }
      }}
    >
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
                component={component}
                dataKeyUsages={dataKeyUsages}
                project={project}
                onActivate={activateSettingsComponent}
                onDelete={() => requestDeleteComponents([component.id])}
                onUpdate={(updater) => updateComponent(component.id, updater)}
                selectedComponentIds={selectedComponentIdSet}
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
          key={`${project.metadata.id}:${uiGraph.id}`}
          interactionController={previewInteractionController}
          onComponentSelectionChange={selectPreviewComponent}
          onComponentSelectionSetChange={setPreviewComponentSelection}
          onReorder={reorderComponents}
          scrollContainerRef={previewScrollRef}
          selectedComponentIds={selectedComponentIdSet}
          uiGraph={uiGraph}
          onRunAction={(componentId, state, abortSignal, onProgress) =>
            runUiGraphAction(uiGraph, componentId, state, abortSignal, onProgress)
          }
        />
      </section>
      <DeleteResourceConfirmModal
        isOpen={pendingDeleteComponentIds.length > 0}
        resourceName={
          pendingDeleteComponentIds.length === 1
            ? 'this component'
            : `these ${pendingDeleteComponentIds.length} components`
        }
        title={
          pendingDeleteComponentIds.length === 1
            ? 'Delete Component?'
            : `Delete ${pendingDeleteComponentIds.length} Components?`
        }
        onClose={() => setPendingComponentDeletion(undefined)}
        onConfirm={confirmDeleteComponent}
      />
    </div>
  );
};

function getUiGraphBuilderStyle(sidebarOpen: boolean, leftSidebarWidth: number): CSSProperties {
  return {
    '--ui-graph-left-offset': sidebarOpen ? `${leftSidebarWidth}px` : '0px',
  } as CSSProperties;
}
