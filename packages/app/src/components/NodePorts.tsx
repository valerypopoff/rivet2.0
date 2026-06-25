import {
  type ChartNode,
  type NodeConnection,
  type NodeOutputDefinition,
  type PortId,
  isBuiltInInputDefinition,
} from '@valerypopoff/rivet2-core';
import { type FC, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasNodeIO } from '../hooks/useGetNodeIO.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { Port } from './Port.js';
import { ErrorBoundary } from 'react-error-boundary';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins';
import { LoopControllerNodePorts } from './LoopControllerNodePorts';
import { useAtom, useAtomValue } from 'jotai';
import { preservePortTextCaseState } from '../state/settings.js';
import { graphMetadataState } from '../state/graph.js';
import { projectMetadataState } from '../state/savedGraphs.js';
import { useCanvasHandlersContext, useCanvasViewContext } from './CanvasContext';
import { useEditNodeCommand } from '../commands/editNodeCommand.js';
import { useReorderVariadicPortsCommand } from '../commands/reorderVariadicPortsCommand.js';
import { subGraphPortRearrangeTargetState, variadicPortRearrangeTargetState } from '../state/ui.js';
import {
  getDefinitionPortIds,
  getSubGraphPortOrderKey,
  normalizeSubGraphPortOrder,
  type SubGraphPortOrderSide,
} from '../domain/graphEditing/subGraphPortOrder.js';
import {
  buildVariadicPortReorderMappings,
  getMirroredPortId,
  getReorderableVariadicInputDefinitions,
  getReorderableVariadicOutputDefinitions,
  getVariadicPortReorderSpec,
  hasVariadicNodeConnectionAffectedByMapping,
  type VariadicPortReorderSide,
} from '../domain/graphEditing/variadicPortReorder.js';
import {
  applyOrderedDefinitionSubset,
  areStringArraysEqual,
  getOrderedPortDefinitions,
  getPortOrderFromPoint,
  type PortReorderDrag,
} from './nodeCanvas/portReorderInteraction.js';

export type NodePortsProps = {
  node: ChartNode;
  connections: NodeConnection[];
  zoomedOut?: boolean;
};

function isSubGraphErrorOutputDefinition(node: ChartNode, output: NodeOutputDefinition): boolean {
  return (
    node.type === 'subGraph' &&
    (node.data as { useErrorOutput?: boolean }).useErrorOutput === true &&
    output.id === 'error' &&
    output.title === 'Error'
  );
}

export const NodePortsRenderer: FC<NodePortsProps> = ({ ...props }) => {
  return (
    <ErrorBoundary fallback={<div />}>
      {props.node.type === 'loopController' ? <LoopControllerNodePorts {...props} /> : <NodePorts {...props} />}
    </ErrorBoundary>
  );
};

