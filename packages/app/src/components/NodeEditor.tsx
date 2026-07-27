import {
  type CSSProperties,
  type FC,
  useLayoutEffect,
  useMemo,
  type RefObject,
  useState,
  type MouseEvent,
} from 'react';
import { editingNodeState } from '../state/graphBuilder.js';
import { nodesByIdState } from '../state/graph.js';
import styled from '@emotion/styled';
import {
  createsLLMChatV2ToolResponseFormatConflictForEdit,
  LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY,
  type ChartNode,
  type DataId,
  type LLMChatV2Node,
  isNodePrefabInstanceNode,
} from '@valerypopoff/rivet2-core';
import { useUnknownNodeComponentDescriptorFor } from '../hooks/useNodeTypes.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { useHotkeys } from 'react-hotkeys-hook';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { isEqual, orderBy } from 'lodash-es';
import { ErrorBoundary } from 'react-error-boundary';
import { useSetStaticData } from '../hooks/useSetStaticData';
import { DefaultNodeEditor } from './editors/DefaultNodeEditor';
import { useAtomValue, useAtom } from 'jotai';
import { useEditNodeCommand } from '../commands/editNodeCommand';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand.js';
import { NodeEditorGlobalControls } from './nodeEditor/NodeEditorGlobalControls.js';
import { NodeEditorResizeContext } from './nodeEditor/NodeEditorResizeContext.js';
import { ResizeHandle } from './ResizeHandle.js';
import { useNodeEditorWidth } from './nodeEditor/useNodeEditorWidth.js';
import { resizeCursorStyles } from '../utils/resizeCursors.js';
import type { NodeColor } from '../utils/nodeColor.js';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import Button from '@atlaskit/button';
import { AppModalHeader } from './AppModalHeader';
import { getBuiltInNodeDocumentationUrl } from '../utils/nodeDocumentation.js';

export const NodeEditorRenderer: FC = () => {
  const nodesById = useAtomValue(nodesByIdState);
  const [editingNodeId, setEditingNodeId] = useAtom(editingNodeState);

  const deselect = useStableCallback(() => {
    setEditingNodeId(null);
  });

  const selectedNode = editingNodeId ? nodesById[editingNodeId] : undefined;

  useLayoutEffect(() => {
    if (selectedNode && isNodePrefabInstanceNode(selectedNode)) {
      deselect();
    }
  }, [deselect, selectedNode]);

  if (!editingNodeId || !selectedNode) {
    return null;
  }

  if (isNodePrefabInstanceNode(selectedNode)) {
    return null;
  }

  return (
    <ErrorBoundary key={selectedNode.id} fallback={null}>
      <NodeEditor selectedNode={selectedNode} onDeselect={deselect} />
    </ErrorBoundary>
  );
};

