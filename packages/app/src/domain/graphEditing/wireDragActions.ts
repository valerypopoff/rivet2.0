import { type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import { removeMatchingConnection } from './connectionActions.js';

export type DraggingWireActionState = {
  startNodeId: NodeId;
  startPortId: PortId;
  startPortIsInput?: boolean;
  originalConnection?: NodeConnection;
  rewireSourceInput?: {
    nodeId: NodeId;
    portId: PortId;
  };
};

export type ResolvedWireDragAction =
  | {
      type: 'makeConnection';
      params: {
        outputNodeId: NodeId;
        outputId: PortId;
        inputNodeId: NodeId;
        inputId: PortId;
      };
    }
  | {
      type: 'rewireConnection';
      originalConnection: NodeConnection;
      params: {
        outputNodeId: NodeId;
        outputId: PortId;
        inputNodeId: NodeId;
        inputId: PortId;
      };
    }
  | {
      type: 'breakConnection';
      connection: NodeConnection;
    }
  | {
      type: 'none';
      reason: 'emptyCanvas' | 'sameEndpoint';
    };

function isDroppingBackOnOriginalInput(options: {
  draggingWire: DraggingWireActionState;
  dropTarget: {
    nodeId: NodeId;
    portId: PortId;
  };
}): options is {
  draggingWire: DraggingWireActionState & {
    originalConnection: NodeConnection;
    rewireSourceInput: {
      nodeId: NodeId;
      portId: PortId;
    };
  };
  dropTarget: {
    nodeId: NodeId;
    portId: PortId;
  };
} {
  const { draggingWire, dropTarget } = options;

  return !!(
    draggingWire.originalConnection &&
    draggingWire.rewireSourceInput &&
    draggingWire.rewireSourceInput.nodeId === dropTarget.nodeId &&
    draggingWire.rewireSourceInput.portId === dropTarget.portId &&
    draggingWire.originalConnection.outputNodeId === draggingWire.startNodeId &&
    draggingWire.originalConnection.outputId === draggingWire.startPortId
  );
}

export function resolveWireDragAction(options: {
  draggingWire: DraggingWireActionState;
  didMove?: boolean;
  dropTarget?: {
    nodeId: NodeId;
    portId: PortId;
  };
}): ResolvedWireDragAction {
  const { draggingWire, dropTarget, didMove = true } = options;

  if (!dropTarget) {
    return draggingWire.originalConnection
      ? { type: 'breakConnection', connection: draggingWire.originalConnection }
      : { type: 'none', reason: 'emptyCanvas' };
  }

  if (isDroppingBackOnOriginalInput({ draggingWire, dropTarget })) {
    if (!didMove) {
      return { type: 'breakConnection', connection: draggingWire.originalConnection! };
    }

    return { type: 'none', reason: 'sameEndpoint' };
  }

  if (!didMove && !draggingWire.originalConnection) {
    return { type: 'none', reason: 'emptyCanvas' };
  }

  const params = {
    outputNodeId: draggingWire.startNodeId,
    outputId: draggingWire.startPortId,
    inputNodeId: dropTarget.nodeId,
    inputId: dropTarget.portId,
  };
  const originalConnection = draggingWire.originalConnection;

  if (originalConnection) {
    return {
      type: 'rewireConnection',
      originalConnection,
      params,
    };
  }

  return {
    type: 'makeConnection',
    params,
  };
}

export function shouldContinueDraggingAfterWireAction(
  action: ResolvedWireDragAction,
  keepDragging: boolean,
): boolean {
  if (!keepDragging) {
    return false;
  }

  return !(action.type === 'none' && action.reason === 'sameEndpoint');
}

export function shouldKeepWireConnectionModeAfterAction(options: {
  action: ResolvedWireDragAction;
  draggingWire: DraggingWireActionState;
  keepDragging: boolean;
}): boolean {
  if (shouldContinueDraggingAfterWireAction(options.action, options.keepDragging)) {
    return true;
  }

  return (
    options.action.type === 'none' &&
    options.action.reason === 'emptyCanvas' &&
    options.draggingWire.startPortIsInput !== true &&
    options.draggingWire.originalConnection == null
  );
}

export function shouldFinalizeWireDragFromGlobalMouseUp(options: {
  hasActivePointerGesture: boolean;
  hasDropTarget: boolean;
}): boolean {
  return options.hasActivePointerGesture || options.hasDropTarget;
}

export function getCanvasPreviewConnections(
  connections: NodeConnection[],
  draggingWire:
    | {
        originalConnection?: NodeConnection;
      }
    | undefined,
): NodeConnection[] {
  if (!draggingWire?.originalConnection) {
    return connections;
  }

  return removeMatchingConnection(connections, draggingWire.originalConnection);
}
