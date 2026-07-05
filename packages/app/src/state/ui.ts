import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { GraphId, NodeId, ProjectId } from '@valerypopoff/rivet2-core';
import { createHybridStorage } from './storage.js';
import { DEFAULT_MULTILINE_EDITOR_FONT_SIZE } from '../utils/multilineEditorFontSize.js';
import { DEFAULT_UI_FONT_SIZE } from '../utils/uiFontSize.js';
import { DEFAULT_LEFT_SIDEBAR_WIDTH } from '../utils/leftSidebarWidth.js';
import type { ConnectedGraphInputUsage } from '../domain/graphEditing/graphInputUsage.js';
import { DEFAULT_HORIZONTAL_MODAL_BOUNDS, type HorizontalModalBounds } from '../utils/fullScreenModalBounds.js';
import type { NodeEditorGroupOpenState } from '../utils/nodeEditorGroupState.js';

const { storage } = createHybridStorage('ui');

export const debuggerPanelOpenState = atom<boolean>(false);

export type DebuggerPanelAnchor = {
  bottom: number;
  right: number;
};

export const debuggerPanelAnchorState = atom<DebuggerPanelAnchor | undefined>(undefined);

export type OverlayKey = 'promptDesigner' | 'trivet' | 'chatViewer' | 'dataStudio';

export const overlayOpenState = atom<OverlayKey | undefined>(undefined);

export const newProjectModalOpenState = atom<boolean>(false);

export type DeleteGraphInputConfirmState = {
  nodeIds: NodeId[];
  usages: ConnectedGraphInputUsage[];
};

export const deleteGraphInputConfirmState = atom<DeleteGraphInputConfirmState | null>(null);

export type SubGraphPortRearrangeTarget = {
  graphId: GraphId;
  nodeId: NodeId;
  projectId: ProjectId;
};

export const subGraphPortRearrangeTargetState = atom<SubGraphPortRearrangeTarget | undefined>(undefined);

export type VariadicPortRearrangeTarget = {
  graphId: GraphId;
  nodeId: NodeId;
  projectId: ProjectId;
};

export const variadicPortRearrangeTargetState = atom<VariadicPortRearrangeTarget | undefined>(undefined);

export const expandedFoldersState = atomWithStorage<Record<string, boolean>>('expandedFoldersState', {}, storage);

export const showUnreachableGraphTagsState = atomWithStorage<boolean>('showUnreachableGraphTagsState', true, storage);

export const showGraphReferenceIndicatorsState = atomWithStorage<boolean>(
  'showGraphReferenceIndicatorsState',
  true,
  storage,
);

// Keep the storage key stable so existing saved viewport heights still load.
export const codeEditorHeightsByStorageKeyState = atomWithStorage<Record<string, number>>(
  'codeEditorHeightsByNodeTypeState',
  {},
  storage,
);

export const nodeEditorWidthState = atomWithStorage<number | null>('nodeEditorWidthState', null, storage);

export const nodeEditorGroupOpenState = atomWithStorage<NodeEditorGroupOpenState>(
  'nodeEditorGroupOpenState',
  {},
  storage,
);

export type ProjectSettingsSectionOpenState = Record<string, boolean>;

export const projectSettingsSectionOpenState = atomWithStorage<ProjectSettingsSectionOpenState>(
  'projectSettingsSectionOpenState',
  {},
  storage,
);

export const fullscreenOutputModalBoundsState = atomWithStorage<HorizontalModalBounds>(
  'fullscreenOutputModalBoundsState',
  DEFAULT_HORIZONTAL_MODAL_BOUNDS,
  storage,
);

export const DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH = 420;
export const MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH = 260;
export const MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH = 800;
export const DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 280;
export const MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 120;
export const MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT = 720;

export const jsonStringPreviewPopoverWidthState = atomWithStorage<number>(
  'jsonStringPreviewPopoverWidthState',
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  storage,
);

export const jsonStringPreviewPopoverMaxHeightState = atomWithStorage<number>(
  'jsonStringPreviewPopoverMaxHeightState',
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  storage,
);

export const graphSearchPanelHeightState = atomWithStorage<number>('graphSearchPanelHeightState', 420, storage);

export const leftSidebarWidthState = atomWithStorage<number>(
  'leftSidebarWidthState',
  DEFAULT_LEFT_SIDEBAR_WIDTH,
  storage,
);

export const leftSidebarLiveWidthState = atom<number>(DEFAULT_LEFT_SIDEBAR_WIDTH);

export const uiFontSizeState = atomWithStorage<number>('uiFontSizeState', DEFAULT_UI_FONT_SIZE, storage);

export const multilineEditorFontSizeState = atomWithStorage<number>(
  'multilineEditorFontSizeState',
  DEFAULT_MULTILINE_EDITOR_FONT_SIZE,
  storage,
);

export const helpModalOpenState = atom<boolean>(false);
