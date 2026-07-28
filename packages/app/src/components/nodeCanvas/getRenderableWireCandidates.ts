import {
  getProjectConnectionComparisonKey,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { markCanvasPerfEnd, markCanvasPerfStart, setCanvasPerf } from './canvasPerfDebug.js';

export interface GetRenderableWireCandidatesOptions {
  connections: NodeConnection[];
  draggingNode: boolean;
  draggingWire: boolean;
  highlightedNodes?: ReadonlyArray<NodeId>;
  highlightedPort?:
    | {
        isInput: boolean;
        nodeId: NodeId;
        portId: PortId;
      }
    | undefined;
  forceRenderableConnectionKeySet?: ReadonlySet<string>;
  nearViewportNodeIdSet: ReadonlySet<NodeId>;
  runningNodeIdSet: ReadonlySet<NodeId>;
  visibleNodeIdSet: ReadonlySet<NodeId>;
}

export function getRenderableWireCandidates({
  connections,
  draggingNode,
  draggingWire,
  highlightedNodes,
  highlightedPort,
  forceRenderableConnectionKeySet,
  nearViewportNodeIdSet,
  runningNodeIdSet,
  visibleNodeIdSet,
}: GetRenderableWireCandidatesOptions): NodeConnection[] {
  markCanvasPerfStart('getRenderableWireCandidates');

  if (draggingNode || draggingWire) {
    setCanvasPerf('getRenderableWireCandidates:size', connections.length);
    markCanvasPerfEnd('getRenderableWireCandidates');
    return connections;
  }

  const highlightedNodeIdSet = highlightedNodes ? new Set(highlightedNodes) : undefined;

  const candidates = connections.filter((connection) => {
    if (forceRenderableConnectionKeySet?.has(getProjectConnectionComparisonKey(connection))) {
      return true;
    }

    const isHighlightedPort =
      highlightedPort &&
      (highlightedPort.isInput
        ? connection.inputNodeId === highlightedPort.nodeId && connection.inputId === highlightedPort.portId
        : connection.outputNodeId === highlightedPort.nodeId && connection.outputId === highlightedPort.portId);

    return (
      visibleNodeIdSet.has(connection.inputNodeId) ||
      visibleNodeIdSet.has(connection.outputNodeId) ||
      nearViewportNodeIdSet.has(connection.inputNodeId) ||
      nearViewportNodeIdSet.has(connection.outputNodeId) ||
      !!isHighlightedPort ||
      !!highlightedNodeIdSet?.has(connection.inputNodeId) ||
      !!highlightedNodeIdSet?.has(connection.outputNodeId) ||
      runningNodeIdSet.has(connection.inputNodeId) ||
      runningNodeIdSet.has(connection.outputNodeId)
    );
  });

  setCanvasPerf('getRenderableWireCandidates:size', candidates.length);
  markCanvasPerfEnd('getRenderableWireCandidates');

  return candidates;
}
