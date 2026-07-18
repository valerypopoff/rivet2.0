import { css } from '@emotion/react';
import { type CSSProperties, type FC, useMemo } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { DndContext, DragOverlay, useDraggable } from '@dnd-kit/core';
import BrowserIcon from 'majesticons/line/browser-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import type { UiGraphComponent } from '@valerypopoff/rivet2-core';
import { applyUiGraphWebAppStoragePatch, loadUiGraphWebAppStorage } from '@valerypopoff/rivet2-core/web-app-runtime';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { leftSidebarLiveWidthState } from '../state/ui.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { createWebviewWindowHandle } from '../utils/platform/window.js';
import {
  clearRivetWebAppPreviewPayload,
  createRivetWebAppPreviewUrl,
  type PreviewActionRequest,
  type PreviewActionResponse,
  RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX,
  writeRivetWebAppPreviewPayload,
} from './rivetWebApps/RivetWebAppPreviewWindow.js';
import { useRunUiGraphAction } from '../hooks/useRunUiGraphAction.js';
import type { EditorGraphRun } from '../hooks/editorGraphRunOptions.js';
import { getUiGraphComponentLabel, UI_GRAPH_COMPONENT_PALETTE_GROUPS } from './uiGraphBuilder/componentDescriptors.js';
import { UiGraphComponentEditor } from './uiGraphBuilder/UiGraphComponentEditor.js';
import { UiGraphPreviewEditor } from './uiGraphBuilder/UiGraphPreviewEditor.js';
import { canRunDesktopWebAppPreview } from './uiGraphBuilder/uiGraphBuilderPolicy.js';
import { useUiGraphMutations } from './uiGraphBuilder/useUiGraphMutations.js';
import { collectUiGraphDataKeyUsages } from './uiGraphBuilder/dataKeys.js';
import { useProjectWorkspaceTarget } from '../hooks/useProjectWorkspaceTarget.js';
import { DeleteResourceConfirmModal } from './DeleteResourceConfirmModal.js';
import { getUiGraphPreviewInteractionController } from './rivetWebApps/uiGraphPreviewSession.js';
import {
  UI_GRAPH_PALETTE_DRAG_PREFIX,
  uiGraphBuilderCollisionDetection,
  useUiGraphBuilderController,
} from './uiGraphBuilder/useUiGraphBuilderController.js';

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
    gap: 6px;
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
    overflow: hidden;
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--modal-surface-bg) 88%, var(--foreground) 4%);
  }

  .ui-graph-builder-palette-title {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    font-weight: 800;
    padding: 11px 12px;
  }

  .ui-graph-builder-palette-group {
    display: grid;
    gap: 8px;
    border-top: 1px solid var(--foldable-section-border);
    padding: 10px 12px;
  }

  .ui-graph-builder-palette-group-title {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
  }

  .ui-graph-builder-settings-action-button {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    width: fit-content;
    height: calc(32px * var(--ui-font-scale, 1));
    margin: 0;
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--grey-dark-colorish);
    color: var(--foreground);
    cursor: pointer;
    gap: 0.5rem;
    font: inherit;
    font-family: var(--font-family, Inter, system-ui, sans-serif);
    font-size: var(--ui-font-size-base);
    padding: 0.5rem 1rem;
    corner-shape: squircle;
  }

  .ui-graph-builder-settings-action-button:hover,
  .ui-graph-builder-settings-action-button:focus-visible {
    background: color-mix(in srgb, var(--grey-dark-colorish) 84%, var(--foreground) 12%);
    outline: none;
  }

  .ui-graph-builder-settings-action-button svg {
    flex: 0 0 auto;
    width: 1.15em;
    height: 1.15em;
  }

  .ui-graph-builder-palette-add-button {
    position: relative;
    padding-right: 34px;
    text-align: left;
  }

  .ui-graph-builder-add-arrow {
    position: absolute;
    right: 8px;
    width: 14px;
    height: 14px;
    color: var(--foreground);
    opacity: 0;
  }

  .ui-graph-builder-palette-add-button:hover .ui-graph-builder-add-arrow,
  .ui-graph-builder-palette-add-button:focus-visible .ui-graph-builder-add-arrow {
    opacity: 1;
  }

  .ui-graph-builder-palette-add-button.dragging {
    opacity: 0.45;
  }

  .ui-graph-builder-palette-drag-overlay {
    border: 1px solid color-mix(in srgb, var(--foreground) 30%, transparent);
    border-radius: var(--ui-button-radius);
    background: color-mix(in srgb, var(--modal-surface-bg) 72%, var(--foreground) 18%);
    box-shadow: 0 8px 20px color-mix(in srgb, #000 32%, transparent);
    color: var(--foreground);
    font-weight: 600;
    padding: 5px 10px;
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

  .ui-graph-dropdown-items {
    display: grid;
    gap: 8px;
  }

  .ui-graph-dropdown-item-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px;
    gap: 8px;
    align-items: end;
  }

  .ui-graph-chat-input-remove,
  .ui-graph-dropdown-item-remove {
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

  .ui-graph-chat-add-input,
  .ui-graph-dropdown-add-item {
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

  .ui-graph-preview-drop-surface {
    position: absolute;
    inset: 0;
    display: flex;
    min-height: 0;
  }

  .ui-graph-preview-drop-surface > .rivet-web-app-root {
    flex: 1;
    min-height: 0;
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

  .ui-graph-preview-sortable-row.palette-placeholder {
    pointer-events: none;
  }

  .ui-graph-preview-palette-placeholder-content {
    display: contents;
    visibility: hidden;
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
  const uiGraph = selectedUiGraphId ? project.uiGraphs?.[selectedUiGraphId] : undefined;
  const previewInteractionController = uiGraph
    ? getUiGraphPreviewInteractionController(project.metadata.id, uiGraph)
    : undefined;
  const dataKeyUsages = useMemo(() => (uiGraph ? collectUiGraphDataKeyUsages(uiGraph) : []), [uiGraph]);
  const builderController = useUiGraphBuilderController({ project, uiGraph, updateUiGraph });
  const {
    activePaletteComponent,
    activateSettingsComponent,
    addComponent,
    clearPaletteDrag,
    clearSelectionFromPointer,
    closeDeleteConfirmation,
    confirmDeleteComponents,
    dragSensors,
    handleComponentDragEnd,
    handleComponentDragOver,
    handleComponentDragStart,
    paletteInsertionIndex,
    pendingDeleteComponentIds,
    previewScrollRef,
    requestDeleteComponents,
    selectPreviewComponent,
    selectedComponentIdSet,
    setPreviewComponentSelection,
    settingsScrollRef,
  } = builderController;

  const openPreviewWindow = useStableCallback(async () => {
    if (!uiGraph) {
      return;
    }

    const token = crypto.randomUUID();
    const previewProjectId = project.metadata.id;
    writeRivetWebAppPreviewPayload(token, { storage: loadUiGraphWebAppStorage(uiGraph), uiGraph });
    const channel = new BroadcastChannel(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`);
    const actionAbortControllers = new Map<string, AbortController>();
    const storageActionState = { appliedActionByKey: new Map<string, number>(), nextAction: 0 };
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
      clearRivetWebAppPreviewPayload(token);
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
          payload: { storage: loadUiGraphWebAppStorage(uiGraph), uiGraph },
          requestId: event.data.requestId,
          type: 'previewPayload',
        } satisfies PreviewActionResponse);
        return;
      }

      if (event.data.type === 'cancelAction') {
        actionAbortControllers.get(event.data.requestId)?.abort();
        return;
      }

      const storageActionNumber = ++storageActionState.nextAction;
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
          loadUiGraphWebAppStorage(uiGraph),
        );
        if (cleaned) {
          return;
        }

        const applicableStoragePatch = result.storagePatch
          ? Object.fromEntries(
              Object.entries(result.storagePatch).filter(([key]) => {
                const latestAppliedAction = storageActionState.appliedActionByKey.get(key) ?? 0;
                if (storageActionNumber < latestAppliedAction) return false;
                storageActionState.appliedActionByKey.set(key, storageActionNumber);
                return true;
              }),
            )
          : undefined;
        if (applicableStoragePatch && Object.keys(applicableStoragePatch).length > 0) {
          applyUiGraphWebAppStoragePatch(uiGraph, loadUiGraphWebAppStorage(uiGraph), applicableStoragePatch);
        }

        channel.postMessage({
          requestId: event.data.requestId,
          result: { ...result, storagePatch: applicableStoragePatch },
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
      onPointerDownCapture={clearSelectionFromPointer}
    >
      <DndContext
        sensors={dragSensors}
        collisionDetection={uiGraphBuilderCollisionDetection}
        onDragCancel={clearPaletteDrag}
        onDragEnd={handleComponentDragEnd}
        onDragOver={handleComponentDragOver}
        onDragStart={handleComponentDragStart}
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
              {UI_GRAPH_COMPONENT_PALETTE_GROUPS.map((group) => (
                <section key={group.label} className="ui-graph-builder-palette-group" aria-label={group.label}>
                  <div className="ui-graph-builder-palette-group-title">{group.label}</div>
                  <div className="ui-graph-builder-add">
                    {group.types.map((type) => {
                      const label = getUiGraphComponentLabel(type);
                      return (
                        <PaletteComponentButton
                          key={type}
                          label={label}
                          componentType={type}
                          onClick={() => addComponent(type)}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
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
            paletteComponent={activePaletteComponent}
            paletteInsertionIndex={activePaletteComponent ? paletteInsertionIndex : undefined}
            scrollContainerRef={previewScrollRef}
            selectedComponentIds={selectedComponentIdSet}
            uiGraph={uiGraph}
            onRunAction={(componentId, state, abortSignal, onProgress, storage) =>
              runUiGraphAction(uiGraph, componentId, state, abortSignal, onProgress, storage)
            }
          />
        </section>
        <DragOverlay dropAnimation={null}>
          {activePaletteComponent ? (
            <div className="ui-graph-builder-palette-drag-overlay">
              {getUiGraphComponentLabel(activePaletteComponent.type)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
        onClose={closeDeleteConfirmation}
        onConfirm={confirmDeleteComponents}
      />
    </div>
  );
};

function getUiGraphBuilderStyle(sidebarOpen: boolean, leftSidebarWidth: number): CSSProperties {
  return {
    '--ui-graph-left-offset': sidebarOpen ? `${leftSidebarWidth}px` : '0px',
  } as CSSProperties;
}

const PaletteComponentButton: FC<{
  componentType: UiGraphComponent['type'];
  label: string;
  onClick(): void;
}> = ({ componentType, label, onClick }) => {
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    data: { componentType },
    id: `${UI_GRAPH_PALETTE_DRAG_PREFIX}${componentType}`,
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`ui-graph-builder-settings-action-button ui-graph-builder-palette-add-button${isDragging ? ' dragging' : ''}`}
      title="Drag into the preview to insert between components"
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <span>{label}</span>
      <ChevronRightIcon className="ui-graph-builder-add-arrow" aria-hidden="true" />
    </button>
  );
};