const Container = styled.div`
  position: absolute;
  top: calc(var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
  right: 0;
  bottom: 0;
  z-index: 210;
  width: var(--node-editor-panel-width);
  max-width: 50vw;
  min-width: min(500px, 50vw);

  .node-editor-width-resize-handle {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 14px;
    transform: translateX(-50%);
    cursor: var(--resize-edge-horizontal-cursor);
    z-index: 2;
    touch-action: none;
    background: transparent;
  }

  .node-editor-width-resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 6px;
    width: 2px;
    background: var(--primary);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .node-editor-width-resize-handle:hover::after,
  .node-editor-width-resize-handle.is-resizing::after {
    opacity: 0.65;
  }

  &[data-is-resizing='true'] .panel-container {
    backdrop-filter: none;
  }

  .panel-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    color: var(--grey-light);
    --label-color: var(--grey-light);
    --ds-text-subtlest: var(--grey-light);
    --ds-font-family-body: var(--font-family);
    --ds-font-family-heading: var(--font-family);
    --ds-font-family-code: var(--font-family-monospace);
    --label-font-family: var(--font-family);
    background-color: var(--app-panel-bg);
    backdrop-filter: blur(2px);
    font-family: var(--font-family);
    width: 100%;
    box-shadow: none;
    border-left: 1px solid var(--app-panel-border);
  }

  .panel-container input,
  .panel-container textarea,
  .panel-container button,
  .panel-container label {
    font-family: inherit;
  }

  .panel-container input::placeholder,
  .panel-container textarea::placeholder {
    color: var(--foreground-muted);
    opacity: 1;
  }

  /* Atlaskit helper text hardcodes parts of its typography, so reset it in the panel scope. */
  .panel-container [aria-live='polite'],
  .panel-container [aria-live='polite'] * {
    font-family: inherit !important;
  }

  .panel-container .labeled-toggle-helper-label,
  .panel-container .labeled-toggle-helper,
  .panel-container .labeled-toggle-helper * {
    font-size: var(--ui-font-size-sm) !important;
    line-height: 1.35;
  }

  .panel {
    display: flex;
    flex-grow: 1;
    flex-direction: column;
    padding: 16px 24px 16px;
    overflow: auto;
  }

  .section-node {
    flex: 1 0 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .section-node-content {
    flex: 1 0 auto;
    min-height: 300px;
    position: relative;
    display: flex;
  }

  .bottom-spacer {
    height: 0px;
  }

  .unknown-node {
    color: var(--primary-text);
  }

  .section-footer {
    display: flex;
    flex-shrink: 0;
    justify-content: flex-end;
    align-items: center;
    gap: 16px;
    background-color: rgba(0, 0, 0, 0.1);
    padding: 0.5em 1em 1em 1em;
    font-size: var(--ui-font-size-sm);
    color: var(--foreground-muted);

    &.has-node-doc-link {
      justify-content: space-between;
    }

    .node-doc-link,
    .node-id {
      line-height: 24px;
    }

    .node-doc-link {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      white-space: nowrap;
    }

    .node-doc-link:hover {
      color: var(--grey-light);
    }

    .node-id {
      min-width: 0;
      overflow: hidden;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
  }

  .section-global-controls {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: -16px -24px 18px;
    padding: calc(16px + var(--node-editor-action-bar-top-reserve, 0px)) 24px 18px;
    background-color: var(--black-seethrough);
  }

  .node-type-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    box-sizing: border-box;
    padding-right: var(--node-editor-action-bar-row-reserve, 0px);
    min-width: 0;
    min-height: 30px;
  }

  .node-type-action {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .data-bus-settings-actions {
    align-self: flex-start;
  }

  .node-type-tooltip {
    display: inline-flex;
    align-items: center;
  }

  .node-metadata-row {
    display: grid;
    grid-template-columns: 68px minmax(0, 1fr);
    align-items: start;
    gap: 14px;
    width: 100%;
    min-width: 0;
  }

  .node-metadata-fields {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    margin-left: -8px;
    --node-metadata-text-inset: 12px;
    --node-metadata-control-border-width: 1px;
  }

  .node-title-field,
  .node-description-field {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    justify-self: stretch;
  }

  .node-title-field {
    margin-top: 0px;
    overflow: hidden;
    font-weight: 900;
  }

  .node-description-field {
    margin-top: -4px;
  }

  .node-title-field > div,
  .node-title-field form,
  .node-title-field form > div,
  .node-title-field .node-title-read-button {
    width: 100%;
    margin: 0;
    max-width: none;
    min-width: 0;
  }

  .node-title-field label,
  .node-description-field label {
    display: none;
  }

  .node-title-field .node-title-read-button {
    height: 40px;
    min-height: 0;
    padding: 0;
    line-height: 1;
    background: transparent;
    border: 0;
    display: flex;
    align-items: stretch;
    box-sizing: border-box;
    border-radius: 4px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
    overflow: hidden;
    text-align: left;
  }

  .node-title-field .node-title-read-button .title-read-content {
    width: 100%;
    min-width: 0;
    height: 40px;
    padding: 0 var(--node-metadata-text-inset);
    font-size: var(--ui-font-size-base);
    line-height: 38px;
    box-sizing: border-box;
    color: var(--foreground);
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .node-title-field .title-read-content.is-empty,
  .node-description-field .description-read-content.is-empty {
    color: var(--foreground-muted);
  }

  .node-title-field input,
  .node-description-field textarea {
    width: 100%;
    box-sizing: border-box;
    background-color: var(--grey-darkerish);
    border: var(--node-metadata-control-border-width) solid var(--grey);
    border-radius: 4px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
    color: var(--grey-light);
  }

  .node-title-field input {
    height: 40px;
    min-height: 40px;
    padding: 0 calc(var(--node-metadata-text-inset) - var(--node-metadata-control-border-width));
    font-size: var(--ui-font-size-base);
    line-height: 38px;
  }

  .node-title-field input:focus,
  .node-description-field textarea:focus {
    outline: none;
    border-color: var(--primary);
  }

  .node-title-field .node-title-read-button:hover,
  .node-description-field [data-read-view-fit-container-width='true']:hover {
    background-color: rgba(255, 255, 255, 0.04);
  }

  .node-description-field,
  .node-description-field > form,
  .node-description-field form > div,
  .node-description-field textarea,
  .node-description-field [data-read-view-fit-container-width='true'] {
    width: 100%;
    max-width: none;
    min-width: 0;
  }

  .node-description-field form > div {
    margin: 0;
  }

  .node-description-field form > div > div {
    padding: 0;
  }

  .node-description-field [data-read-view-fit-container-width='true'] {
    display: block;
    min-height: 14px;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 4px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
    overflow: hidden;
  }

  .node-description-field button:focus + [data-read-view-fit-container-width='true'] {
    outline: 2px solid var(--primary);
    outline-offset: 0;
  }

  .node-description-field [data-read-view-fit-container-width='true'] > * {
    padding-left: 0;
    padding-right: 0;
  }

  .node-description-field .description-read-content {
    width: 100%;
    min-height: 14px;
    padding: 10px var(--node-metadata-text-inset);
    box-sizing: border-box;
    font-size: var(--ui-font-size-base);
    line-height: 1.4;
    color: var(--grey-light);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .node-description-field textarea {
    min-height: 14px;
    padding: 10px calc(var(--node-metadata-text-inset) - var(--node-metadata-control-border-width));
    font-size: var(--ui-font-size-base);
    line-height: 1.4;
  }

  .toggle-field {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    white-space: nowrap;
  }

  .toggle-field > label[data-size]:has(input:focus:not(:focus-visible)) {
    border-color: transparent !important;
    outline: none !important;
    box-shadow: none !important;
  }

  .toggle-field label {
    margin: 0;
    cursor: pointer;
  }

  .node-options-row {
    display: grid;
    grid-template-columns: minmax(0, 560px) auto;
    align-items: flex-end;
    justify-content: space-between;
    column-gap: 24px;
    min-width: 0;
    min-height: 40px;
  }

  .split-controls {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    max-width: 560px;
    min-width: 0;
    min-height: 40px;
    justify-content: flex-start;
  }

  .split-controls .segmented-editor-field,
  .split-controls .segmented-editor-control {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .split-mode-hint {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    line-height: 1.25;
    width: 100%;
    max-width: 560px;
  }

  .split-max {
    display: flex;
    align-items: center;
    gap: 8px 18px;
    flex-wrap: wrap;
    min-height: 32px;
  }

  .split-max-field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    max-width: 100%;
    min-height: 32px;
  }

  .split-max-input {
    width: 80px;
    max-width: 80px;
  }

  .split-max-label {
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .variants {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    min-width: 0;
    min-height: 40px;
    justify-self: end;
    align-self: flex-end;
  }

  .variants-tooltip {
    display: inline-flex;
  }

  .variants-button {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--ui-button-radius);
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.08);
    color: var(--grey-light);
    cursor: pointer;
    transition:
      background-color 0.15s ease-out,
      border-color 0.15s ease-out,
      color 0.15s ease-out;
  }

  .variants-button:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.2);
    color: var(--grey-lightest);
  }

  .variants-button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .variants-button svg {
    width: 18px;
    height: 18px;
  }

  .variants-inline {
    min-height: 0;
  }

  .variant-select {
    min-width: 150px;
  }

  .variant-buttons {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .variant-editor-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .variant-editor-heading {
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    font-weight: 700;
    line-height: 1.25;
  }

  .variant-editor-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    min-height: 40px;
  }

  .variant-name-input {
    width: 280px;
  }

  .node-color-picker {
    display: flex;
    align-items: center;
    width: 100%;
    margin-top: 11px;
    margin-left: 1px;
  }

  .node-color-picker .node-color-picker-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 56px;
    border: 1px solid var(--node-color-picker-trigger-border);
    border-radius: 8px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 4px;
    }
    box-sizing: border-box;
  }

  .node-color-picker .node-color-picker-swatch {
    width: 100%;
    height: 100%;
  }
`;

