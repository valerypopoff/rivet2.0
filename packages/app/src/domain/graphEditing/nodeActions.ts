import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodePrefabId,
  type NodeRegistration,
  type Project,
  type ProjectId,
  type NodePrefabInstanceNode,
  NODE_PREFAB_INSTANCE_TYPE,
  getNodePrefabDisplayName,
  type ReferencedGraphAliasNode,
  newId,
} from '@valerypopoff/rivet2-core';
import { cloneDeep, partition } from 'lodash-es';
import { getDefaultNodeColorForType } from './defaultNodeColors.js';

const SINGLE_NODE_DUPLICATE_OFFSET = { x: 80, y: 200 };

export function createAddedNode(options: {
  nodeType: string;
  position: { x: number; y: number };
  registry: NodeRegistration<any, any>;
  referencedProjects: Record<ProjectId, Project>;
  project?: Project;
  appliedId?: NodeId;
  applyDefaultColor?: boolean;
}) {
  let nodeType = options.nodeType as string | undefined;
  let referencedProjectId: string | undefined;
  let referencedGraphId: string | undefined;
  let nodePrefabId: string | undefined;

  if (nodeType?.startsWith('referencedGraphAlias')) {
    [nodeType, referencedProjectId, referencedGraphId] = nodeType.split(':');
  }

  if (nodeType?.startsWith(NODE_PREFAB_INSTANCE_TYPE)) {
    [nodeType, nodePrefabId] = nodeType.split(':');
  }

  if (!nodeType) {
    throw new Error('Node type is required');
  }

  const newNode = options.registry.createDynamic(nodeType);

  newNode.visualData.x = options.position.x;
  newNode.visualData.y = options.position.y;

  if (options.appliedId) {
    newNode.id = options.appliedId;
  }

  newNode.visualData.width = (newNode.visualData.width ?? 200) + 30;

  if (options.applyDefaultColor && !newNode.visualData.color) {
    const defaultNodeColor = getDefaultNodeColorForType(newNode.type);
    if (defaultNodeColor) {
      newNode.visualData.color = defaultNodeColor;
    }
  }

  if (newNode.type === 'referencedGraphAlias') {
    if (!referencedProjectId || !referencedGraphId) {
      throw new Error('Referenced graph alias node requires project and graph IDs');
    }

    const data = newNode.data as ReferencedGraphAliasNode['data'];
    data.projectId = referencedProjectId as ProjectId;
    data.graphId = referencedGraphId as GraphId;

    const graphName = options.referencedProjects[data.projectId]?.graphs[data.graphId]?.metadata?.name;
    newNode.title = graphName ?? 'Unknown Graph';
  }

  if (newNode.type === NODE_PREFAB_INSTANCE_TYPE) {
    if (!nodePrefabId) {
      throw new Error('Linked node requires a library node ID');
    }

    const data = newNode.data as NodePrefabInstanceNode['data'];
    data.prefabId = nodePrefabId as NodePrefabId;
    newNode.title = options.project ? getNodePrefabDisplayName(options.project, data.prefabId) : newNode.title;

    const sourceWidth = options.project?.nodePrefabs?.[data.prefabId]?.sourceNode.visualData.width;
    if (sourceWidth !== undefined) {
      newNode.visualData.width = sourceWidth;
    }
  }

  return newNode;
}

export function duplicateNodeWithConnections(options: {
  node: ChartNode;
  connections: NodeConnection[];
  registry: NodeRegistration<any, any>;
}) {
  const { newNodes, duplicatedConnections } = duplicateNodesWithConnections({
    nodes: [options.node],
    nodeIds: [options.node.id],
    connections: options.connections,
    delta: SINGLE_NODE_DUPLICATE_OFFSET,
  });

  return {
    newNode: newNodes[0]!,
    duplicatedIncomingConnections: duplicatedConnections,
  };
}

