import { css } from '@emotion/react';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import clsx from 'clsx';
import {
  type CSSProperties,
  type FC,
  type MouseEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import { useCanvasNodeIO } from '../../hooks/useGetNodeIO.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { preservePortTextCaseState } from '../../state/settings.js';
import { sidebarOpenState } from '../../state/graphBuilder.js';
import { dataBusFullRowCountState, leftSidebarLiveWidthState } from '../../state/ui.js';
import { useAtomValue, useSetAtom } from 'jotai';
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
  getDataBusChannelKey,
  getDataBusInputChannelIndex,
  getDataBusOutputChannelIndex,
  getDataBusPortChannelIndexKey,
  type RenderableDataBusNode,
} from './dataBusModel.js';
import { DATA_BUS_FULL_ROW_HEIGHT_PX, shouldUseDataBusFullRow } from './dataBusRailLayout.js';

const railStyles = css`
  position: absolute;
  top: calc(46px * var(--ui-font-scale, 1));
  right: 0;
  left: var(--data-bus-full-row-left, 0px);
  z-index: 10002;
  display: flex;
  align-items: center;
  gap: calc(6px * var(--ui-font-scale, 1));
  box-sizing: border-box;
  width: max-content;
  max-width: calc(100% - var(--data-bus-full-row-left, 0px) - 32px);
  margin: 0 auto;
  padding: 0 calc(6px * var(--ui-font-scale, 1));
  overflow-x: auto;
  overflow-y: hidden;
  pointer-events: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  &.full-row {
    position: fixed;
    top: var(--project-selector-height);
    right: 0;
    left: var(--data-bus-full-row-left, 0px);
    box-sizing: border-box;
    width: auto;
    height: var(--data-bus-full-row-height, 0px);
    max-width: none;
    margin: 0;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 0;
    padding: 0;
    overflow: hidden;
    transform: none;
    background: transparent;
  }

  .data-bus-group {
    position: relative;
    display: flex;
    align-items: stretch;
    flex: 0 0 auto;
    min-width: 0;
    max-width: min(70vw, calc(760px * var(--ui-font-scale, 1)));
    overflow: hidden;
    border: 1px solid var(--app-panel-border, var(--grey));
    border-radius: calc(7px * var(--ui-font-scale, 1));
    background: var(--app-panel-bg, var(--grey-darkest));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
    color: var(--foreground);
  }

  &.full-row .data-bus-group {
    flex: 0 0 calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    width: 100%;
    height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    max-width: none;
    overflow: hidden;
    border: 0;
    border-bottom: 1px solid var(--app-panel-border, var(--grey));
    border-radius: 0;
    background: var(--app-panel-bg, var(--grey-darkest));
    box-shadow: none;
  }

  .data-bus-group-content {
    display: flex;
    align-items: stretch;
    flex: 1 1 auto;
    min-width: 0;
    margin-left: calc(3px * var(--ui-font-scale, 1));
    overflow: hidden;
  }

  &.full-row .data-bus-group-content {
    flex: 0 1 auto;
    width: max-content;
    max-width: calc(100% - 32px * var(--ui-font-scale, 1));
    height: 100%;
    margin: 0 auto;
  }

  &.full-row .data-bus-group.selected,
  &.full-row .data-bus-group.search-match:not(.selected),
  &.full-row .data-bus-group.compare-added,
  &.full-row .data-bus-group.compare-changed {
    border-color: transparent;
    box-shadow: none;
  }

  &.full-row .data-bus-group.selected {
    box-shadow: inset 0 -2px var(--primary);
  }

  &.full-row .data-bus-group.search-match:not(.selected) {
    box-shadow: inset 0 -1px color-mix(in srgb, var(--primary) 65%, transparent);
  }

  &.full-row .data-bus-group.compare-added:not(.selected) {
    box-shadow: inset 0 -2px var(--success);
  }

  &.full-row .data-bus-group.compare-changed:not(.selected) {
    box-shadow: inset 0 -2px var(--warning-light);
  }

  .data-bus-group::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: calc(3px * var(--ui-font-scale, 1));
    background: var(--bus-accent);
  }

  .data-bus-group.selected {
    border-color: var(--primary);
    box-shadow:
      0 0 0 1px var(--primary),
      0 2px 8px rgba(0, 0, 0, 0.24);
  }

  .data-bus-group.search-match:not(.selected) {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--app-panel-border, var(--grey)) 45%);
  }

  .data-bus-group.compare-added {
    border-color: var(--success);
  }

  .data-bus-group.compare-changed {
    border-color: var(--warning-light);
  }

  .data-bus-group.disabled {
    opacity: 0.58;
  }

  .data-bus-group.disabled .data-bus-group-title {
    text-decoration: line-through;
  }

  .data-bus-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 1 auto;
    gap: calc(5px * var(--ui-font-scale, 1));
    max-width: calc(220px * var(--ui-font-scale, 1));
    min-width: 0;
    min-height: calc(30px * var(--ui-font-scale, 1));
    padding: 0 calc(3px * var(--ui-font-scale, 1)) 0 calc(8px * var(--ui-font-scale, 1));
    border-right: 1px solid var(--app-panel-border, var(--grey));
    color: var(--foreground);
  }

  .data-bus-group-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-family);
    font-size: var(--ui-font-size-2xs);
    font-weight: 700;
    letter-spacing: 0.035em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .data-bus-settings {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: calc(22px * var(--ui-font-scale, 1));
    height: calc(22px * var(--ui-font-scale, 1));
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: currentColor;
    cursor: pointer;
    opacity: 0.72;
  }

  .data-bus-settings:hover,
  .data-bus-settings:focus-visible {
    background: rgba(255, 255, 255, 0.08);
    color: currentColor;
    opacity: 1;
    outline: none;
  }

  .data-bus-settings svg {
    width: calc(15px * var(--ui-font-scale, 1));
    height: calc(15px * var(--ui-font-scale, 1));
  }

  .data-bus-channels {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .data-bus-channels::-webkit-scrollbar {
    display: none;
  }

  .data-bus-channel,
  .data-bus-connect-provider {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto 16px;
    align-items: center;
    gap: calc(6px * var(--ui-font-scale, 1));
    min-height: calc(30px * var(--ui-font-scale, 1));
    padding: 0 calc(7px * var(--ui-font-scale, 1));
  }

  .data-bus-channel {
    flex: 0 0 auto;
    border-right: 1px solid color-mix(in srgb, var(--app-panel-border, var(--grey)) 65%, transparent);
  }

  .data-bus-channel:last-child {
    border-right: 0;
  }

  .data-bus-connect-provider {
    flex: 0 0 auto;
    border-left: 1px solid color-mix(in srgb, var(--app-panel-border, var(--grey)) 65%, transparent);
  }

  .data-bus-channel:hover,
  .data-bus-connect-provider:hover,
  .data-bus-channel.highlighted {
    background: rgba(255, 255, 255, 0.055);
  }

  .data-bus-channel.empty,
  .data-bus-connect-provider {
    grid-template-columns: 16px minmax(0, 1fr);
  }

  .data-bus-channel.missing-provider .data-bus-channel-label,
  .data-bus-channel.multiple-providers .data-bus-channel-label {
    color: var(--warning-light);
  }

  .data-bus-channel .port,
  .data-bus-connect-provider .port {
    z-index: 1;
  }

  .data-bus-channel .port-hover-area,
  .data-bus-connect-provider .port-hover-area {
    left: 50%;
    top: 50%;
  }

  .data-bus-channel .input-port,
  .data-bus-channel .output-port,
  .data-bus-connect-provider .input-port {
    margin: 0;
  }

  .data-bus-channel-label {
    max-width: calc(240px * var(--ui-font-scale, 1));
    min-width: 0;
    overflow: hidden;
    color: var(--foreground);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .data-bus-channel.empty .data-bus-channel-label,
  .data-bus-connect-provider .data-bus-channel-label {
    color: var(--foreground-dim);
    font-style: italic;
  }

  .data-bus-channel-usage {
    min-width: 18px;
    color: var(--foreground-dim);
    font-family: var(--font-family);
    font-size: var(--ui-font-size-2xs);
    text-align: right;
    white-space: nowrap;
  }
`;

