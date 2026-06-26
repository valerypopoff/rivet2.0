import {
  getNodePrefabInstancePrefabId,
  isNodePrefabInstanceNode,
  resolveNodePrefabInstance,
  type ChartNode,
  type FrozenNodeOutputsByGraph,
  type GraphId,
  type NodeId,
  type Project,
} from '@valerypopoff/rivet2-core';
import type { ContextMenuContext } from '../ContextMenu.js';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';
import {
  canPreloadEditorRunFromPlan,
  getEditorRunFromPlan,
} from '../../hooks/remoteExecutorHelpers.js';
import type { GraphRunRecord, GraphRunSelection, RunDataByNodeId } from '../../state/dataFlow.js';
import { canFreezeNodeOutputs, canNodeTypeBeFrozen } from '../../utils/frozenNodeOutputs.js';
import { canRearrangeVariadicNodePorts } from '../../domain/graphEditing/variadicPortReorder.js';

type ProjectNodeRegistry = Parameters<typeof getEditorRunFromPlan>[3];
const NODE_CONTEXT_MENU_TYPE_PREFIX = 'node-';

type NodeContextMenuTarget = {
  nodeId: NodeId;
  nodeType: ChartNode['type'];
};

type FreezeTargetEligibility = NodeContextMenuTarget & {
  canFreeze: boolean;
  hasRetainedSuccessfulOutput: boolean;
  isAlreadyFrozen: boolean;
  isFreezableNodeType: boolean;
};

type NodesById = Readonly<Record<NodeId, ChartNode | undefined>>;

