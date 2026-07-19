import { useCallback, useEffect, useRef } from 'react';
import { type ChartNode, type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import { useAtom, useStore } from 'jotai';
import { toast } from 'react-toastify';
import { ioDefinitionsForNodeState } from '../state/graph.js';
import { draggingWireClosestPortState, draggingWireState, type DraggingWireDef } from '../state/graphBuilder.js';
import { useMakeConnectionCommand } from '../commands/makeConnectionCommand';
import { useBreakConnectionCommand } from '../commands/breakConnectionCommand';
import { useRewireConnectionCommand } from '../commands/rewireConnectionCommand.js';
import {
  resolveWireDragAction,
  shouldFinalizeWireDragFromGlobalMouseUp,
  shouldKeepWireConnectionModeAfterAction,
} from '../domain/graphEditing/wireDragActions.js';
import { createConnectionChange, createRewireConnectionChange } from '../domain/graphEditing/connectionActions.js';
import { getAsyncBranchTopologyViolation } from '../domain/graphEditing/connectionValidation.js';
import { canvasIoDefinitionsForNodeState } from '../state/selectors/canvasGraphSelectors.js';
import { resolveClosestWireDropTargetFromPoint } from '../utils/wireDropTarget.js';

const WIRE_CLICK_DISCONNECT_MOVE_THRESHOLD_PX = 3;

function shouldHandleGlobalWireMouseUpTarget(target: EventTarget | null): boolean {
  if (typeof Element !== 'undefined' && target instanceof Element && target.closest('.port-circle')) {
    return false;
  }

  return true;
}

export const useDraggingWire = ({
  connections,
  enabled = true,
  nodesById,
}: {
  connections: readonly NodeConnection[];
  enabled?: boolean;
  nodesById: Record<NodeId, ChartNode>;
}) => {
  const [draggingWire, setDraggingWire] = useAtom(draggingWireState);
  const store = useStore();
  const [closestPortToDraggingWire, setClosestPortToDraggingWire] = useAtom(draggingWireClosestPortState);
  const isDragging = !!draggingWire;

  const latestDraggingWire = useRef(draggingWire);
  const wireGestureStartRef = useRef<{ x: number; y: number } | undefined>(undefined);

  const makeConnection = useMakeConnectionCommand();
  const breakConnection = useBreakConnectionCommand();
  const rewireConnection = useRewireConnectionCommand();

  useEffect(() => {
    latestDraggingWire.current = draggingWire;
  }, [draggingWire]);

  const setActiveDraggingWire = useCallback(
    (wire: DraggingWireDef | undefined) => {
      latestDraggingWire.current = wire;
      setDraggingWire(wire);
    },
    [latestDraggingWire, setDraggingWire],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (closestPortToDraggingWire && isDragging) {
      setDraggingWire((w) => {
        if (!w) {
          return w;
        }

        const nextWire = {
          ...w,
          endNodeId: closestPortToDraggingWire.nodeId,
          endPortId: closestPortToDraggingWire.portId,
        };

        latestDraggingWire.current = nextWire;
        return nextWire;
      });
    } else if (isDragging) {
      setDraggingWire((w) => {
        if (!w) {
          return w;
        }

        const nextWire = { ...w, endNodeId: undefined, endPortId: undefined };

        latestDraggingWire.current = nextWire;
        return nextWire;
      });
    }
  }, [closestPortToDraggingWire, enabled, setDraggingWire, isDragging, latestDraggingWire]);

  const clearDraggingWire = useCallback(() => {
    wireGestureStartRef.current = undefined;
    setActiveDraggingWire(undefined);
    setClosestPortToDraggingWire(undefined);
  }, [setActiveDraggingWire, setClosestPortToDraggingWire]);

  const resolveDropTargetFromPointerPosition = useCallback(
    (clientX: number, clientY: number) =>
      enabled
        ? resolveClosestWireDropTargetFromPoint({
            clientX,
            clientY,
            getInputDefinition: (nodeId, portId) =>
              store
                .get(canvasIoDefinitionsForNodeState(nodeId))
                ?.inputDefinitions.find((definition) => definition.id === portId),
          })
        : undefined,
    [enabled, store],
  );

  const continueDraggingWire = useCallback(
    (wire: NonNullable<typeof draggingWire>) => {
      wireGestureStartRef.current = undefined;
      setActiveDraggingWire({
        startNodeId: wire.startNodeId,
        startPortId: wire.startPortId,
        startPortIsInput: false,
        dataType: wire.dataType,
      });
      setClosestPortToDraggingWire(undefined);
    },
    [setActiveDraggingWire, setClosestPortToDraggingWire],
  );

  const didCurrentWireGestureMove = useCallback((clientX: number, clientY: number) => {
    const start = wireGestureStartRef.current;
    if (!start) {
      return true;
    }

    return Math.hypot(clientX - start.x, clientY - start.y) >= WIRE_CLICK_DISCONNECT_MOVE_THRESHOLD_PX;
  }, []);

  const isStickyConnectionModePending = useCallback(
    () => !!latestDraggingWire.current && !wireGestureStartRef.current,
    [latestDraggingWire],
  );

  const getValidatedDropTarget = useCallback(
    (
      wire: NonNullable<typeof draggingWire>,
      dropTarget:
        | {
            nodeId: NodeId;
            portId: PortId;
          }
        | undefined,
    ) => {
      if (!dropTarget) {
        return undefined;
      }

      const inputNode = nodesById[dropTarget.nodeId];
      const outputNode = nodesById[wire.startNodeId];

      if (!inputNode || !outputNode) {
        return undefined;
      }

      const inputNodeIO = store.get(canvasIoDefinitionsForNodeState(inputNode.id));
      const outputNodeIO = store.get(canvasIoDefinitionsForNodeState(outputNode.id));

      const input = inputNodeIO?.inputDefinitions.find((definition) => definition.id === dropTarget.portId);
      const output = outputNodeIO?.outputDefinitions.find((definition) => definition.id === wire.startPortId);

      return input && output ? dropTarget : undefined;
    },
    [nodesById, store],
  );

  const finalizeWireDrag = useCallback(
    (options: {
      didMove: boolean;
      dropTarget?:
        | {
            nodeId: NodeId;
            portId: PortId;
          }
        | undefined;
      keepDragging: boolean;
    }) => {
      const activeDraggingWire = latestDraggingWire.current;

      if (!activeDraggingWire) {
        return;
      }

      const validatedDropTarget = getValidatedDropTarget(activeDraggingWire, options.dropTarget);
      const action = resolveWireDragAction({
        draggingWire: activeDraggingWire,
        didMove: options.didMove,
        dropTarget: validatedDropTarget,
      });

      const nextConnections =
        action.type === 'makeConnection'
          ? createConnectionChange([...connections], action.params).connections
          : action.type === 'rewireConnection'
            ? createRewireConnectionChange([...connections], action.originalConnection, action.params).connections
            : undefined;
      const asyncBranchViolation = nextConnections
        ? getAsyncBranchTopologyViolation({
            connections: nextConnections,
            nodesById,
          })
        : undefined;

      if (asyncBranchViolation) {
        toast.warn(`Cannot create connection: ${asyncBranchViolation.message}`);
        clearDraggingWire();
        return;
      }

      if (action.type === 'makeConnection') {
        makeConnection(action.params);
      } else if (action.type === 'rewireConnection') {
        rewireConnection({
          originalConnection: action.originalConnection,
          ...action.params,
        });
      } else if (action.type === 'breakConnection') {
        breakConnection({ connectionToBreak: action.connection });
      }

      if (
        shouldKeepWireConnectionModeAfterAction({
          action,
          draggingWire: activeDraggingWire,
          keepDragging: options.keepDragging,
        })
      ) {
        continueDraggingWire(activeDraggingWire);
      } else {
        clearDraggingWire();
      }
    },
    [
      breakConnection,
      clearDraggingWire,
      connections,
      continueDraggingWire,
      getValidatedDropTarget,
      latestDraggingWire,
      makeConnection,
      nodesById,
      rewireConnection,
    ],
  );

  const onWireStartDrag = useCallback(
    (event: React.MouseEvent<HTMLElement>, startNodeId: NodeId, startPortId: PortId, isInput: boolean) => {
      if (!enabled) {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();

      if (isStickyConnectionModePending()) {
        event.preventDefault();
        return;
      }

      if (isInput) {
        const existingConnection = connections.find(
          (conn) => conn.inputNodeId === startNodeId && conn.inputId === startPortId,
        );

        if (existingConnection) {
          const { outputId, outputNodeId } = existingConnection;

          const def = store
            .get(ioDefinitionsForNodeState(outputNodeId))
            ?.outputDefinitions.find((o) => o.id === outputId);

          if (!def?.dataType) {
            clearDraggingWire();
            return;
          }

          wireGestureStartRef.current = { x: event.clientX, y: event.clientY };
          setActiveDraggingWire({
            startNodeId: outputNodeId,
            startPortId: outputId,
            startPortIsInput: false,
            dataType: def.dataType,
            originalConnection: existingConnection,
            rewireSourceInput: {
              nodeId: startNodeId,
              portId: startPortId,
            },
          });
          return;
        }
        return;
      }

      const def = store
        .get(ioDefinitionsForNodeState(startNodeId))
        ?.outputDefinitions.find((o) => o.id === startPortId);
      if (!def?.dataType) {
        clearDraggingWire();
        return;
      }
      wireGestureStartRef.current = { x: event.clientX, y: event.clientY };
      setActiveDraggingWire({ startNodeId, startPortId, startPortIsInput: isInput, dataType: def.dataType });
    },
    [clearDraggingWire, connections, enabled, isStickyConnectionModePending, store, setActiveDraggingWire],
  );

  const onWireEndDrag = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      if (!latestDraggingWire.current) {
        return;
      }

      const dropTarget = resolveDropTargetFromPointerPosition(event.clientX, event.clientY);
      event.stopPropagation();

      finalizeWireDrag({
        didMove: didCurrentWireGestureMove(event.clientX, event.clientY),
        dropTarget: dropTarget ? { nodeId: dropTarget.nodeId, portId: dropTarget.portId } : undefined,
        keepDragging: event.ctrlKey || event.metaKey,
      });
    },
    [didCurrentWireGestureMove, enabled, finalizeWireDrag, latestDraggingWire, resolveDropTargetFromPointerPosition],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleWindowMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      if (!latestDraggingWire.current || !shouldHandleGlobalWireMouseUpTarget(event.target)) {
        return;
      }

      const dropTarget = resolveDropTargetFromPointerPosition(event.clientX, event.clientY);
      if (
        !shouldFinalizeWireDragFromGlobalMouseUp({
          hasActivePointerGesture: !!wireGestureStartRef.current,
          hasDropTarget: !!dropTarget,
        })
      ) {
        return;
      }

      finalizeWireDrag({
        didMove: didCurrentWireGestureMove(event.clientX, event.clientY),
        dropTarget: dropTarget ? { nodeId: dropTarget.nodeId, portId: dropTarget.portId } : undefined,
        keepDragging: event.ctrlKey || event.metaKey,
      });
    };

    window.addEventListener('mouseup', handleWindowMouseUp, { capture: true });
    return () => {
      window.removeEventListener('mouseup', handleWindowMouseUp, { capture: true });
    };
  }, [didCurrentWireGestureMove, enabled, finalizeWireDrag, latestDraggingWire, resolveDropTargetFromPointerPosition]);

  useEffect(() => clearDraggingWire, [clearDraggingWire]);

  return {
    clearDraggingWire,
    draggingWire,
    onWireStartDrag,
    onWireEndDrag,
  };
};
