import {
  type DataType,
  type NodeInputDefinition,
  type NodeId,
  type PortId,
  type NodeOutputDefinition,
} from '@valerypopoff/rivet2-core';
import { type FC, useRef, type MouseEvent, memo, useMemo } from 'react';
import clsx from 'clsx';
import { useStableCallback } from '../hooks/useStableCallback';
import { getPortCompatibilityStatus } from '../domain/graphEditing/portCompatibility.js';

export function canStartWireDragFromPortLabel(input: boolean): boolean {
  return !input;
}

export function isPrimaryPortMouseButton(button: number): boolean {
  return button === 0;
}

export const Port: FC<{
  input?: boolean;
  title: string;
  hideLabel?: boolean;
  nodeId: NodeId;
  id: PortId;
  connected?: boolean;
  canDragTo: boolean;
  closest: boolean;
  preservePortCase?: boolean;
  definition: NodeInputDefinition | NodeOutputDefinition;
  draggingDataType?: DataType | Readonly<DataType[]>;
  reorderable?: boolean;
  reorderDragging?: boolean;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>, port: PortId, isInput: boolean) => void;
  onMouseUp?: (event: MouseEvent<HTMLDivElement>, port: PortId) => void;
  onMouseOver?: (
    event: MouseEvent<HTMLDivElement>,
    nodeId: NodeId,
    isInput: boolean,
    portId: PortId,
    definition: NodeInputDefinition | NodeOutputDefinition,
  ) => void;
  onMouseOut?: (
    event: MouseEvent<HTMLDivElement>,
    nodeId: NodeId,
    isInput: boolean,
    portId: PortId,
    definition: NodeInputDefinition | NodeOutputDefinition,
  ) => void;
  onReorderMouseDown?: (event: MouseEvent<HTMLDivElement>, port: PortId, isInput: boolean, title: string) => void;
  dataBusAntenna?: {
    count: number;
    label: string;
    revealed: boolean;
  };
  onDataBusAntennaHoverChange?: (hovered: boolean) => void;
}> = memo(
  ({
    input = false,
    title,
    hideLabel = false,
    nodeId,
    id,
    connected,
    canDragTo,
    closest,
    definition,
    draggingDataType,
    reorderable = false,
    reorderDragging = false,
    onMouseDown,
    onMouseUp,
    onMouseOver,
    onMouseOut,
    onReorderMouseDown,
    preservePortCase,
    dataBusAntenna,
    onDataBusAntennaHoverChange,
  }) => {
    const ref = useRef<HTMLDivElement>(null);

    const handleMouseOver = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('.port-hover-area')) {
        return;
      }
      onMouseOver?.(event, nodeId, input, id, definition);
    });

    const handleMouseOut = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('.port-hover-area')) {
        return;
      }
      onMouseOut?.(event, nodeId, input, id, definition);
    });

    const handleLabelMouseDown = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
      if (!isPrimaryPortMouseButton(event.button)) {
        return;
      }

      if (reorderable) {
        event.stopPropagation();
        event.preventDefault();
        onReorderMouseDown?.(event, id, input, title);
        return;
      }

      if (!canStartWireDragFromPortLabel(input)) {
        return;
      }

      onMouseDown?.(event, id, input);
    });

    const definitionAsNodeInputDefinition = definition as NodeInputDefinition;
    const accepted = useMemo(() => {
      const status = getPortCompatibilityStatus({
        draggingDataType,
        portDataType: definition.dataType,
        canCoerce: definitionAsNodeInputDefinition.coerced ?? true,
        isInput: input,
      });

      if (status === 'none') {
        return '';
      }

      return status;
    }, [draggingDataType, definition.dataType, definitionAsNodeInputDefinition.coerced, input]);

    return (
      <div
        key={id}
        className={clsx(
          'port',
          {
            connected,
            closest,
            reorderable,
            'reorder-dragging-source': reorderDragging,
          },
          accepted,
        )}
        data-reorder-nodeid={reorderable ? nodeId : undefined}
        data-reorder-portid={reorderable ? id : undefined}
        data-reorder-portside={reorderable ? (input ? 'input' : 'output') : undefined}
        onMouseEnter={() => dataBusAntenna && onDataBusAntennaHoverChange?.(true)}
        onMouseLeave={() => dataBusAntenna && onDataBusAntennaHoverChange?.(false)}
        title={dataBusAntenna?.label}
      >
        <div
          ref={ref}
          className={clsx('port-circle', { 'input-port': input, 'output-port': !input })}
          onMouseDown={(e) => {
            if (!isPrimaryPortMouseButton(e.button)) {
              return;
            }

            return onMouseDown?.(e, id, input);
          }}
          onMouseUp={(e) => {
            if (!isPrimaryPortMouseButton(e.button)) {
              return;
            }

            onMouseUp?.(e, id);
          }}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
          data-portid={id}
          data-porttype={input ? 'input' : 'output'}
          data-nodeid={nodeId}
        >
          {dataBusAntenna && !dataBusAntenna.revealed && (
            <>
              <svg
                aria-hidden="true"
                className={clsx('data-bus-antenna', input ? 'input' : 'output')}
                viewBox="0 0 24 24"
              >
                <path d={input ? 'M24 12H15L3 2' : 'M0 12H9L21 2'} />
              </svg>
              {dataBusAntenna.count > 1 && <span className="data-bus-antenna-count">{dataBusAntenna.count}</span>}
            </>
          )}
          {canDragTo && <div className={clsx('port-hover-area')} />}
        </div>
        {!hideLabel && (
          <div
            className={clsx('port-label', preservePortCase ? '' : 'port-label-uppercase')}
            onMouseDown={handleLabelMouseDown}
            onMouseOver={handleMouseOver}
            onMouseOut={handleMouseOut}
          >
            {title}
          </div>
        )}
      </div>
    );
  },
);

Port.displayName = 'Port';