export const NodePorts: FC<NodePortsProps> = ({
  node,
  connections,
}) => {
  const { draggingWire, closestPortToDraggingWire } = useCanvasViewContext();
  const { onPortMouseOut, onPortMouseOver, onWireEndDrag, onWireStartDrag } = useCanvasHandlersContext();
  const { inputDefinitions, outputDefinitions } = useCanvasNodeIO(node.id)!;
  const preservePortTextCase = useAtomValue(preservePortTextCaseState);
  const projectId = useAtomValue(projectMetadataState).id;
  const graphId = useAtomValue(graphMetadataState)?.id;
  const [subGraphPortRearrangeTarget, setSubGraphPortRearrangeTarget] = useAtom(subGraphPortRearrangeTargetState);
  const [variadicPortRearrangeTarget, setVariadicPortRearrangeTarget] = useAtom(variadicPortRearrangeTargetState);
  const editNode = useEditNodeCommand();
  const reorderVariadicPorts = useReorderVariadicPortsCommand();
  const portsRootRef = useRef<HTMLDivElement>(null);
  const draggedPortRef = useRef<PortReorderDrag | undefined>();
  const previewPortOrderRef = useRef<string[] | undefined>();
  const [draggedPort, setDraggedPort] = useState<PortReorderDrag | undefined>();
  const [previewPortOrder, setPreviewPortOrder] = useState<string[] | undefined>();

  const isSubGraphNode = node.type === 'subGraph';
  const isRearrangingSubGraphPorts =
    isSubGraphNode &&
    subGraphPortRearrangeTarget?.projectId === projectId &&
    subGraphPortRearrangeTarget?.graphId === graphId &&
    subGraphPortRearrangeTarget?.nodeId === node.id;
  const variadicPortReorderSpec = getVariadicPortReorderSpec(node);
  const isRearrangingVariadicPorts =
    variadicPortReorderSpec != null &&
    variadicPortRearrangeTarget?.projectId === projectId &&
    variadicPortRearrangeTarget?.graphId === graphId &&
    variadicPortRearrangeTarget?.nodeId === node.id;
  const isRearrangingPorts = isRearrangingSubGraphPorts || isRearrangingVariadicPorts;
  const renderedInputDefinitions = useMemo(
    () => inputDefinitions.filter((input) => !isBuiltInInputDefinition(input)),
    [inputDefinitions],
  );
  const reorderableOutputDefinitions = useMemo(
    () => outputDefinitions.filter((output) => !isSubGraphErrorOutputDefinition(node, output)),
    [node, outputDefinitions],
  );
  const nonReorderableOutputDefinitions = useMemo(
    () => outputDefinitions.filter((output) => isSubGraphErrorOutputDefinition(node, output)),
    [node, outputDefinitions],
  );
  const reorderableVariadicInputDefinitions = useMemo(
    () =>
      getReorderableVariadicInputDefinitions({
        connections,
        definitions: renderedInputDefinitions,
        node,
      }),
    [connections, node, renderedInputDefinitions],
  );
  const reorderableVariadicOutputDefinitions = useMemo(
    () =>
      getReorderableVariadicOutputDefinitions({
        definitions: outputDefinitions,
        inputDefinitions: reorderableVariadicInputDefinitions,
        spec: variadicPortReorderSpec,
      }),
    [outputDefinitions, reorderableVariadicInputDefinitions, variadicPortReorderSpec],
  );
  const displayedInputDefinitions = useMemo(() => {
    if (draggedPort?.mode === 'subGraph' && draggedPort.side === 'input' && previewPortOrder) {
      return getOrderedPortDefinitions(renderedInputDefinitions, previewPortOrder);
    }

    if (isRearrangingVariadicPorts) {
      let orderedSubset = reorderableVariadicInputDefinitions;

      if (draggedPort?.mode === 'variadic' && previewPortOrder) {
        if (draggedPort.side === 'input') {
          orderedSubset = getOrderedPortDefinitions(reorderableVariadicInputDefinitions, previewPortOrder);
        } else if (variadicPortReorderSpec?.outputPrefix) {
          const nextInputOrder = previewPortOrder.map((portId) =>
            getMirroredPortId(portId, variadicPortReorderSpec.outputPrefix!, variadicPortReorderSpec.inputPrefix),
          );
          orderedSubset = getOrderedPortDefinitions(reorderableVariadicInputDefinitions, nextInputOrder);
        }
      }

      return applyOrderedDefinitionSubset(renderedInputDefinitions, orderedSubset);
    }

    return renderedInputDefinitions;
  }, [
    draggedPort?.mode,
    draggedPort?.side,
    isRearrangingVariadicPorts,
    previewPortOrder,
    renderedInputDefinitions,
    reorderableVariadicInputDefinitions,
    variadicPortReorderSpec,
  ]);
  const displayedOutputDefinitions = useMemo(() => {
    if (draggedPort?.mode === 'subGraph' && draggedPort.side === 'output' && previewPortOrder) {
      return [
        ...getOrderedPortDefinitions(reorderableOutputDefinitions, previewPortOrder),
        ...nonReorderableOutputDefinitions,
      ];
    }

    if (isRearrangingVariadicPorts && variadicPortReorderSpec?.kind === 'input-output-pair') {
      let orderedSubset = reorderableVariadicOutputDefinitions;

      if (draggedPort?.mode === 'variadic' && previewPortOrder) {
        if (draggedPort.side === 'output') {
          orderedSubset = getOrderedPortDefinitions(reorderableVariadicOutputDefinitions, previewPortOrder);
        } else if (variadicPortReorderSpec.outputPrefix) {
          const nextOutputOrder = previewPortOrder.map((portId) =>
            getMirroredPortId(portId, variadicPortReorderSpec.inputPrefix, variadicPortReorderSpec.outputPrefix!),
          );
          orderedSubset = getOrderedPortDefinitions(reorderableVariadicOutputDefinitions, nextOutputOrder);
        }
      }

      return applyOrderedDefinitionSubset(outputDefinitions, orderedSubset);
    }

    return outputDefinitions;
  }, [
    draggedPort?.mode,
    draggedPort?.side,
    isRearrangingVariadicPorts,
    nonReorderableOutputDefinitions,
    outputDefinitions,
    previewPortOrder,
    reorderableOutputDefinitions,
    reorderableVariadicOutputDefinitions,
    variadicPortReorderSpec,
  ]);

  const handlePortMouseDown = useStableCallback((event: MouseEvent<HTMLDivElement>, port: PortId, isInput: boolean) => {
    event.stopPropagation();
    event.preventDefault();
    onWireStartDrag?.(event, node.id, port, isInput);
  });

  const handlePortMouseUp = useStableCallback((event: MouseEvent<HTMLDivElement>, port: PortId) => {
    onWireEndDrag?.(event, node.id, port);
  });

  const commitSubGraphPortReorder = useStableCallback(
    (side: SubGraphPortOrderSide, nextPortOrder: string[] | undefined) => {
      if (!isSubGraphNode || !nextPortOrder) {
        return;
      }

      const definitions = side === 'input' ? renderedInputDefinitions : reorderableOutputDefinitions;
      const orderKey = getSubGraphPortOrderKey(side);
      const nodeData = node.data as Record<string, unknown> & {
        inputPortOrder?: string[];
        outputPortOrder?: string[];
      };
      const currentPortOrder = orderKey === 'inputPortOrder' ? nodeData.inputPortOrder : nodeData.outputPortOrder;
      const normalizedCurrentPortOrder = normalizeSubGraphPortOrder(getDefinitionPortIds(definitions), currentPortOrder);

      if (areStringArraysEqual(nextPortOrder, normalizedCurrentPortOrder)) {
        return;
      }

      editNode({
        nodeId: node.id,
        newNode: {
          data: {
            ...nodeData,
            [orderKey]: nextPortOrder,
          },
        },
        previousNodeOverride: node,
        mergeWithPrevious: false,
      });
    },
  );

  const commitVariadicPortReorder = useStableCallback(
    (side: VariadicPortReorderSide, nextPortOrder: string[] | undefined) => {
      if (!variadicPortReorderSpec || !nextPortOrder) {
        return;
      }

      const definitions = side === 'input' ? reorderableVariadicInputDefinitions : reorderableVariadicOutputDefinitions;
      const currentPortOrder = getDefinitionPortIds(definitions);
      const mappings = buildVariadicPortReorderMappings({
        currentPortOrder,
        nextPortOrder,
        side,
        spec: variadicPortReorderSpec,
      });

      if (!mappings) {
        return;
      }

      const hasAffectedConnection = hasVariadicNodeConnectionAffectedByMapping({
        connections,
        inputPortMapping: mappings.inputPortMapping,
        nodeId: node.id,
        outputPortMapping: mappings.outputPortMapping,
      });

      if (!hasAffectedConnection) {
        return;
      }

      reorderVariadicPorts({
        inputPortMapping: mappings.inputPortMapping,
        nodeId: node.id,
        outputPortMapping: mappings.outputPortMapping,
      });
    },
  );

  const updatePreviewPortOrderFromPointer = useStableCallback((clientY: number, drag: PortReorderDrag) => {
    const definitions =
      drag.mode === 'subGraph'
        ? drag.side === 'input'
          ? renderedInputDefinitions
          : reorderableOutputDefinitions
        : drag.side === 'input'
          ? reorderableVariadicInputDefinitions
          : reorderableVariadicOutputDefinitions;
    const portIds = getDefinitionPortIds(definitions);

    if (!portIds.length) {
      return;
    }

    const nextPortOrder = getPortOrderFromPoint({
      clientY,
      nodeId: node.id,
      portIds,
      portOrder: previewPortOrderRef.current,
      side: drag.side,
      sourcePortId: drag.portId,
    });

    if (!nextPortOrder) {
      return;
    }

    previewPortOrderRef.current = nextPortOrder;
    setPreviewPortOrder(nextPortOrder);
  });

  const handleReorderMouseDown = useStableCallback(
    (event: MouseEvent<HTMLDivElement>, port: PortId, isInput: boolean, title: string) => {
      if (!isRearrangingPorts) {
        return;
      }

      const side: SubGraphPortOrderSide = isInput ? 'input' : 'output';
      const mode: PortReorderDrag['mode'] = isRearrangingSubGraphPorts ? 'subGraph' : 'variadic';
      const definitions =
        mode === 'subGraph'
          ? side === 'input'
            ? renderedInputDefinitions
            : reorderableOutputDefinitions
          : side === 'input'
            ? reorderableVariadicInputDefinitions
            : reorderableVariadicOutputDefinitions;

      if (!definitions.some((definition) => definition.id === port)) {
        return;
      }

      let normalizedPortOrder: string[];
      if (mode === 'subGraph') {
        const orderKey = getSubGraphPortOrderKey(side);
        const nodeData = node.data as {
          inputPortOrder?: string[];
          outputPortOrder?: string[];
        };
        const currentPortOrder = orderKey === 'inputPortOrder' ? nodeData.inputPortOrder : nodeData.outputPortOrder;
        normalizedPortOrder = normalizeSubGraphPortOrder(getDefinitionPortIds(definitions), currentPortOrder);
      } else {
        normalizedPortOrder = getDefinitionPortIds(definitions);
      }

      const labelRect = event.currentTarget.getBoundingClientRect();
      const drag = {
        clientX: event.clientX,
        clientY: event.clientY,
        height: labelRect.height,
        mode,
        portId: port,
        pointerOffsetX: event.clientX - labelRect.left,
        pointerOffsetY: event.clientY - labelRect.top,
        side,
        title,
        width: labelRect.width,
      };

      draggedPortRef.current = drag;
      previewPortOrderRef.current = normalizedPortOrder;
      setDraggedPort(drag);
      setPreviewPortOrder(normalizedPortOrder);
    },
  );

  const draggedPortKey = draggedPort ? `${draggedPort.mode}:${draggedPort.side}:${draggedPort.portId}` : undefined;

  useEffect(() => {
    if (!isRearrangingPorts) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const nodeElement = portsRootRef.current?.closest('.node');

      if (!(target instanceof Node) || nodeElement?.contains(target)) {
        return;
      }

      setSubGraphPortRearrangeTarget(undefined);
      setVariadicPortRearrangeTarget(undefined);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isRearrangingPorts, setSubGraphPortRearrangeTarget, setVariadicPortRearrangeTarget]);

  useEffect(() => {
    if (!draggedPortKey) {
      return;
    }

    document.body.classList.add('port-reorder-dragging');

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const currentDrag = draggedPortRef.current;

      if (!currentDrag) {
        return;
      }

      const nextDrag = {
        ...currentDrag,
        clientX: event.clientX,
        clientY: event.clientY,
      };

      draggedPortRef.current = nextDrag;
      setDraggedPort(nextDrag);
      updatePreviewPortOrderFromPointer(event.clientY, nextDrag);
    };

    const handleMouseUp = (event: globalThis.MouseEvent) => {
      const currentDrag = draggedPortRef.current;

      if (currentDrag) {
        updatePreviewPortOrderFromPointer(event.clientY, currentDrag);
        if (currentDrag.mode === 'subGraph') {
          commitSubGraphPortReorder(currentDrag.side as SubGraphPortOrderSide, previewPortOrderRef.current);
        } else {
          commitVariadicPortReorder(currentDrag.side as VariadicPortReorderSide, previewPortOrderRef.current);
        }
      }

      draggedPortRef.current = undefined;
      previewPortOrderRef.current = undefined;
      setDraggedPort(undefined);
      setPreviewPortOrder(undefined);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp, { once: true });

    return () => {
      document.body.classList.remove('port-reorder-dragging');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [commitSubGraphPortReorder, commitVariadicPortReorder, draggedPortKey, updatePreviewPortOrderFromPointer]);

  useDependsOnPlugins();

  return (
    <>
      <div
        className={`node-ports${isRearrangingSubGraphPorts ? ' subgraph-port-rearrange-mode' : ''}${
          isRearrangingVariadicPorts ? ' variadic-port-rearrange-mode' : ''
        }`}
        ref={portsRootRef}
      >
        <div className="input-ports">
          {displayedInputDefinitions.map((input) => {
            const connected =
              connections.some((conn) => conn.inputNodeId === node.id && conn.inputId === input.id) ||
              (draggingWire?.endNodeId === node.id && draggingWire?.endPortId === input.id);
            const isVariadicInputReorderable =
              isRearrangingVariadicPorts &&
              reorderableVariadicInputDefinitions.some((definition) => definition.id === input.id);
            const reorderable = isRearrangingSubGraphPorts || isVariadicInputReorderable;

            return (
              <Port
                title={input.title}
                id={input.id}
                preservePortCase={preservePortTextCase}
                input
                connected={connected}
                key={`input-${input.id}`}
                nodeId={node.id}
                canDragTo={draggingWire ? !draggingWire.startPortIsInput : false}
                closest={closestPortToDraggingWire?.nodeId === node.id && closestPortToDraggingWire.portId === input.id}
                definition={input}
                draggingDataType={draggingWire?.dataType}
                onMouseDown={handlePortMouseDown}
                onMouseUp={handlePortMouseUp}
                onMouseOver={onPortMouseOver}
                onMouseOut={onPortMouseOut}
                reorderable={reorderable}
                reorderDragging={draggedPort?.side === 'input' && draggedPort.portId === input.id}
                onReorderMouseDown={handleReorderMouseDown}
              />
            );
          })}
        </div>
        <div className="output-ports">
          {displayedOutputDefinitions.map((output) => {
            const connected =
              connections.some((conn) => conn.outputNodeId === node.id && conn.outputId === output.id) ||
              (draggingWire?.startNodeId === node.id && draggingWire?.startPortId === output.id);
            const isVariadicOutputReorderable =
              isRearrangingVariadicPorts &&
              variadicPortReorderSpec?.kind === 'input-output-pair' &&
              reorderableVariadicOutputDefinitions.some((definition) => definition.id === output.id);
            const reorderable =
              (isRearrangingSubGraphPorts && !isSubGraphErrorOutputDefinition(node, output)) ||
              isVariadicOutputReorderable;

            return (
              <Port
                preservePortCase={preservePortTextCase}
                title={output.title}
                id={output.id}
                connected={connected}
                key={`output-${output.id}`}
                nodeId={node.id}
                canDragTo={draggingWire ? draggingWire.startPortIsInput : false}
                closest={closestPortToDraggingWire?.nodeId === node.id && closestPortToDraggingWire.portId === output.id}
                definition={output}
                draggingDataType={draggingWire?.dataType}
                onMouseDown={handlePortMouseDown}
                onMouseUp={handlePortMouseUp}
                onMouseOver={onPortMouseOver}
                onMouseOut={onPortMouseOut}
                reorderable={reorderable}
                reorderDragging={draggedPort?.side === 'output' && draggedPort.portId === output.id}
                onReorderMouseDown={handleReorderMouseDown}
              />
            );
          })}
        </div>
      </div>
      {draggedPort &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              background: 'color-mix(in srgb, var(--primary, #ff9900) 18%, var(--grey-darkest, #1f1f1f) 82%)',
              border: '1px solid color-mix(in srgb, var(--primary, #ff9900) 42%, transparent)',
              borderRadius: 'calc(6px * var(--ui-font-scale, 1))',
              boxSizing: 'border-box',
              boxShadow: '0 8px 18px rgba(0, 0, 0, 0.35)',
              color: 'var(--grey-lightest, #ffffff)',
              fontFamily: 'var(--font-family-monospace, monospace)',
              fontSize: 'var(--ui-font-size-2xs, 12px)',
              height: draggedPort.height,
              letterSpacing: preservePortTextCase ? undefined : '1px',
              left: draggedPort.clientX - draggedPort.pointerOffsetX,
              lineHeight: '16px',
              opacity: 0.95,
              padding: '2px 6px',
              pointerEvents: 'none',
              position: 'fixed',
              textTransform: preservePortTextCase ? undefined : 'uppercase',
              top: draggedPort.clientY - draggedPort.pointerOffsetY,
              userSelect: 'none',
              whiteSpace: 'nowrap',
              width: draggedPort.width,
              zIndex: 20000,
            }}
          >
            {draggedPort.title}
          </div>,
          document.body,
        )}
    </>
  );
};