const EMPTY_CONNECTIONS: readonly NodeConnection[] = [];

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

function getDataBusGroupContentWidths(rail: HTMLDivElement, uiFontScale: number): number[] {
  return [...rail.querySelectorAll<HTMLElement>('.data-bus-group')].map((group) => {
    const header = group.querySelector<HTMLElement>('.data-bus-group-header');
    const channels = group.querySelector<HTMLElement>('.data-bus-channels');
    const connectProvider = group.querySelector<HTMLElement>('.data-bus-connect-provider');
    const channelWidth = [...(channels?.children ?? [])].reduce(
      (width, channel) => width + (channel as HTMLElement).getBoundingClientRect().width,
      0,
    );

    // Include the accent strip and the two one-pixel borders. These widths are
    // stable in compact and full-row modes, unlike the group's constrained box.
    return 3 * uiFontScale + (header?.scrollWidth ?? 0) + channelWidth + (connectProvider?.scrollWidth ?? 0) + 2;
  });
}

export const DataBusRail: FC<{
  busNodes: readonly RenderableDataBusNode[];
  canvasHandlersContextValue: CanvasHandlersContextValue;
  canvasViewContextValue: CanvasViewContextValue;
  connections: readonly NodeConnection[];
  nodeCompareKindsById: Readonly<Record<NodeId, ProjectComparisonChangeKind | undefined>>;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
  searchMatchingNodeIds: readonly NodeId[];
  selectedNodeIds: readonly NodeId[];
}> = ({
  busNodes,
  canvasHandlersContextValue,
  canvasViewContextValue,
  connections,
  nodeCompareKindsById,
  nodesById,
  searchMatchingNodeIds,
  selectedNodeIds,
}) => {
  const railRef = useRef<HTMLDivElement>(null);
  const [fullRow, setFullRow] = useState(false);
  const setDataBusFullRowCount = useSetAtom(dataBusFullRowCountState);
  const leftSidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarLiveWidth = useAtomValue(leftSidebarLiveWidthState);

  useLayoutEffect(() => {
    const rail = railRef.current;

    if (!rail || busNodes.length === 0) {
      setFullRow(false);
      return;
    }

    const updateLayout = () => {
      const uiFontScale = Number.parseFloat(getComputedStyle(rail).getPropertyValue('--ui-font-scale')) || 1;
      const windowWidth = rail.ownerDocument.defaultView?.innerWidth ?? rail.parentElement?.clientWidth ?? 0;
      const viewportWidth = Math.max(0, windowWidth - (leftSidebarOpen ? leftSidebarLiveWidth : 0));
      const nextFullRow = shouldUseDataBusFullRow({
        groupContentWidths: getDataBusGroupContentWidths(rail, uiFontScale),
        uiFontScale,
        viewportWidth,
      });

      setFullRow((current) => (current === nextFullRow ? current : nextFullRow));
    };

    updateLayout();

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            updateLayout();
          });

    resizeObserver?.observe(rail.parentElement ?? rail);
    rail
      .querySelectorAll<HTMLElement>('.data-bus-group-header, .data-bus-channel, .data-bus-connect-provider')
      .forEach((element) => resizeObserver?.observe(element));
    rail.ownerDocument.defaultView?.addEventListener('resize', updateLayout);

    return () => {
      resizeObserver?.disconnect();
      rail.ownerDocument.defaultView?.removeEventListener('resize', updateLayout);
    };
  }, [busNodes, connections, leftSidebarLiveWidth, leftSidebarOpen]);

  useLayoutEffect(() => {
    setDataBusFullRowCount(fullRow ? busNodes.length : 0);
  }, [busNodes.length, fullRow, setDataBusFullRowCount]);

  useLayoutEffect(
    () => () => {
      setDataBusFullRowCount(0);
    },
    [setDataBusFullRowCount],
  );

  if (busNodes.length === 0) {
    return null;
  }

  const selectedNodeIdSet = new Set(selectedNodeIds);
  const searchMatchingNodeIdSet = new Set(searchMatchingNodeIds);

  return (
    <CanvasViewContext.Provider value={canvasViewContextValue}>
      <CanvasHandlersContext.Provider value={canvasHandlersContextValue}>
        <div
          ref={railRef}
          className={clsx('radio-data-bus-rail', { 'full-row': fullRow })}
          css={railStyles}
          aria-label="Canvas data buses"
          data-full-row={fullRow || undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onWheel={handleDataBusRailWheel}
        >
          {busNodes.map(({ editorNode, effectiveNode }) => (
            <DataBusGroup
              key={editorNode.id}
              connections={connections}
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
  connections: readonly NodeConnection[];
  editorNode: ChartNode;
  effectiveNode: RenderableDataBusNode['effectiveNode'];
  isSearchMatch: boolean;
  isSelected: boolean;
  nodesById: Readonly<Record<NodeId, ChartNode | undefined>>;
}> = ({ compareChangeKind, connections, editorNode, effectiveNode, isSearchMatch, isSelected, nodesById }) => {
  const { inputDefinitions, outputDefinitions } = useCanvasNodeIO(effectiveNode.id);
  const { onDataBusChannelHoverChange, onNodeSelected, onNodeStartEditing } = useCanvasHandlersContext();
  const { dataBusPortChannels, hoveredDataBusChannelKeys } = useCanvasViewContext();
  const hoveredChannelKeySet = new Set(hoveredDataBusChannelKeys);
  const nodeHeaderColor = getNodeHeaderColor(effectiveNode.visualData.color);
  const connectionsByPort = useMemo(() => {
    const incoming = new Map<PortId, NodeConnection[]>();
    const outgoing = new Map<PortId, NodeConnection[]>();

    for (const connection of connections) {
      if (connection.inputNodeId === effectiveNode.id) {
        const portConnections = incoming.get(connection.inputId) ?? [];
        portConnections.push(connection);
        incoming.set(connection.inputId, portConnections);
      }

      if (connection.outputNodeId === effectiveNode.id) {
        const portConnections = outgoing.get(connection.outputId) ?? [];
        portConnections.push(connection);
        outgoing.set(connection.outputId, portConnections);
      }
    }

    return { incoming, outgoing };
  }, [connections, effectiveNode.id]);

  const channels = inputDefinitions.flatMap((inputDefinition) => {
    const channelIndex = getDataBusInputChannelIndex(inputDefinition.id);

    if (channelIndex == null) {
      return [];
    }

    const outputDefinition = outputDefinitions.find(
      (candidate) => getDataBusOutputChannelIndex(candidate.id) === channelIndex,
    );
    const providers = connectionsByPort.incoming.get(inputDefinition.id) ?? EMPTY_CONNECTIONS;
    const consumerCount = outputDefinition
      ? (connectionsByPort.outgoing.get(outputDefinition.id) ?? EMPTY_CONNECTIONS).length
      : 0;
    const relatedChannelKeys = new Set(
      [
        ...(dataBusPortChannels.get(
          getDataBusPortChannelIndexKey({
            input: true,
            nodeId: effectiveNode.id,
            portId: inputDefinition.id,
          }),
        ) ?? []),
        ...(outputDefinition
          ? dataBusPortChannels.get(
              getDataBusPortChannelIndexKey({
                input: false,
                nodeId: effectiveNode.id,
                portId: outputDefinition.id,
              }),
            ) ?? []
          : []),
      ].map((channel) => channel.channelKey),
    );

    return [
      {
        channelIndex,
        consumerCount,
        inputDefinition,
        outputDefinition,
        providers,
        relatedChannelKeys: [...relatedChannelKeys],
      },
    ];
  });
  const connectProviderChannel = channels.find(({ outputDefinition }) => !outputDefinition);
  const dataChannels = channels.filter((channel) => channel !== connectProviderChannel);

  const handleOpenSettings = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onNodeSelected?.(editorNode, false);
    onNodeStartEditing?.(editorNode);
  };

  const renderChannel = (
    {
      channelIndex,
      consumerCount,
      inputDefinition,
      outputDefinition,
      providers,
      relatedChannelKeys,
    }: (typeof channels)[number],
    connectProvider: boolean,
  ) => {
    const channelKey = getDataBusChannelKey(effectiveNode.id, channelIndex);
    const isEmpty = providers.length === 0 && !outputDefinition;

    return (
      <div
        className={clsx(connectProvider ? 'data-bus-connect-provider' : 'data-bus-channel', {
          empty: isEmpty,
          highlighted: !connectProvider && hoveredChannelKeySet.has(channelKey),
          'missing-provider': providers.length === 0 && !!outputDefinition,
          'multiple-providers': providers.length > 1,
        })}
        key={channelKey}
        onMouseEnter={
          connectProvider ? undefined : () => onDataBusChannelHoverChange?.([channelKey, ...relatedChannelKeys])
        }
        onMouseLeave={connectProvider ? undefined : () => onDataBusChannelHoverChange?.([])}
      >
        <DataBusPort definition={inputDefinition} input connected={providers.length > 0} nodeId={effectiveNode.id} />
        <span className="data-bus-channel-label">
          {connectProvider ? (
            'Connect provider'
          ) : providers.length > 1 ? (
            <span title="Disconnect providers until only one remains.">Multiple providers ({providers.length})</span>
          ) : providers[0] ? (
            <ProviderLabel connection={providers[0]} nodesById={nodesById} />
          ) : outputDefinition ? (
            `Missing provider / Input ${channelIndex}`
          ) : (
            'Connect provider'
          )}
        </span>
        {outputDefinition && (
          <>
            <span className="data-bus-channel-usage" title={`${consumerCount} connected receiver(s)`}>
              {consumerCount}
            </span>
            <DataBusPort definition={outputDefinition} connected={consumerCount > 0} nodeId={effectiveNode.id} />
          </>
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
          <Tooltip content="Open Passthrough settings" tag="span">
            <button
              className="data-bus-settings"
              type="button"
              aria-label={`Open settings for ${effectiveNode.title}`}
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
  const label = `${sourceNode?.title ?? 'Missing node'} / ${outputDefinition?.title ?? connection.outputId}`;

  return <span title={label}>{label}</span>;
};

const DataBusPort: FC<{
  connected: boolean;
  definition: NodeInputDefinition | NodeOutputDefinition;
  input?: boolean;
  nodeId: NodeId;
}> = ({ connected, definition, input = false, nodeId }) => {
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
  );
};