export function getNodeCanvasContextMenuContext({
  canStartEditorGraphRun,
  canUseFrozenNodes,
  contextMenuData,
  freezeUnavailableReason,
  frozenNodeOutputs,
  graphSelection,
  lastRunPerNode,
  nodesById = {},
  project,
  projectNodeRegistry,
  selectedGraphId,
  selectedNodeIds = [],
  graphCommandsEnabled = true,
  pasteCommandsEnabled = graphCommandsEnabled,
}: {
  canStartEditorGraphRun: boolean;
  canUseFrozenNodes: boolean;
  contextMenuData: ContextMenuData;
  freezeUnavailableReason?: string;
  frozenNodeOutputs: FrozenNodeOutputsByGraph;
  graphSelection: {
    graphRuns?: GraphRunRecord[];
    selectedGraphRun?: GraphRunSelection;
  };
  lastRunPerNode: RunDataByNodeId;
  nodesById?: NodesById;
  project: Project;
  projectNodeRegistry: ProjectNodeRegistry;
  selectedGraphId: GraphId | undefined;
  selectedNodeIds?: readonly NodeId[];
  graphCommandsEnabled?: boolean;
  pasteCommandsEnabled?: boolean;
}): ContextMenuContext {
  const target = getNodeCanvasContextMenuTarget(contextMenuData.data);

  if (!target) {
    return {
      type: 'blankArea',
      data: { graphCommandsEnabled, pasteCommandsEnabled },
    };
  }

  const targetNode = nodesById[target.nodeId];
  const targetIsPrefabInstance = targetNode != null && isNodePrefabInstanceNode(targetNode);
  const targetPrefabId = targetIsPrefabInstance ? getNodePrefabInstancePrefabId(targetNode) : undefined;
  const resolvedTargetNode = targetNode ? resolveNodePrefabInstance(project, targetNode) : undefined;
  const effectiveTarget = targetIsPrefabInstance
    ? { nodeId: target.nodeId, nodeType: resolvedTargetNode!.type }
    : target;
  const isFrozen = Boolean(selectedGraphId && frozenNodeOutputs[selectedGraphId]?.[target.nodeId]?.length);
  const scopedTargets = getNodeCanvasContextMenuScopedTargets({ nodesById, project, selectedNodeIds, target: effectiveTarget });
  const frozenOutputsByNode = selectedGraphId ? frozenNodeOutputs[selectedGraphId] : undefined;
  const freezeTargetEligibility = selectedGraphId
    ? scopedTargets.map((scopedTarget): FreezeTargetEligibility => {
        const isFreezableNodeType = canNodeTypeBeFrozen(scopedTarget.nodeType);
        const isAlreadyFrozen = Boolean(frozenOutputsByNode?.[scopedTarget.nodeId]?.length);
        const hasRetainedSuccessfulOutput = canFreezeNodeOutputs({
          graphId: selectedGraphId,
          processData: lastRunPerNode[scopedTarget.nodeId],
          selection: graphSelection,
        });

        return {
          ...scopedTarget,
          canFreeze: isFreezableNodeType && !isAlreadyFrozen && hasRetainedSuccessfulOutput,
          hasRetainedSuccessfulOutput,
          isAlreadyFrozen,
          isFreezableNodeType,
        };
      })
    : [];
  const freezeNodeTargets =
    canUseFrozenNodes && selectedGraphId
      ? freezeTargetEligibility
          .filter((scopedTarget) => scopedTarget.canFreeze)
          .map(({ nodeId, nodeType }) => ({ nodeId, nodeType }))
      : [];
  const freezeDisabledReason = getFreezeDisabledReason({
    canUseFrozenNodes,
    freezeNodeTargets,
    freezeTargetEligibility,
    freezeUnavailableReason,
    selectedGraphId,
    scopedTargets,
  });
  const unfreezeNodeIds =
    canUseFrozenNodes && selectedGraphId
      ? scopedTargets
          .filter((scopedTarget) => Boolean(frozenOutputsByNode?.[scopedTarget.nodeId]?.length))
          .map((scopedTarget) => scopedTarget.nodeId)
      : [];
  const selectedGraphConnections = selectedGraphId ? project.graphs[selectedGraphId]?.connections ?? [] : [];
  const variadicPortRearrangeKind = canRearrangeVariadicNodePorts({
    connections: selectedGraphConnections,
    node: resolvedTargetNode,
  });

  return {
    type: 'node',
    data: {
      nodeType: effectiveTarget.nodeType,
      nodeId: target.nodeId,
      graphCommandsEnabled,
      isLinkedNode: targetIsPrefabInstance,
      canRunFromEditor: canStartEditorGraphRun,
      canRunFromHere: canRunNodeCanvasContextMenuFromHere({
        canStartEditorGraphRun,
        frozenNodeOutputs: canUseFrozenNodes ? frozenNodeOutputs : undefined,
        lastRunPerNode,
        nodeId: target.nodeId,
        project,
        projectNodeRegistry,
        selectedGraphId,
      }),
      canRearrangeSubgraphPorts: canRearrangeNodeSubgraphPorts(nodesById[target.nodeId], project),
      canRearrangeVariadicPorts: variadicPortRearrangeKind != null,
      variadicPortRearrangeKind,
      canFreeze: freezeNodeTargets.length > 0,
      canUnfreeze: unfreezeNodeIds.length > 0,
      freezeNodeTargets,
      freezeMenuTargetCount: scopedTargets.length,
      freezeDisabledReason,
      unfreezeNodeIds,
      isFrozen,
      canOpenNodePrefabSource: targetPrefabId != null,
    },
  };
}

function canRearrangeNodeSubgraphPorts(node: ChartNode | undefined, project: Project): boolean {
  if (node?.type !== 'subGraph') {
    return false;
  }

  const graphId = (node.data as { graphId?: GraphId }).graphId;
  const graph = graphId ? project.graphs[graphId] : undefined;

  return Boolean(graph?.nodes.some((graphNode) => graphNode.type === 'graphInput' || graphNode.type === 'graphOutput'));
}

