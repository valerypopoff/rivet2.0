import clsx from 'clsx';
import { type CSSProperties, type HTMLAttributes, type MouseEvent, forwardRef, memo, useMemo } from 'react';
import {
  type ChartNode,
  type CommentNode,
  type NodeConnection,
  type ProjectComparisonChangeKind,
  canUseNodeAsPrefabSource,
  getNodePrefabInstancePrefabId,
  isNodePrefabInstanceNode,
  resolveNodePrefabInstance,
} from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins';
import { useHistoricalNodeChangeInfo } from '../hooks/useHistoricalNodeChangeInfo';
import { useNodePortLabelMinWidth } from '../hooks/useNodePortLabelMinWidth';
import { type ProcessDataForNode, frozenNodeOutputsState, resolvedGraphSelectionState } from '../state/dataFlow.js';
import {
  getNodeExecutionClassFlags,
  getSelectedProcessRun,
  hasRunningProcessData,
} from '../state/selectors/executionSelectors.js';
import { getSplitStackGhostColors } from '../utils/nodeSplitStackColors.js';
import {
  getNodeBorderReferenceColor,
  getNodeHeaderColor,
  getNodeHeaderForegroundColor,
  isNodeBorderVisible,
} from '../utils/nodeColor.js';
import { useCanvasHandlersContext, useCanvasViewContext } from './CanvasContext';
import { ZoomedOutVisualNodeContent } from './visualNode/ZoomedOutVisualNodeContent';
import { NormalVisualNodeContent } from './visualNode/NormalVisualNodeContent';
import { getCanvasCommentHeight } from '../hooks/canvasVisibilityBounds.js';
import { useDelayedRunningState } from './visualNode/NodeRunningIndicator.js';
import { graphMetadataState } from '../state/graph.js';
import { useExecutorSessionState } from '../hooks/useExecutorSession.js';
import { getMissingStaticSetGlobalWarning } from '../domain/graphEditing/globalVariables.js';
import { enabledStaticGlobalVariableIdsState } from '../state/selectors/globalVariables.js';
import { getDuplicateGraphOutputIdWarning } from '../domain/graphEditing/graphOutputs.js';
import { duplicateGraphOutputIdsState } from '../state/selectors/graphOutputs.js';
import { getRecursiveSubGraphWarning } from '../domain/graphEditing/subGraphs.js';
import { projectState } from '../state/savedGraphs.js';
import { graphState } from '../state/atoms/graph.js';
import {
  getDuplicateToolNodeIds,
  getMissingAutoDelegateToolGraphWarnings,
  getToolNodeHeaderWarning,
} from '../domain/graphEditing/toolWarnings.js';
import { combineNodeHeaderWarnings } from '../domain/graphEditing/disabledNodeWarnings.js';
import { disabledUpstreamInputWarningsState } from '../state/selectors/ioDefinitions.js';

export type VisualNodeProps = {
  node: ChartNode;
  compareChangeKind?: ProjectComparisonChangeKind;
  connections?: NodeConnection[];
  xDelta?: number;
  yDelta?: number;
  isDragging?: boolean;
  isOverlay?: boolean;
  isSelected?: boolean;
  isHovered?: boolean;
  isSearchMatch?: boolean;
  isKnownNodeType: boolean;
  isOutputExpanded: boolean;
  shouldShowHoverControls?: boolean;
  lastRun?: ProcessDataForNode[];
  processPage: number | 'latest';
  renderHeavyContent: boolean;
  renderSkeleton?: boolean;
  nodeAttributes?: HTMLAttributes<HTMLDivElement>;
  handleAttributes?: HTMLAttributes<HTMLDivElement>;
};

type VisualNodeImplProps = VisualNodeProps & {
  headerWarning?: string;
  editTargetNode?: ChartNode;
  isNodePrefabInstance?: boolean;
};

