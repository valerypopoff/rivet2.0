import clsx from 'clsx';
import { memo, type FC, type MouseEvent } from 'react';
import { useAtomValue } from 'jotai';
import { type ChartNode, IF_PORT, type NodeConnection, type PortId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { preservePortTextCaseState } from '../../state/settings.js';
import { useCanvasHandlersContext, useCanvasViewContext } from '../CanvasContext.js';
import { Port } from '../Port.js';
import { useInputConnectionWarnings } from '../../hooks/useGetNodeIO.js';

export const ConditionalIfPort: FC<{
  node: ChartNode;
  connections?: NodeConnection[];
}> = memo(({ node, connections = [] }) => {
  const { draggingWire, closestPortToDraggingWire } = useCanvasViewContext();
  const { onPortMouseOut, onPortMouseOver, onWireEndDrag, onWireStartDrag } = useCanvasHandlersContext();
  const preservePortTextCase = useAtomValue(preservePortTextCaseState);
  const inputWarnings = useInputConnectionWarnings(node.id, connections);

  const handleIfPortMouseDown = useStableCallback(
    (event: MouseEvent<HTMLDivElement>, port: PortId, isInput: boolean) => {
      event.stopPropagation();
      event.preventDefault();
      onWireStartDrag?.(event, node.id, port, isInput);
    },
  );

  const handleIfPortMouseUp = useStableCallback((event: MouseEvent<HTMLDivElement>, port: PortId) => {
    onWireEndDrag?.(event, node.id, port);
  });

  const ifConnected =
    connections.some((connection) => connection.inputNodeId === node.id && connection.inputId === IF_PORT.id) ||
    (draggingWire?.endNodeId === node.id && draggingWire?.endPortId === IF_PORT.id);

  return (
    <div className="node-title-ports conditional-if-port input-ports">
      <span className={clsx('conditional-if-port-label', { connected: ifConnected })}>if</span>
      <Port
        connected={ifConnected}
        connectionWarning={inputWarnings.has(IF_PORT.id)}
        draggingDataType={draggingWire?.dataType}
        canDragTo={draggingWire ? !draggingWire.startPortIsInput : false}
        closest={closestPortToDraggingWire?.nodeId === node.id && closestPortToDraggingWire.portId === IF_PORT.id}
        id={IF_PORT.id}
        definition={IF_PORT}
        nodeId={node.id}
        title="if"
        hideLabel
        input
        preservePortCase={preservePortTextCase}
        onMouseOver={onPortMouseOver}
        onMouseOut={onPortMouseOut}
        onMouseDown={handleIfPortMouseDown}
        onMouseUp={handleIfPortMouseUp}
      />
    </div>
  );
});

ConditionalIfPort.displayName = 'ConditionalIfPort';
