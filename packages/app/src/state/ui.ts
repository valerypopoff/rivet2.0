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
import {
  DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
  type RunActivityColumnWidths,
} from '../features/runActivity/runActivityColumnWidths.js';

const { storage } = createHybridStorage('ui');

export const debuggerPanelOpenState = atom<boolean>(false);

export type DebuggerPanelAnchor = {
  bottom: number;
  right: number;
};

export const debuggerPanelAnchorState = atom<DebuggerPanelAnchor | undefined>(undefined);

export const dataBusFullRowCountState = atom<number>(0);

export type OverlayKey = 'promptDesigner' | 'trivet' | 'dataStudio';

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

export const graphSearchPanelHeightState = atomWithStorage<number>('graphSearchPanelHeightState', 420, storage);

/** Whether the project-scoped Run Activity surface is visible. */
export const runActivityDrawerOpenState = atom<boolean>(false);

/** Persisted desktop height. Narrow viewports render Run Activity as an overlay instead. */
export const runActivityDrawerHeightState = atomWithStorage<number>('runActivityDrawerHeightState', 360, storage);

/**
 * User-local desktop column preferences for Run Activity. The drawer validates
 * this persisted value before use so old or malformed browser storage cannot
 * distort the table layout.
 */
export const runActivityColumnWidthsState = atomWithStorage<RunActivityColumnWidths>(
  'runActivityColumnWidthsState',
  DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
  storage,
);

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

export const fullscreenOutputEditorFontSizeState = atomWithStorage<number>(
  'fullscreenOutputEditorFontSizeState',
  DEFAULT_MULTILINE_EDITOR_FONT_SIZE,
  storage,
);

export const helpModalOpenState = atom<boolean>(false);