const VisualNodeImpl = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>(
    (
      {
        node,
        compareChangeKind,
        connections = [],
        handleAttributes,
        nodeAttributes,
        xDelta = 0,
        yDelta = 0,
        isDragging,
        isOverlay,
        isSelected,
        isHovered,
        isSearchMatch,
        isKnownNodeType,
        isOutputExpanded,
        shouldShowHoverControls,
        lastRun,
        processPage,
        renderHeavyContent,
        renderSkeleton,
        headerWarning,
        editTargetNode,
        isNodePrefabInstance = false,
      },
      ref,
    ) => {
      const { graphStateOverlaysEnabled, heightCache, isReallyZoomedOut, isZoomedOut } = useCanvasViewContext();
      const { onNodeMouseEnter, onNodeMouseLeave, onNodeStartEditing } = useCanvasHandlersContext();
      const isComment = node.type === 'comment';
      const effectiveIsZoomedOut = isZoomedOut && !isComment;
      const effectiveIsReallyZoomedOut = isReallyZoomedOut && !isComment;
      const commentHeight = isComment ? getCanvasCommentHeight(node as CommentNode) : undefined;
      const minimumNodeWidth = useNodePortLabelMinWidth(node);
      const changeInfo = useHistoricalNodeChangeInfo(node.id);
      const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
      const frozenNodeOutputs = useAtomValue(frozenNodeOutputsState);
      const graphId = useAtomValue(graphMetadataState)?.id;
      const executorSession = useExecutorSessionState();
      const nodeColor = node.visualData.color;
      const disabledUpstreamInputWarnings = useAtomValue(disabledUpstreamInputWarningsState);
      const combinedHeaderWarning = combineNodeHeaderWarnings(
        headerWarning,
        disabledUpstreamInputWarnings.get(editTargetNode?.id ?? node.id),
      );
      const isOutputPreviewHovered = Boolean(isHovered || shouldShowHoverControls);
      const isHistoricalChanged = changeInfo != null && changeInfo.changed && !!changeInfo.before && !!changeInfo.after;
      const staticHeaderControlCount =
        Number(isHistoricalChanged) +
        Number(Boolean(combinedHeaderWarning)) +
        Number(isNodePrefabInstance) +
        Number(graphId != null && compareChangeKind === 'changed') +
        Number(node.type === 'delegateFunctionCall');

      useDependsOnPlugins();

      const style = useMemo(() => {
        const bgColor = getNodeHeaderColor(nodeColor);
        const borderColor = getNodeBorderReferenceColor(nodeColor);
        const splitStackGhostColors = getSplitStackGhostColors(bgColor);
        const fgColor = getNodeHeaderForegroundColor(bgColor);

        return {
          opacity: isDragging ? '0' : '',
          transform: `translate(${node.visualData.x + xDelta}px, ${node.visualData.y + yDelta}px) scale(1)`,
          zIndex: isComment ? -10000 : node.visualData.zIndex ?? 0,
          width: node.visualData.width,
          minWidth: isComment || effectiveIsZoomedOut ? undefined : minimumNodeWidth,
          height: commentHeight,
          '--node-bg': bgColor,
          '--node-border': borderColor,
          '--node-bg-foreground': fgColor,
          '--node-stack-front-bg': splitStackGhostColors.frontBackground,
          '--node-stack-back-bg': splitStackGhostColors.backBackground,
          '--node-title-header-padding': `calc(${66 + 30 * staticHeaderControlCount}px * var(--ui-font-scale))`,
        } as CSSProperties;
      }, [
        commentHeight,
        effectiveIsZoomedOut,
        isComment,
        isDragging,
        minimumNodeWidth,
        nodeColor,
        node.visualData.width,
        node.visualData.x,
        node.visualData.y,
        node.visualData.zIndex,
        staticHeaderControlCount,
        xDelta,
        yDelta,
      ]);

      const selectedProcessRun = graphStateOverlaysEnabled
        ? getSelectedProcessRun(lastRun, processPage, graphSelectionOptions)
        : undefined;
      const executionClassFlags = getNodeExecutionClassFlags(selectedProcessRun);
      const showRunningChrome = useDelayedRunningState(
        graphStateOverlaysEnabled && hasRunningProcessData(lastRun, graphSelectionOptions),
      );
      const showFrozenState = graphStateOverlaysEnabled && executorSession.target?.type !== 'external-debugger';
      const isFrozen = showFrozenState && Boolean(graphId && frozenNodeOutputs[graphId]?.[node.id]?.length);
      const nodeForEditing = editTargetNode ?? node;

      if (renderSkeleton) {
        return <div className="node-skeleton" style={style} {...nodeAttributes} />;
      }

      const changedClass = changeInfo
        ? changeInfo.changed
          ? !changeInfo.before && changeInfo.after
            ? 'changed-added'
            : 'changed'
          : 'not-changed'
        : '';
      return (
        <div
          className={clsx(
            'node',
            {
              overlayNode: isOverlay,
              selected: isSelected,
              hovered: isHovered,
              hasCustomBorderColor: isNodeBorderVisible(nodeColor),
              searchMatch: isSearchMatch,
              dragging: isDragging,
              runningGlow: showRunningChrome,
              showHoverControls: shouldShowHoverControls,
              ...executionClassFlags,
              zoomedOut: effectiveIsZoomedOut,
              isComment,
              isOutputExpanded,
              isSplit: node.isSplitRun,
              frozen: isFrozen,
              disabled: node.disabled,
              conditional: !!node.isConditional,
              hasPrefabIndicator: isNodePrefabInstance,
              hasHeaderWarning: Boolean(combinedHeaderWarning),
              hasCompareChange: compareChangeKind === 'changed',
              [`compare-${compareChangeKind}`]: compareChangeKind && compareChangeKind !== 'unchanged',
            },
            changedClass,
          )}
          ref={ref}
          style={style}
          {...nodeAttributes}
          data-nodeid={node.id}
          data-contextmenutype={`node-${node.type}`}
          onMouseEnter={(event: MouseEvent<HTMLElement>) => {
            onNodeMouseEnter?.(event, node.id);
          }}
          onMouseLeave={(event: MouseEvent<HTMLElement>) => {
            onNodeMouseLeave?.(event, node.id);
          }}
          onDoubleClick={(event) => {
            if (isKnownNodeType) {
              event.currentTarget.blur();
              onNodeStartEditing?.(nodeForEditing);
            }
          }}
        >
          {effectiveIsZoomedOut ? (
            <ZoomedOutVisualNodeContent
              node={node}
              connections={connections}
              handleAttributes={handleAttributes}
              isKnownNodeType={isKnownNodeType}
              isReallyZoomedOut={effectiveIsReallyZoomedOut}
              showRunningIndicator={showRunningChrome}
              headerWarning={combinedHeaderWarning}
              editTargetNode={nodeForEditing}
              isNodePrefabInstance={isNodePrefabInstance}
            />
          ) : (
            <NormalVisualNodeContent
              heightCache={heightCache}
              node={node}
              connections={connections}
              handleAttributes={handleAttributes}
              isKnownNodeType={isKnownNodeType}
              isHistoricalChanged={isHistoricalChanged}
              isOutputPreviewHovered={isOutputPreviewHovered}
              isFrozen={isFrozen}
              showRunningIndicator={showRunningChrome}
              renderHeavyContent={renderHeavyContent}
              minimumNodeWidth={minimumNodeWidth}
              headerWarning={combinedHeaderWarning}
              compareChangeKind={compareChangeKind}
              graphId={graphId}
              editTargetNode={nodeForEditing}
              isNodePrefabInstance={isNodePrefabInstance}
            />
          )}
          <div className="node-border-overlay" aria-hidden="true" />
        </div>
      );
    },
  ),
);

const GetGlobalVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>((props, ref) => {
    const enabledStaticGlobalVariableIds = useAtomValue(enabledStaticGlobalVariableIdsState);
    const headerWarning =
      props.headerWarning ?? getMissingStaticSetGlobalWarning(props.node, enabledStaticGlobalVariableIds);

    return <VisualNodeImpl {...props} ref={ref} headerWarning={headerWarning} />;
  }),
);

const GraphOutputVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>((props, ref) => {
    const duplicateGraphOutputIds = useAtomValue(duplicateGraphOutputIdsState);
    const headerWarning = props.headerWarning ?? getDuplicateGraphOutputIdWarning(props.node, duplicateGraphOutputIds);

    return <VisualNodeImpl {...props} ref={ref} headerWarning={headerWarning} />;
  }),
);

const ToolVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>((props, ref) => {
    const graph = useAtomValue(graphState);
    const project = useAtomValue(projectState);
    const nodeForWarnings = props.editTargetNode ?? props.node;
    const headerWarning = useMemo(() => {
      // A prefab/library instance can render the source node while its
      // editable target has newer data. Project the editable target into the
      // topology before checking it, so the warning is accurate while the
      // user is actively changing a Tool name rather than only after save.
      const graphForWarnings = graph.nodes.some((candidate) => candidate.id === nodeForWarnings.id)
        ? {
            ...graph,
            nodes: graph.nodes.map((candidate) =>
              candidate.id === nodeForWarnings.id ? nodeForWarnings : candidate,
            ),
          }
        : graph;
      const graphId = graphForWarnings.metadata?.id;
      const projectWithCurrentGraph =
        graphId == null
          ? project
          : {
              ...project,
              graphs: {
                ...project.graphs,
                [graphId]: graphForWarnings,
              },
            };
      return (
        props.headerWarning ??
        getToolNodeHeaderWarning({
          node: nodeForWarnings,
          duplicateToolNodeIds: getDuplicateToolNodeIds(graphForWarnings),
          missingAutoDelegateToolGraphWarnings: getMissingAutoDelegateToolGraphWarnings(
            graphForWarnings,
            projectWithCurrentGraph,
          ),
        })
      );
    }, [graph, nodeForWarnings, project, props.headerWarning]);

    return <VisualNodeImpl {...props} ref={ref} headerWarning={headerWarning} />;
  }),
);

const SubGraphVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>((props, ref) => {
    const containingGraphId = useAtomValue(graphMetadataState)?.id;
    const headerWarning = props.headerWarning ?? getRecursiveSubGraphWarning(props.node, containingGraphId);

    return <VisualNodeImpl {...props} ref={ref} headerWarning={headerWarning} />;
  }),
);

const RoutedVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeImplProps>((props, ref) => {
    if (props.node.type === 'getGlobal') {
      return <GetGlobalVisualNode {...props} ref={ref} />;
    }

    if (props.node.type === 'graphOutput') {
      return <GraphOutputVisualNode {...props} ref={ref} />;
    }

    if (props.node.type === 'gptFunction') {
      return <ToolVisualNode {...props} ref={ref} />;
    }

    if (props.node.type === 'subGraph') {
      return <SubGraphVisualNode {...props} ref={ref} />;
    }

    return <VisualNodeImpl {...props} ref={ref} />;
  }),
);

const ResolvedNodePrefabInstanceVisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeProps>((props, ref) => {
    const project = useAtomValue(projectState);
    const prefabId = getNodePrefabInstancePrefabId(props.node);
    const sourceNode = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode : undefined;
    const headerWarning =
      prefabId && (!sourceNode || !canUseNodeAsPrefabSource(sourceNode))
        ? 'Missing library node. Reconnect this linked node or recreate its source.'
        : undefined;
    const resolvedNode = useMemo(() => resolveNodePrefabInstance(project, props.node), [project, props.node]);

    return (
      <RoutedVisualNode
        {...props}
        ref={ref}
        node={resolvedNode}
        headerWarning={headerWarning}
        editTargetNode={props.node}
        isNodePrefabInstance
      />
    );
  }),
);

export const VisualNode = memo(
  forwardRef<HTMLDivElement, VisualNodeProps>((props, ref) => {
    if (isNodePrefabInstanceNode(props.node)) {
      return <ResolvedNodePrefabInstanceVisualNode {...props} ref={ref} />;
    }

    return <RoutedVisualNode {...props} ref={ref} />;
  }),
);