type NodeEditorProps = {
  selectedNode: ChartNode;
  onDeselect: () => void;
  onUpdateNode?: NodeChanged;
  onDeleteNode?: () => void;
};

export type NodeChanged = (changed: ChartNode, newData?: Record<DataId, string>) => void;

const NODE_EDITOR_ACTION_BAR_GAP_PX = 16;
const NODE_EDITOR_ACTION_BAR_VERTICAL_GAP_PX = 12;
const NODE_EDITOR_HORIZONTAL_PADDING_PX = 24;
const NODE_EDITOR_TOP_PADDING_PX = 16;

type NodeEditorActionBarAvoidance = { rowReserve: number; topReserve: number };

const NO_ACTION_BAR_AVOIDANCE: NodeEditorActionBarAvoidance = { rowReserve: 0, topReserve: 0 };

function isSameActionBarAvoidance(a: NodeEditorActionBarAvoidance, b: NodeEditorActionBarAvoidance) {
  return a.rowReserve === b.rowReserve && a.topReserve === b.topReserve;
}

function useNodeEditorActionBarAvoidance(containerRef: RefObject<HTMLDivElement | null>) {
  const [avoidance, setAvoidance] = useState<NodeEditorActionBarAvoidance>(NO_ACTION_BAR_AVOIDANCE);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const actionBar = document.querySelector<HTMLElement>('[data-node-editor-action-bar]');

    if (!container || !actionBar) {
      setAvoidance(NO_ACTION_BAR_AVOIDANCE);
      return;
    }

    let animationFrame = 0;

    const applyAvoidance = (nextAvoidance: NodeEditorActionBarAvoidance) => {
      setAvoidance((currentAvoidance) =>
        isSameActionBarAvoidance(currentAvoidance, nextAvoidance) ? currentAvoidance : nextAvoidance,
      );
    };

    const updateAvoidance = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }

      animationFrame = requestAnimationFrame(() => {
        const panelRect = container.getBoundingClientRect();
        const actionBarRect = actionBar.getBoundingClientRect();
        const overlapsPanel =
          actionBarRect.right > panelRect.left &&
          actionBarRect.left < panelRect.right &&
          actionBarRect.bottom > panelRect.top &&
          actionBarRect.top < panelRect.bottom;

        if (!overlapsPanel) {
          applyAvoidance(NO_ACTION_BAR_AVOIDANCE);
          return;
        }

        const availableBeforeActionBar =
          actionBarRect.left - panelRect.left - NODE_EDITOR_HORIZONTAL_PADDING_PX - NODE_EDITOR_ACTION_BAR_GAP_PX;
        const firstNodeTypeControl = container.querySelector<HTMLElement>('.node-type-row > *:first-child');
        const minimumInlineWidth = firstNodeTypeControl
          ? Math.ceil(firstNodeTypeControl.getBoundingClientRect().width)
          : 0;
        const shouldMoveBelowActionBar = availableBeforeActionBar < minimumInlineWidth;

        if (shouldMoveBelowActionBar) {
          applyAvoidance({
            rowReserve: 0,
            topReserve: Math.ceil(
              Math.max(
                0,
                actionBarRect.bottom -
                  panelRect.top +
                  NODE_EDITOR_ACTION_BAR_VERTICAL_GAP_PX -
                  NODE_EDITOR_TOP_PADDING_PX,
              ),
            ),
          });
          return;
        }

        const contentRight = panelRect.right - NODE_EDITOR_HORIZONTAL_PADDING_PX;

        applyAvoidance({
          rowReserve: Math.ceil(Math.max(0, contentRight - actionBarRect.left + NODE_EDITOR_ACTION_BAR_GAP_PX)),
          topReserve: 0,
        });
      });
    };

    updateAvoidance();

    const resizeObserver = new ResizeObserver(updateAvoidance);
    resizeObserver.observe(container);
    resizeObserver.observe(actionBar);
    window.addEventListener('resize', updateAvoidance);

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }

      resizeObserver.disconnect();
      window.removeEventListener('resize', updateAvoidance);
    };
  }, [containerRef]);

  return avoidance;
}

