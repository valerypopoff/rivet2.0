import { produce } from 'immer';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
  type NodeRegistration,
  type NodeInputDefinition,
  isInterpolationInputDefinition,
  resolveNodePrefabInstance,
} from '@valerypopoff/rivet2-core';

export type ReconcileNodeEditConnectionsResult = {
  nextConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
};

type NodePortDefinitions = {
  inputDefinitions: NodeInputDefinition[];
  inputPortIds: Set<PortId>;
  outputPortIds: Set<PortId>;
};

type ReconcileNodeEditConnectionsParams = {
  nodeId: NodeId;
  newNode: Partial<ChartNode>;
  nodes: readonly ChartNode[];
  liveConnections: readonly NodeConnection[];
  recoverableConnections: readonly NodeConnection[];
  project: Project;
  referencedProjects: Record<ProjectId, Project>;
  projectNodeRegistry: NodeRegistration<any, any>;
};

export function getNodeConnectionKey(connection: NodeConnection): string {
  return `${connection.outputNodeId}|${connection.outputId}|${connection.inputNodeId}|${connection.inputId}`;
}

function getInputSlotKey(connection: NodeConnection): string {
  return `${connection.inputNodeId}|${connection.inputId}`;
}

function isIncidentConnection(nodeId: NodeId, connection: NodeConnection): boolean {
  return connection.inputNodeId === nodeId || connection.outputNodeId === nodeId;
}

function dedupeConnections(connections: readonly NodeConnection[]): NodeConnection[] {
  const seenKeys = new Set<string>();
  const dedupedConnections: NodeConnection[] = [];

  for (const connection of connections) {
    const key = getNodeConnectionKey(connection);

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    dedupedConnections.push(structuredClone(connection));
  }

  return dedupedConnections;
}

function buildUpdatedNodes(
  nodeId: NodeId,
  newNode: Partial<ChartNode>,
  nodes: readonly ChartNode[],
): ChartNode[] {
  return produce([...nodes], (draft) => {
    const index = draft.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      throw new Error(`Node with id ${nodeId} not found`);
    }

    draft[index] = {
      ...draft[index],
      ...structuredClone(newNode),
    } as ChartNode;
  });
}

type InputPortRename = {
  oldInputId: PortId;
  newInputId: PortId;
};

function resolveNodePortDefinitions({
  nodeId,
  nodesById,
  connections,
  project,
  referencedProjects,
  projectNodeRegistry,
}: {
  nodeId: NodeId;
  nodesById: Record<NodeId, ChartNode>;
  connections: readonly NodeConnection[];
  project: Project;
  referencedProjects: Record<ProjectId, Project>;
  projectNodeRegistry: NodeRegistration<any, any>;
}): NodePortDefinitions | undefined {
  const nodeConnections = connections.filter((connection) => isIncidentConnection(nodeId, connection));
  const updatedNode = nodesById[nodeId];

  if (!updatedNode) {
    return undefined;
  }

  const effectiveNodesById = Object.fromEntries(
    Object.entries(nodesById).map(([id, node]) => [id, resolveNodePrefabInstance(project, node)]),
  ) as Record<NodeId, ChartNode>;
  const effectiveNode = effectiveNodesById[nodeId] ?? updatedNode;
  const instance = projectNodeRegistry.createDynamicImpl(effectiveNode);
  const inputDefinitions = instance.getInputDefinitionsIncludingBuiltIn(
    nodeConnections,
    effectiveNodesById,
    project,
    referencedProjects,
  );
  const outputDefinitions = instance.getOutputDefinitions(nodeConnections, effectiveNodesById, project, referencedProjects);

  return {
    inputDefinitions,
    inputPortIds: new Set(inputDefinitions.map((definition) => definition.id)),
    outputPortIds: new Set(outputDefinitions.map((definition) => definition.id)),
  };
}

function hasValidConnectionPortIds(
  connection: NodeConnection,
  outputPortIds: NodePortDefinitions | undefined,
  inputPortIds: NodePortDefinitions | undefined,
): boolean {
  return !!(
    outputPortIds?.outputPortIds.has(connection.outputId) &&
    inputPortIds?.inputPortIds.has(connection.inputId)
  );
}

function getSafeInterpolationInputRename(
  previousPortDefinitions: NodePortDefinitions | undefined,
  nextPortDefinitions: NodePortDefinitions | undefined,
): InputPortRename | undefined {
  if (!previousPortDefinitions || !nextPortDefinitions) {
    return undefined;
  }

  const previousInputIds = previousPortDefinitions.inputPortIds;
  const nextInputIds = nextPortDefinitions.inputPortIds;
  const removedInterpolationInputs = previousPortDefinitions.inputDefinitions.filter(
    (definition) => isInterpolationInputDefinition(definition) && !nextInputIds.has(definition.id),
  );
  const addedInterpolationInputs = nextPortDefinitions.inputDefinitions.filter(
    (definition) => isInterpolationInputDefinition(definition) && !previousInputIds.has(definition.id),
  );

  if (removedInterpolationInputs.length !== 1 || addedInterpolationInputs.length !== 1) {
    return undefined;
  }

  return {
    oldInputId: removedInterpolationInputs[0]!.id,
    newInputId: addedInterpolationInputs[0]!.id,
  };
}

