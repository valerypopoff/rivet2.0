import clsx from 'clsx';
import { type FC, type HTMLAttributes, type MouseEvent, type PointerEvent, memo } from 'react';
import { type ChartNode, type NodeConnection } from '@valerypopoff/rivet2-core';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { NodePortsRenderer } from '../NodePorts.js';
import { useDependsOnPlugins } from '../../hooks/useDependsOnPlugins';
import { useCanvasHandlersContext } from '../CanvasContext';
import { SubGraphHeaderLink } from './SubGraphHeaderLink.js';
import { SplitRunSummary } from './SplitRunSummary.js';
import { NodeRunningIndicator } from './NodeRunningIndicator.js';
import { NodeTitleLabel } from './NodeTitleLabel.js';
import { Tooltip } from '../Tooltip.js';
import { NodeHeaderWarningIcon } from './NodeHeaderWarningIcon.js';
import { ConditionalIfPort } from './ConditionalIfPort.js';
import { SubgraphLinkIcon } from './SubgraphLinkIcon.js';

export const ZoomedOutVisualNodeContent: FC<{
  node: ChartNode;
  connections?: NodeConnection[];
  handleAttributes?: HTMLAttributes<HTMLDivElement>;
  isKnownNodeType: boolean;
  isReallyZoomedOut: boolean;
  showRunningIndicator: boolean;
  headerWarning?: string;
  editTargetNode?: ChartNode;
  isNodePrefabInstance?: boolean;
}> = memo(
  ({
    node,
    connections = [],
    handleAttributes,
    isKnownNodeType,
    isReallyZoomedOut,
    showRunningIndicator,
    headerWarning,
    editTargetNode,
    isNodePrefabInstance = false,
  }) => {
    useDependsOnPlugins();
    const { onNodeSelected, onNodeStartEditing } = useCanvasHandlersContext();

    const handleEditClick = useStableCallback((event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onNodeStartEditing?.(editTargetNode ?? node);
    });

    const handleEditMouseDown = useStableCallback((event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
    });

    const handleEditPointerDown = useStableCallback((event: PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    });

    const handleGrabClick = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.currentTarget.closest<HTMLElement>('.node')?.blur();
      onNodeSelected?.(node, event.shiftKey);
    });

    const nodeDescription = node.description?.trim();

    return (
      <>
        <div
          className={clsx('node-title', { grabbable: !isReallyZoomedOut })}
          {...(isReallyZoomedOut ? {} : handleAttributes)}
          onClick={isReallyZoomedOut ? undefined : handleGrabClick}
        >
          {!isReallyZoomedOut && (
            <div className={clsx('grab-area', { 'has-subgraph-header-link': node.type === 'subGraph' })}>
              <SubGraphHeaderLink node={node} />
              <div className="title-text">
                <NodeTitleLabel node={node} />
                {nodeDescription && <span className="title-text-description">{nodeDescription}</span>}
                <SplitRunSummary node={node} editTargetNode={editTargetNode} isKnownNodeType={isKnownNodeType} />
              </div>
            </div>
          )}
          {!isReallyZoomedOut && (
            <div className="title-controls">
              <NodeRunningIndicator isRunning={showRunningIndicator} delayMs={0} />
              {isNodePrefabInstance && (
                <Tooltip className="node-prefab-instance-tooltip" content="Open library node">
                  <button
                    type="button"
                    className="node-prefab-instance-indicator"
                    aria-label="Open library node"
                    onClick={handleEditClick}
                    onPointerDown={handleEditPointerDown}
                    onMouseDown={handleEditMouseDown}
                  >
                    <SubgraphLinkIcon />
                  </button>
                </Tooltip>
              )}
              {headerWarning && (
                <Tooltip className="node-header-warning-tooltip" content={headerWarning} tag="span" wrap width={260}>
                  <span className="node-header-warning" role="img" aria-label={headerWarning}>
                    <NodeHeaderWarningIcon />
                  </span>
                </Tooltip>
              )}
              {!isNodePrefabInstance && (
                <button
                  type="button"
                  className="edit-button"
                  onClick={handleEditClick}
                  onPointerDown={handleEditPointerDown}
                  onMouseDown={handleEditMouseDown}
                  title="Edit"
                >
                  <SettingsCogIcon />
                </button>
              )}
            </div>
          )}
        </div>

        {node.isConditional && <ConditionalIfPort node={node} connections={connections} />}

        {isKnownNodeType && <NodePortsRenderer node={node} connections={connections} zoomedOut />}
      </>
    );
  },
);

ZoomedOutVisualNodeContent.displayName = 'ZoomedOutVisualNodeContent';
