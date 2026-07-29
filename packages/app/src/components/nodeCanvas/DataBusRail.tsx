import {
  isNodePrefabInstanceNode,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import clsx from 'clsx';
import { type CSSProperties, type FC, type MouseEvent, useMemo, type WheelEvent } from 'react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import { useCanvasNodeIO } from '../../hooks/useGetNodeIO.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { preservePortTextCaseState } from '../../state/settings.js';
import { useAtomValue } from 'jotai';
import { getNodeHeaderColor } from '../../utils/nodeColor.js';
import {
  CanvasHandlersContext,
  CanvasViewContext,
  useCanvasHandlersContext,
  useCanvasViewContext,
} from '../CanvasContext.js';
import type { CanvasHandlersContextValue, CanvasViewContextValue } from '../CanvasContext.js';
import { Port } from '../Port.js';
import { Tooltip } from '../Tooltip.js';
import {
  buildDataBusGroupPresentation,
  type DataBusChannelPresentation,
  type DataBusTopology,
  type RenderableDataBusNode,
} from './dataBusModel.js';
import { dataBusRailStyles } from './dataBusRailStyles.js';
import { useDataBusRailLayout } from './useDataBusRailLayout.js';

function handleDataBusRailWheel(event: WheelEvent<HTMLDivElement>): void {
  event.stopPropagation();

  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
    return;
  }

  const channelScroller = (event.target as HTMLElement).closest<HTMLElement>('.data-bus-channels');
  const scrollTarget =
    channelScroller && channelScroller.scrollWidth > channelScroller.clientWidth
      ? channelScroller
      : event.currentTarget;

  if (scrollTarget.scrollWidth > scrollTarget.clientWidth) {
    event.preventDefault();
    scrollTarget.scrollLeft += event.deltaY;
  }
}

export const DataBusRail: FC<{
  busNodes: readonly RenderableDataBusNode[];
  canvasHandlersContextValue: CanvasHandlersContextValue;
  canvasViewContextValue: CanvasViewContextValue;
  dataBusTopology: DataBusTopology;
  nodeCompareKindsById: Readonly<Record<NodeId, ProjectComparisonChangeKind | undefined>>;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  searchMatchingNodeIds: readonly NodeId[];
  selectedNodeIds: readonly NodeId[];
}> = ({
  busNodes,
  canvasHandlersContextValue,
  canvasViewContextValue,
  dataBusTopology,
  nodeCompareKindsById,
  nodesById,
  searchMatchingNodeIds,
  selectedNodeIds,
}) => {
  useDataBusRailLayout(busNodes.length);

  if (busNodes.length === 0) {
    return null;
  }

  const selectedNodeIdSet = new Set(selectedNodeIds);
  const searchMatchingNodeIdSet = new Set(searchMatchingNodeIds);

  return (
    <CanvasViewContext.Provider value={canvasViewContextValue}>
      <CanvasHandlersContext.Provider value={canvasHandlersContextValue}>
        <div
          className="radio-data-bus-rail"
          css={dataBusRailStyles}
          aria-label="Canvas data buses"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onWheel={handleDataBusRailWheel}
        >
          {busNodes.map(({ editorNode, effectiveNode }) => (
            <DataBusGroup
              key={editorNode.id}
              dataBusTopology={dataBusTopology}
              editorNode={editorNode}
              effectiveNode={effectiveNode}
              isSearchMatch={searchMatchingNodeIdSet.has(editorNode.id)}
              isSelected={selectedNodeIdSet.has(editorNode.id)}
              nodesById={nodesById}
              compareChangeKind={nodeCompareKindsById[editorNode.id]}
            />
          ))}
        </div>
      </CanvasHandlersContext.Provider>
    </CanvasViewContext.Provider>
  );
};

