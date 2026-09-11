import { atom } from 'jotai';
import { atomWithStorage, atomFamily } from 'jotai/utils';
import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type DataType,
  type NodeGraph,
} from '@valerypopoff/rivet2-core';
import { type WireDef } from '../components/WireLayer.js';
import type { GraphNavigationStack } from '../domain/graphEditing/navigationActions.js';
import { createHybridStorage } from './storage.js';
import { type SearchedItem, type SearchableItem } from '../hooks/useSearchProject';
import type { GraphSearchMatch } from '../hooks/graphSearch.js';

const { storage } = createHybridStorage('graphBuilder');

export const viewingNodeChangesState = atom<NodeId | undefined>(undefined);

export const selectedNodesState = atom<NodeId[]>([]);

export const editingNodeState = atom<NodeId | null>(null);

export const fullscreenOutputNodeState = atom<NodeId | null>(null);

export type CanvasPosition = { x: number; y: number; zoom: number; fromSaved?: boolean };

export const canvasPositionState = atom<CanvasPosition>({
  x: 0,
  y: 0,
  zoom: 1,
});

export const lastCanvasPositionByGraphState = atomWithStorage<Record<GraphId, CanvasPosition | undefined>>(
  'lastCanvasPositionByGraph',
  {},
  storage,
);

export function removeCanvasPositionsForGraphs(
  positionsByGraph: Record<GraphId, CanvasPosition | undefined>,
  graphIds: readonly GraphId[],
): Record<GraphId, CanvasPosition | undefined> {
  const graphIdsToRemove = new Set(graphIds.filter((graphId) => graphId in positionsByGraph));
  if (graphIdsToRemove.size === 0) {
    return positionsByGraph;
  }

  const nextPositionsByGraph = { ...positionsByGraph };
  for (const graphId of graphIdsToRemove) {
    delete nextPositionsByGraph[graphId];
  }
  return nextPositionsByGraph;
}

export const draggingNodesState = atom<ChartNode[]>([]);

export const lastMousePositionState = atom<{ x: number; y: number }>({
  x: 0,
  y: 0,
});

export const sidebarOpenState = atom<boolean>(true);

export type DraggingWireDef = WireDef & {
  readonly dataType: DataType | Readonly<DataType[]>;
  readonly originalConnection?: NodeConnection;
  readonly rewireSourceInput?: {
    nodeId: NodeId;
    portId: PortId;
  };
};

export const draggingWireState = atom<DraggingWireDef | undefined>(undefined);

export const isDraggingWireState = atom((get) => get(draggingWireState) !== undefined);

export const draggingWireClosestPortState = atom<
  | {
      nodeId: NodeId;
      portId: PortId;
      element: HTMLElement;
      definition: NodeInputDefinition;
    }
  | undefined
>(undefined);

export const graphNavigationStackState = atom<GraphNavigationStack>({
  stack: [],
  index: undefined,
});

export const expandedOutputNodeIdsState = atom<NodeId[]>([]);

export const isNodeOutputExpandedState = atomFamily((nodeId: NodeId) =>
  atom((get) => get(expandedOutputNodeIdsState).includes(nodeId)),
);

export type GraphSearchState = {
  searching: boolean;
  panelOpen: boolean;
  query: string;
  selectedIndex: number;
  matches: GraphSearchMatch[];
  fallbackToTerms: boolean;
  focusRequestId: number;
  resultsScrollTop: number;
};

export const emptyGraphSearchState: GraphSearchState = {
  searching: false,
  panelOpen: false,
  query: '',
  selectedIndex: 0,
  matches: [],
  fallbackToTerms: false,
  focusRequestId: 0,
  resultsScrollTop: 0,
};

export const searchingGraphState = atom<GraphSearchState>(emptyGraphSearchState);

export function openOrFocusGraphSearchState(state: GraphSearchState): GraphSearchState {
  return state.searching
    ? { ...state, panelOpen: true, focusRequestId: state.focusRequestId + 1 }
    : { ...emptyGraphSearchState, searching: true, panelOpen: true, focusRequestId: state.focusRequestId + 1 };
}

export function hideGraphSearchPanelState(state: GraphSearchState): GraphSearchState {
  return state.searching && state.panelOpen ? { ...state, panelOpen: false } : state;
}

export function clearGraphSearchQueryState(state: GraphSearchState): GraphSearchState {
  return {
    ...state,
    query: '',
    selectedIndex: 0,
    matches: [],
    fallbackToTerms: false,
    searching: true,
    panelOpen: true,
    resultsScrollTop: 0,
  };
}

export function isGraphSearchVisibleWithQuery(
  state: Pick<GraphSearchState, 'panelOpen' | 'query' | 'searching'>,
): boolean {
  return state.searching && state.panelOpen && state.query.trim().length > 0;
}

export const goToSearchState = atom<{
  searching: boolean;
  query: string;
  selectedIndex: number;
  entries: SearchedItem[];
}>({
  searching: false,
  query: '',
  selectedIndex: 0,
  entries: [],
});

export const hoveringNodeState = atom<NodeId | undefined>(undefined);

export function removeGraphBuilderNodeStateFamilies(nodeId: NodeId): void {
  isNodeOutputExpandedState.remove(nodeId);
}
