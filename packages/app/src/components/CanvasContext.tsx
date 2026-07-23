import { createContext, useContext } from 'react';
import type {
  ChartNode,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '@valerypopoff/rivet2-core';
import type { DataBusPortChannelIndex } from './nodeCanvas/dataBusModel.js';
import type { MouseEvent } from 'react';
import type { HeightCache } from '../hooks/useNodeBodyHeight';
import type { DraggingWireDef } from '../state/graphBuilder';
import type { NodeResizeBounds } from '../utils/nodeResize.js';

export type CanvasViewContextValue = {
  canvasZoom: number;
  closestPortToDraggingWire: { nodeId: NodeId; portId: PortId } | undefined;
  draggingWire: DraggingWireDef | undefined;
  graphStateOverlaysEnabled: boolean;
  heightCache: HeightCache;
  isReallyZoomedOut: boolean;
  isZoomedOut: boolean;
  dataBusPortChannels: DataBusPortChannelIndex;
  hoveredDataBusChannelKeys: readonly string[];
};

export type CanvasHandlersContextValue = {
  onNodeMouseEnter?: (event: MouseEvent<HTMLElement>, nodeId: NodeId) => void;
  onNodeMouseLeave?: (event: MouseEvent<HTMLElement>, nodeId: NodeId) => void;
  onNodeSelected?: (node: ChartNode, multi: boolean) => void;
  onNodeSizeChanged?: (node: ChartNode, nextBounds: NodeResizeBounds) => void;
  onNodeStartEditing?: (node: ChartNode) => void;
  onPortMouseOut?: (
    event: MouseEvent<HTMLElement>,
    nodeId: NodeId,
    isInput: boolean,
    portId: PortId,
    definition: NodeInputDefinition | NodeOutputDefinition,
  ) => void;
  onPortMouseOver?: (
    event: MouseEvent<HTMLElement>,
    nodeId: NodeId,
    isInput: boolean,
    portId: PortId,
    definition: NodeInputDefinition | NodeOutputDefinition,
  ) => void;
  onResizeFinish?: (node: ChartNode, nextBounds: NodeResizeBounds) => void;
  onWireEndDrag?: (event: MouseEvent<HTMLElement>, endNodeId: NodeId, endPortId: PortId) => void;
  onWireStartDrag?: (
    event: MouseEvent<HTMLElement>,
    startNodeId: NodeId,
    startPortId: PortId,
    isInput: boolean,
  ) => void;
  onDataBusChannelHoverChange?: (channelKeys: readonly string[]) => void;
};

export const CanvasViewContext = createContext<CanvasViewContextValue | null>(null);
export const CanvasHandlersContext = createContext<CanvasHandlersContextValue | null>(null);

export function useCanvasViewContext(): CanvasViewContextValue {
  const context = useContext(CanvasViewContext);
  if (!context) {
    throw new Error('CanvasViewContext is not available');
  }
  return context;
}

export function useCanvasHandlersContext(): CanvasHandlersContextValue {
  const context = useContext(CanvasHandlersContext);
  if (!context) {
    throw new Error('CanvasHandlersContext is not available');
  }
  return context;
}