export function duplicateNodesWithConnections(options: {
  nodes: ChartNode[];
  nodeIds: NodeId[];
  connections: NodeConnection[];
  delta?: { x: number; y: number };
}) {
  const nodeIds = [...new Set(options.nodeIds)];
  const delta = options.delta ?? { x: 0, y: 0 };
  const duplicatedNodeIds = new Map<NodeId, NodeId>();

  const sourceNodes = nodeIds.map((nodeId) => {
    const node = options.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new Error(`Node with id ${nodeId} not found`);
    }

    return node;
  });

  const newNodes = sourceNodes.map((node) => {
    const duplicatedNode = cloneDeep(node);
    const duplicatedNodeId = newId<NodeId>();

    duplicatedNodeIds.set(node.id, duplicatedNodeId);
    duplicatedNode.id = duplicatedNodeId;
    duplicatedNode.visualData = {
      ...duplicatedNode.visualData,
      x: node.visualData.x + delta.x,
      y: node.visualData.y + delta.y,
    };

    return duplicatedNode;
  });

  const duplicatedConnections = options.connections.flatMap((connection) => {
    const duplicatedInputNodeId = duplicatedNodeIds.get(connection.inputNodeId);
    if (!duplicatedInputNodeId) {
      return [];
    }

    return [
      {
        ...connection,
        inputNodeId: duplicatedInputNodeId,
        outputNodeId: duplicatedNodeIds.get(connection.outputNodeId) ?? connection.outputNodeId,
      },
    ];
  });

  return {
    newNodes,
    duplicatedConnections,
  };
}

export function deleteNodesFromGraph(options: {
  nodeIds: NodeId[];
  nodes: ChartNode[];
  connections: NodeConnection[];
}) {
  const newNodes = [...options.nodes];
  let newConnections = [...options.connections];
  const removedNodes: ChartNode[] = [];
  const removedConnections: NodeConnection[] = [];

  for (const nodeId of options.nodeIds) {
    const nodeIndex = newNodes.findIndex((node) => node.id === nodeId);
    if (nodeIndex >= 0) {
      const [removedNode] = newNodes.splice(nodeIndex, 1);
      removedNodes.push(removedNode!);
    }

    const [connectionsToRemove, connectionsToKeep] = partition(
      newConnections,
      (connection) => connection.inputNodeId === nodeId || connection.outputNodeId === nodeId,
    );

    newConnections = connectionsToKeep;
    removedConnections.push(...connectionsToRemove);
  }

  return {
    newNodes,
    newConnections,
    removedNodes,
    removedConnections,
  };
}

export function createPastedNodes(options: {
  nodes: ChartNode[];
  connections: NodeConnection[];
  position: { x: number; y: number };
}) {
  const boundingBox = options.nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.visualData.x),
      minY: Math.min(accumulator.minY, node.visualData.y),
      maxX: Math.max(accumulator.maxX, node.visualData.x + (node.visualData.width ?? 200)),
      maxY: Math.max(accumulator.maxY, node.visualData.y + 200),
    }),
    {
      minX: Number.MAX_SAFE_INTEGER,
      minY: Number.MAX_SAFE_INTEGER,
      maxX: Number.MIN_SAFE_INTEGER,
      maxY: Number.MIN_SAFE_INTEGER,
    },
  );

  const oldNewNodeIdMap: Record<NodeId, NodeId> = {};

  const newNodes = options.nodes.map((node) => {
    const duplicatedNode = cloneDeep(node);
    const newNodeId = newId<NodeId>();
    oldNewNodeIdMap[node.id] = newNodeId;

    duplicatedNode.id = newNodeId;
    duplicatedNode.visualData.x = options.position.x + (node.visualData.x - boundingBox.minX);
    duplicatedNode.visualData.y = options.position.y + (node.visualData.y - boundingBox.minY);

    return duplicatedNode;
  });

  const newConnections = options.connections.flatMap((connection) => {
    const inputNodeId = oldNewNodeIdMap[connection.inputNodeId];
    const outputNodeId = oldNewNodeIdMap[connection.outputNodeId];

    if (!inputNodeId || !outputNodeId) {
      return [];
    }

    return [
      {
        ...connection,
        inputNodeId,
        outputNodeId,
      },
    ];
  });

  return {
    newNodes,
    newConnections,
  };
}