function rewriteFirstRenamedInputConnection({
  connections,
  nodeId,
  rename,
}: {
  connections: readonly NodeConnection[];
  nodeId: NodeId;
  rename: InputPortRename | undefined;
}): NodeConnection[] {
  if (!rename) {
    return [...connections];
  }

  const newInputSlotKey = `${nodeId}|${rename.newInputId}`;
  const occupiedInputSlots = new Set<string>();

  for (const connection of connections) {
    if (connection.inputNodeId === nodeId && connection.inputId === rename.oldInputId) {
      continue;
    }

    occupiedInputSlots.add(getInputSlotKey(connection));
  }

  let rewroteConnection = false;

  return connections.map((connection) => {
    if (
      rewroteConnection ||
      connection.inputNodeId !== nodeId ||
      connection.inputId !== rename.oldInputId ||
      occupiedInputSlots.has(newInputSlotKey)
    ) {
      return connection;
    }

    rewroteConnection = true;
    occupiedInputSlots.add(newInputSlotKey);

    return {
      ...connection,
      inputId: rename.newInputId,
    };
  });
}

export function reconcileNodeEditConnections({
  nodeId,
  newNode,
  nodes,
  liveConnections,
  recoverableConnections,
  project,
  referencedProjects,
  projectNodeRegistry,
}: ReconcileNodeEditConnectionsParams): ReconcileNodeEditConnectionsResult {
  const currentNodesById = Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>;
  const updatedNodes = buildUpdatedNodes(nodeId, newNode, nodes);
  const nodesById = Object.fromEntries(updatedNodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>;
  const currentEditedNodePortDefinitions = resolveNodePortDefinitions({
    nodeId,
    nodesById: currentNodesById,
    connections: liveConnections,
    project,
    referencedProjects,
    projectNodeRegistry,
  });
  const editedNodePortDefinitions = resolveNodePortDefinitions({
    nodeId,
    nodesById,
    connections: liveConnections,
    project,
    referencedProjects,
    projectNodeRegistry,
  });
  const interpolationInputRename = getSafeInterpolationInputRename(
    currentEditedNodePortDefinitions,
    editedNodePortDefinitions,
  );
  const liveConnectionsForReconcile = rewriteFirstRenamedInputConnection({
    connections: liveConnections,
    nodeId,
    rename: interpolationInputRename,
  });
  const newBrokenConnections = dedupeConnections(
    liveConnectionsForReconcile.filter(
      (connection) =>
        isIncidentConnection(nodeId, connection) &&
        !hasValidConnectionPortIds(
          connection,
          connection.outputNodeId === nodeId
            ? editedNodePortDefinitions
            : resolveNodePortDefinitions({
                nodeId: connection.outputNodeId,
                nodesById,
                connections: liveConnectionsForReconcile,
                project,
                referencedProjects,
                projectNodeRegistry,
              }),
          connection.inputNodeId === nodeId
            ? editedNodePortDefinitions
            : resolveNodePortDefinitions({
                nodeId: connection.inputNodeId,
                nodesById,
                connections: liveConnectionsForReconcile,
                project,
                referencedProjects,
                projectNodeRegistry,
              }),
        ),
    ),
  );
  const brokenConnectionKeys = new Set(newBrokenConnections.map(getNodeConnectionKey));
  const activeLiveConnections = liveConnectionsForReconcile.filter(
    (connection) => !brokenConnectionKeys.has(getNodeConnectionKey(connection)),
  );
  const currentLiveConnectionKeys = new Set(activeLiveConnections.map(getNodeConnectionKey));
  const occupiedIncomingSlots = new Set(activeLiveConnections.map(getInputSlotKey));
  const restorableConnections: NodeConnection[] = [];
  const stillRecoverableConnections: NodeConnection[] = [];

  for (const recoverableConnection of dedupeConnections(
    recoverableConnections.filter((connection) => isIncidentConnection(nodeId, connection)),
  )) {
    const connectionKey = getNodeConnectionKey(recoverableConnection);

    if (currentLiveConnectionKeys.has(connectionKey)) {
      continue;
    }

    const inputSlotKey = getInputSlotKey(recoverableConnection);

    if (occupiedIncomingSlots.has(inputSlotKey)) {
      continue;
    }

    const candidateConnections = [
      ...activeLiveConnections,
      ...restorableConnections,
      recoverableConnection,
    ];
    const outputPortIds = resolveNodePortDefinitions({
      nodeId: recoverableConnection.outputNodeId,
      nodesById,
      connections: candidateConnections,
      project,
      referencedProjects,
      projectNodeRegistry,
    });
    const inputPortIds = resolveNodePortDefinitions({
      nodeId: recoverableConnection.inputNodeId,
      nodesById,
      connections: candidateConnections,
      project,
      referencedProjects,
      projectNodeRegistry,
    });

    if (!hasValidConnectionPortIds(recoverableConnection, outputPortIds, inputPortIds)) {
      stillRecoverableConnections.push(recoverableConnection);
      continue;
    }

    occupiedIncomingSlots.add(inputSlotKey);
    currentLiveConnectionKeys.add(connectionKey);
    restorableConnections.push(recoverableConnection);
  }

  const nextConnections = dedupeConnections([
    ...activeLiveConnections,
    ...restorableConnections,
  ]);
  const nextRecoverableConnections = dedupeConnections([...stillRecoverableConnections, ...newBrokenConnections]);

  return {
    nextConnections,
    nextRecoverableConnections,
  };
}