export const NodeEditor: FC<NodeEditorProps> = ({ selectedNode, onDeselect, onUpdateNode, onDeleteNode }) => {
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>();
  const [addVariantPopupOpen, setAddVariantPopupOpen] = useState(false);
  const [llmChatFeatureConflictOpen, setLlmChatFeatureConflictOpen] = useState(false);
  const { containerRef, isResizing, panelWidth, resizeHandleProps } = useNodeEditorWidth();

  const setStaticData = useSetStaticData();
  const editNode = useEditNodeCommand();
  const deleteNodes = useDeleteNodesCommand();

  const updateNode = useStableCallback((node: ChartNode, newData?: Record<DataId, string>) => {
    // Otherwise the editor "changes" and causes deleted nodes to reappear...
    if (isEqual(node, selectedNode)) {
      return;
    }

    const llmChatConflict =
      selectedNode.type === 'llmChatV2' && node.type === 'llmChatV2'
        ? createsLLMChatV2ToolResponseFormatConflictForEdit(
            selectedNode.data as LLMChatV2Node['data'],
            node.data as LLMChatV2Node['data'],
          )
        : false;

    if (llmChatConflict) {
      setLlmChatFeatureConflictOpen(true);
      return;
    }

    if (onUpdateNode) {
      onUpdateNode(node, newData);
      return;
    }

    editNode({ nodeId: node.id, newNode: node });

    if (newData) {
      setStaticData(newData);
    }
  });

  const isVariant = selectedVariant !== undefined;
  const { Editor } = useUnknownNodeComponentDescriptorFor(selectedNode);

  const selectedVariantData = useMemo(
    () => selectedNode.variants?.find(({ id }) => id === selectedVariant)?.data,
    [selectedNode.variants, selectedVariant],
  );
  const nodeForEditor = useMemo(
    () =>
      isVariant
        ? {
            ...selectedNode,
            data: selectedVariantData,
          }
        : selectedNode,
    [isVariant, selectedNode, selectedVariantData],
  );

  const handleEscape = useStableCallback(() => {
    if (llmChatFeatureConflictOpen) {
      setLlmChatFeatureConflictOpen(false);
      return;
    }

    onDeselect();
  });

  useHotkeys('esc', handleEscape, { ignoreEventWhen: (event) => event.defaultPrevented }, [handleEscape]);

  const nodeDescriptionChanged = useStableCallback((description: string) => {
    updateNode({ ...selectedNode, description });
  });

  const nodeTitleChanged = useStableCallback((title: string) => {
    updateNode({ ...selectedNode, title });
  });

  const nodeColorChanged = useStableCallback((color: NodeColor | undefined) => {
    updateNode({ ...selectedNode, visualData: { ...selectedNode.visualData, color } });
  });

  const nodeDisabledChanged = useStableCallback((disabled: boolean) => {
    updateNode({ ...selectedNode, disabled });
  });

  const deleteSelectedNode = useStableCallback(() => {
    if (onDeleteNode) {
      onDeleteNode();
      return;
    }
    deleteNodes({ nodeIds: [selectedNode.id], skipGraphInputUsageConfirm: true });
  });

  const variantOptions = useMemo(() => {
    const appliedOption = { value: '', label: '(Current)' };

    return [
      appliedOption,
      ...orderBy(selectedNode.variants?.map(({ id }) => ({ value: id, label: id })) ?? [], 'label'),
    ];
  }, [selectedNode.variants]);

  const selectedVariantOption =
    selectedVariant === undefined ? variantOptions[0] : variantOptions.find(({ value }) => value === selectedVariant);

  function handleSaveAsVariant(id: string) {
    const node = { ...selectedNode, variants: [...(selectedNode.variants ?? []), { id, data: selectedNode.data }] };
    updateNode(node);
    setSelectedVariant(id);
  }

  function handleDeleteVariant() {
    const node = {
      ...selectedNode,
      variants: selectedNode.variants?.filter(({ id }) => id !== selectedVariant),
    };
    updateNode(node);
    setSelectedVariant(undefined);
  }

  function handleApplyVariant() {
    const node = {
      ...selectedNode,
      data: selectedNode.variants?.find(({ id }) => id === selectedVariant)?.data,
    };
    updateNode(node);
    setSelectedVariant(undefined);
  }

  const selectText = (event: MouseEvent<HTMLElement>) => {
    const range = document.createRange();
    range.selectNodeContents(event.target as HTMLElement);
    const selection = window.getSelection();
    selection!.removeAllRanges();
    selection!.addRange(range);
  };

  const showGlobalControls = selectedNode.type !== 'comment';
  const projectNodeRegistry = useProjectNodeRegistry();
  const nodeDisplayName = `${projectNodeRegistry.getDynamicDisplayName(selectedNode.type)} node`;
  const nodeDocumentationUrl = getBuiltInNodeDocumentationUrl(selectedNode.type);
  const actionBarAvoidance = useNodeEditorActionBarAvoidance(containerRef);
  const containerStyle = {
    '--node-editor-panel-width': `${panelWidth}px`,
    '--node-editor-action-bar-row-reserve': `${actionBarAvoidance.rowReserve}px`,
    '--node-editor-action-bar-top-reserve': `${actionBarAvoidance.topReserve}px`,
  } as CSSProperties;

  return (
    <NodeEditorResizeContext.Provider value={isResizing}>
      <Container ref={containerRef} style={containerStyle} data-is-resizing={isResizing}>
        <ResizeHandle
          className="node-editor-width-resize-handle"
          dragCursor={resizeCursorStyles.horizontal}
          {...resizeHandleProps}
        />
        <div className="panel-container">
          <div className="panel">
            {showGlobalControls && (
              <NodeEditorGlobalControls
                node={selectedNode}
                selectedVariant={selectedVariant}
                setSelectedVariant={setSelectedVariant}
                addVariantPopupOpen={addVariantPopupOpen}
                setAddVariantPopupOpen={setAddVariantPopupOpen}
                variantOptions={variantOptions}
                selectedVariantOption={selectedVariantOption}
                onTitleChange={nodeTitleChanged}
                onDescriptionChange={nodeDescriptionChanged}
                onColorChange={nodeColorChanged}
                onDisabledChange={nodeDisabledChanged}
                onUpdateNode={updateNode}
                onApplyVariant={handleApplyVariant}
                onDeleteVariant={handleDeleteVariant}
                onSaveAsVariant={handleSaveAsVariant}
              />
            )}

            <div className="section section-node">
              <div className="section-node-content">
                {selectedNode.type === 'dataBus' ? (
                  <div className="node-type-action data-bus-settings-actions">
                    <Button appearance="danger" onClick={deleteSelectedNode}>
                      Delete Data Bus
                    </Button>
                  </div>
                ) : Editor ? (
                  <Editor node={nodeForEditor} onChange={isVariant ? () => {} : updateNode} />
                ) : (
                  <DefaultNodeEditor
                    node={nodeForEditor}
                    isReadonly={isVariant}
                    onChange={isVariant ? () => {} : updateNode}
                    onClose={onDeselect}
                  />
                )}
              </div>
              <div className="bottom-spacer" />
            </div>
          </div>
          <div className={`section section-footer${nodeDocumentationUrl ? ' has-node-doc-link' : ''}`}>
            {nodeDocumentationUrl && (
              <a className="node-doc-link" href={nodeDocumentationUrl} target="_blank" rel="noreferrer">
                Node documentation
              </a>
            )}
            <span className="node-id" onClick={selectText}>
              {`${nodeDisplayName}, ${selectedNode.id}`}
            </span>
          </div>
        </div>
        <LLMChatFeatureConflictModal
          isOpen={llmChatFeatureConflictOpen}
          onClose={() => setLlmChatFeatureConflictOpen(false)}
        />
      </Container>
    </NodeEditorResizeContext.Provider>
  );
};

const LLMChatFeatureConflictModal: FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  return (
    <ModalTransition>
      {isOpen && (
        <Modal autoFocus={false} onClose={onClose} width="small">
          <AppModalHeader title={LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.title} />
          <ModalBody>
            {LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </ModalBody>
          <ModalFooter>
            <Button appearance="primary" onClick={onClose}>
              OK
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