const DataBusGroup: FC<{
  compareChangeKind: ProjectComparisonChangeKind | undefined;
  dataBusTopology: DataBusTopology;
  editorNode: ChartNode;
  effectiveNode: RenderableDataBusNode['effectiveNode'];
  isSearchMatch: boolean;
  isSelected: boolean;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}> = ({ compareChangeKind, dataBusTopology, editorNode, effectiveNode, isSearchMatch, isSelected, nodesById }) => {
  const { inputDefinitions, outputDefinitions } = useCanvasNodeIO(effectiveNode.id);
  const { onDataBusChannelHoverChange, onNodeSelected, onNodeStartEditing } = useCanvasHandlersContext();
  const { hoveredDataBusChannelKeys } = useCanvasViewContext();
  const hoveredChannelKeySet = new Set(hoveredDataBusChannelKeys);
  const nodeHeaderColor = getNodeHeaderColor(effectiveNode.visualData.color);
  const settingsActionLabel = isNodePrefabInstanceNode(editorNode) ? 'Open library node' : 'Open Data Bus settings';
  const { connectProviderChannel, dataChannels } = useMemo(
    () =>
      buildDataBusGroupPresentation({
        busNode: effectiveNode,
        inputDefinitions,
        outputDefinitions,
        topology: dataBusTopology,
      }),
    [dataBusTopology, effectiveNode, inputDefinitions, outputDefinitions],
  );

  const handleOpenSettings = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onNodeSelected?.(editorNode, false);
    onNodeStartEditing?.(editorNode);
  };

  const renderChannel = (
    {
      channelKey,
      channelIndex,
      consumerCount,
      inputDefinition,
      outputDefinition,
      providerConnections,
      relatedChannelKeys,
    }: DataBusChannelPresentation,
    connectProvider: boolean,
  ) => {
    const isEmpty = providerConnections.length === 0 && !outputDefinition;

    return (
      <div
        className={clsx(connectProvider ? 'data-bus-connect-provider' : 'data-bus-channel', {
          empty: isEmpty,
          highlighted: !connectProvider && hoveredChannelKeySet.has(channelKey),
          'missing-provider': providerConnections.length === 0 && !!outputDefinition,
          'multiple-providers': providerConnections.length > 1,
        })}
        key={channelKey}
        onMouseEnter={
          connectProvider ? undefined : () => onDataBusChannelHoverChange?.([channelKey, ...relatedChannelKeys])
        }
        onMouseLeave={connectProvider ? undefined : () => onDataBusChannelHoverChange?.([])}
      >
        <DataBusPort
          definition={inputDefinition}
          input
          connected={providerConnections.length > 0}
          nodeId={effectiveNode.id}
        />
        <span className="data-bus-channel-label">
          {connectProvider ? (
            'Connect provider'
          ) : providerConnections.length > 1 ? (
            <span title="Disconnect providers until only one remains.">
              Multiple providers ({providerConnections.length})
            </span>
          ) : providerConnections[0] ? (
            <ProviderLabel connection={providerConnections[0]} nodesById={nodesById} />
          ) : outputDefinition ? (
            `Missing provider / Input ${channelIndex}`
          ) : (
            'Connect provider'
          )}
        </span>
        {outputDefinition && (
          <DataBusPort
            connected={consumerCount > 0}
            connectionCount={consumerCount}
            definition={outputDefinition}
            nodeId={effectiveNode.id}
          />
        )}
      </div>
    );
  };

  return (
    <section
      className={clsx('data-bus-group', {
        selected: isSelected,
        'search-match': isSearchMatch,
        'compare-added': compareChangeKind === 'added',
        'compare-changed': compareChangeKind === 'changed',
        disabled: effectiveNode.disabled,
      })}
      style={
        {
          '--bus-accent': nodeHeaderColor,
        } as CSSProperties
      }
      onMouseDown={(event) => {
        if (event.button === 0 && event.shiftKey) {
          event.stopPropagation();
          onNodeSelected?.(editorNode, true);
        }
      }}
    >
      <div className="data-bus-group-content">
        <header className="data-bus-group-header">
          <span className="data-bus-group-title" title={effectiveNode.title}>
            {effectiveNode.title}
          </span>
          <Tooltip content={settingsActionLabel} tag="span">
            <button
              className="data-bus-settings"
              type="button"
              aria-label={`${settingsActionLabel} for ${effectiveNode.title}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleOpenSettings}
            >
              <SettingsCogIcon />
            </button>
          </Tooltip>
        </header>
        <div className="data-bus-channels">{dataChannels.map((channel) => renderChannel(channel, false))}</div>
        {connectProviderChannel && renderChannel(connectProviderChannel, true)}
      </div>
    </section>
  );
};

const ProviderLabel: FC<{
  connection: NodeConnection;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}> = ({ connection, nodesById }) => {
  const { outputDefinitions } = useCanvasNodeIO(connection.outputNodeId);
  const sourceNode = nodesById[connection.outputNodeId];
  const outputDefinition = outputDefinitions.find((candidate) => candidate.id === connection.outputId);
  const sourceLabel = sourceNode?.title ?? 'Missing node';
  const outputLabel = outputDefinition?.title ?? connection.outputId;
  const label = `${sourceLabel} / ${outputLabel}`;

  return (
    <span className="data-bus-provider-label" title={label} aria-label={label}>
      <span className="data-bus-provider-source">{sourceLabel}</span>
      <span className="data-bus-provider-output">{outputLabel}</span>
    </span>
  );
};

const DataBusPort: FC<{
  connected: boolean;
  connectionCount?: number;
  definition: NodeInputDefinition | NodeOutputDefinition;
  input?: boolean;
  nodeId: NodeId;
}> = ({ connected, connectionCount, definition, input = false, nodeId }) => {
  const { draggingWire, closestPortToDraggingWire } = useCanvasViewContext();
  const { onPortMouseOut, onPortMouseOver, onWireEndDrag, onWireStartDrag } = useCanvasHandlersContext();
  const preservePortTextCase = useAtomValue(preservePortTextCaseState);
  const portId = definition.id as PortId;

  const handlePortMouseDown = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onWireStartDrag?.(event, nodeId, portId, input);
  });

  const handlePortMouseUp = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
    onWireEndDrag?.(event, nodeId, portId);
  });

  return (
    <div
      className={clsx('data-bus-channel-port', input ? 'input' : 'output', {
        connected,
      })}
    >
      <Port
        canDragTo={draggingWire ? (input ? !draggingWire.startPortIsInput : draggingWire.startPortIsInput) : false}
        closest={closestPortToDraggingWire?.nodeId === nodeId && closestPortToDraggingWire.portId === portId}
        connected={
          connected ||
          (input
            ? draggingWire?.endNodeId === nodeId && draggingWire.endPortId === portId
            : draggingWire?.startNodeId === nodeId && draggingWire.startPortId === portId)
        }
        definition={definition}
        draggingDataType={draggingWire?.dataType}
        hideLabel
        id={portId}
        input={input}
        nodeId={nodeId}
        onMouseDown={handlePortMouseDown}
        onMouseOut={onPortMouseOut}
        onMouseOver={onPortMouseOver}
        onMouseUp={handlePortMouseUp}
        preservePortCase={preservePortTextCase}
        title={definition.title}
      />
      {connectionCount !== undefined && (
        <span
          className={clsx('data-bus-channel-port-count', {
            'two-digits': connectionCount >= 10,
            'three-or-more-digits': connectionCount >= 100,
          })}
        >
          {connectionCount}
        </span>
      )}
    </div>
  );
};