function getFreezeDisabledReason({
  canUseFrozenNodes,
  freezeNodeTargets,
  freezeTargetEligibility,
  freezeUnavailableReason,
  selectedGraphId,
  scopedTargets,
}: {
  canUseFrozenNodes: boolean;
  freezeNodeTargets: NodeContextMenuTarget[];
  freezeTargetEligibility: FreezeTargetEligibility[];
  freezeUnavailableReason?: string;
  selectedGraphId: GraphId | undefined;
  scopedTargets: NodeContextMenuTarget[];
}): string | undefined {
  if (freezeNodeTargets.length > 0 || scopedTargets.length === 0) {
    return undefined;
  }

  if (!selectedGraphId) {
    return 'Open a graph before freezing node outputs.';
  }

  if (shouldHideDisabledFreezeForMissingOrFrozenOutputs(freezeTargetEligibility)) {
    return undefined;
  }

  if (freezeTargetEligibility.length === 1) {
    const singleNodeReason = getSingleNodeFreezeDisabledReason(freezeTargetEligibility[0]!);
    if (singleNodeReason) {
      return singleNodeReason;
    }
  } else {
    const multiNodeReason = getMultiNodeFreezeDisabledReason(freezeTargetEligibility);
    if (multiNodeReason) {
      return multiNodeReason;
    }
  }

  if (freezeUnavailableReason) {
    return freezeUnavailableReason;
  }

  if (!canUseFrozenNodes) {
    return 'Freeze node output is unavailable in the current editor mode.';
  }

  return undefined;
}

function shouldHideDisabledFreezeForMissingOrFrozenOutputs(targets: FreezeTargetEligibility[]): boolean {
  return targets.every((target) => target.isAlreadyFrozen || !target.hasRetainedSuccessfulOutput);
}

function getSingleNodeFreezeDisabledReason(target: FreezeTargetEligibility): string | undefined {
  if (!target.isFreezableNodeType) {
    return 'This node type cannot be frozen';
  }

  return undefined;
}

function getMultiNodeFreezeDisabledReason(targets: FreezeTargetEligibility[]): string | undefined {
  if (targets.every((target) => !target.isFreezableNodeType)) {
    return 'None of the selected node types can be frozen';
  }

  if (targets.some((target) => !target.isFreezableNodeType)) {
    return 'Some selected node types cannot be frozen';
  }

  return undefined;
}

function getNodeCanvasContextMenuScopedTargets({
  nodesById,
  project,
  selectedNodeIds,
  target,
}: {
  nodesById: NodesById;
  project: Project;
  selectedNodeIds: readonly NodeId[];
  target: NodeContextMenuTarget;
}): NodeContextMenuTarget[] {
  if (selectedNodeIds.length <= 1 || !selectedNodeIds.includes(target.nodeId)) {
    return [target];
  }

  const selectedTargets = [...new Set(selectedNodeIds)].flatMap((selectedNodeId): NodeContextMenuTarget[] => {
    const selectedNode = nodesById[selectedNodeId];
    if (!selectedNode) {
      return [];
    }

    const nodeType = isNodePrefabInstanceNode(selectedNode)
      ? resolveNodePrefabInstance(project, selectedNode).type
      : selectedNode.type;
    return [{ nodeId: selectedNode.id, nodeType }];
  });

  return selectedTargets.length > 0 ? selectedTargets : [target];
}

export function getNodeCanvasContextMenuTarget(
  target: ContextMenuData['data'],
): NodeContextMenuTarget | undefined {
  const nodeType = target?.type.startsWith(NODE_CONTEXT_MENU_TYPE_PREFIX)
    ? target.type.slice(NODE_CONTEXT_MENU_TYPE_PREFIX.length)
    : '';
  const nodeId = target?.element.dataset.nodeid;
  if (!nodeId || !nodeType) {
    return undefined;
  }

  return {
    nodeId: nodeId as NodeId,
    nodeType: nodeType as ChartNode['type'],
  };
}

export function canRunNodeCanvasContextMenuFromHere({
  canStartEditorGraphRun,
  frozenNodeOutputs,
  lastRunPerNode,
  nodeId,
  project,
  projectNodeRegistry,
  selectedGraphId,
}: {
  canStartEditorGraphRun: boolean;
  frozenNodeOutputs?: FrozenNodeOutputsByGraph;
  lastRunPerNode: RunDataByNodeId;
  nodeId: NodeId;
  project: Project;
  projectNodeRegistry: ProjectNodeRegistry;
  selectedGraphId: GraphId | undefined;
}): boolean {
  if (!canStartEditorGraphRun || !selectedGraphId) {
    return false;
  }

  try {
    const runFromPlan = getEditorRunFromPlan(project, selectedGraphId, nodeId, projectNodeRegistry);
    return canPreloadEditorRunFromPlan(runFromPlan, lastRunPerNode, { frozenNodeOutputs, graphId: selectedGraphId });
  } catch {
    return false;
  }
}
