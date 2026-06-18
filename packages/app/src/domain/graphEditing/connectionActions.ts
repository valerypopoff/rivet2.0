import { type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';

export type ConnectionActionParams = {
  outputNodeId: NodeId;
  outputId: PortId;
  inputNodeId: NodeId;
  inputId: PortId;
};

export function areConnectionsEqual(a: NodeConnection, b: NodeConnection): boolean {
  return (
    a.inputNodeId === b.inputNodeId &&
    a.inputId === b.inputId &&
    a.outputNodeId === b.outputNodeId &&
    a.outputId === b.outputId
  );
}

export function removeMatchingConnection(
  connections: NodeConnection[],
  connectionToRemove: NodeConnection,
): NodeConnection[] {
  let removed = false;

  return connections.filter((connection) => {
    if (!removed && areConnectionsEqual(connection, connectionToRemove)) {
      removed = true;
      return false;
    }

    return true;
  });
}

export function createConnectionChange(
  connections: NodeConnection[],
  params: ConnectionActionParams,
): {
  connections: NodeConnection[];
  newConnection: NodeConnection;
  previousConnectionToInput: NodeConnection | undefined;
} {
  let nextConnections = [...connections];

  const previousConnectionToInput = connections.find(
    (connection) => connection.inputNodeId === params.inputNodeId && connection.inputId === params.inputId,
  );

  if (previousConnectionToInput) {
    nextConnections = removeMatchingConnection(nextConnections, previousConnectionToInput);
  }

  const newConnection: NodeConnection = {
    inputNodeId: params.inputNodeId,
    inputId: params.inputId,
    outputNodeId: params.outputNodeId,
    outputId: params.outputId,
  };

  return {
    connections: [...nextConnections, newConnection],
    newConnection,
    previousConnectionToInput,
  };
}

export function removeConnection(connections: NodeConnection[], connectionToBreak: NodeConnection): NodeConnection[] {
  return removeMatchingConnection(connections, connectionToBreak);
}

export function setConnectionBendPoint(options: {
  connections: NodeConnection[];
  connectionToUpdate: NodeConnection;
  bendPoint: NodeConnection['bendPoint'] | undefined;
}): { connections: NodeConnection[]; previousConnection: NodeConnection; nextConnection: NodeConnection } | undefined {
  let updated = false;
  let previousConnection: NodeConnection | undefined;
  let nextConnection: NodeConnection | undefined;

  const nextConnections = options.connections.map((connection) => {
    if (updated || !areConnectionsEqual(connection, options.connectionToUpdate)) {
      return connection;
    }

    updated = true;
    previousConnection = connection;
    const connectionWithoutBendPoint: NodeConnection = { ...connection };
    delete connectionWithoutBendPoint.bendPoint;
    nextConnection = options.bendPoint
      ? { ...connectionWithoutBendPoint, bendPoint: options.bendPoint }
      : connectionWithoutBendPoint;

    return nextConnection;
  });

  if (!previousConnection || !nextConnection) {
    return undefined;
  }

  return {
    connections: nextConnections,
    previousConnection,
    nextConnection,
  };
}

export function createRewireConnectionChange(
  connections: NodeConnection[],
  originalConnection: NodeConnection,
  params: ConnectionActionParams,
): {
  connections: NodeConnection[];
  newConnection: NodeConnection;
  originalConnection: NodeConnection;
  replacedTargetConnection: NodeConnection | undefined;
} {
  const replacedTargetConnection = connections.find(
    (connection) => connection.inputNodeId === params.inputNodeId && connection.inputId === params.inputId,
  );

  let nextConnections = removeMatchingConnection(connections, originalConnection);

  if (replacedTargetConnection && !areConnectionsEqual(replacedTargetConnection, originalConnection)) {
    nextConnections = removeMatchingConnection(nextConnections, replacedTargetConnection);
  }

  const newConnection: NodeConnection = {
    inputNodeId: params.inputNodeId,
    inputId: params.inputId,
    outputNodeId: params.outputNodeId,
    outputId: params.outputId,
  };

  return {
    connections: [...nextConnections, newConnection],
    newConnection,
    originalConnection,
    replacedTargetConnection,
  };
}

export function undoRewireConnectionChange(options: {
  connections: NodeConnection[];
  newConnection: NodeConnection;
  originalConnection: NodeConnection;
  replacedTargetConnection?: NodeConnection;
}): NodeConnection[] {
  let nextConnections = removeMatchingConnection(options.connections, options.newConnection);
  nextConnections = [...nextConnections, options.originalConnection];

  if (
    options.replacedTargetConnection &&
    !areConnectionsEqual(options.replacedTargetConnection, options.originalConnection)
  ) {
    nextConnections = [...nextConnections, options.replacedTargetConnection];
  }

  return nextConnections;
}

export function undoConnectionChange(options: {
  connections: NodeConnection[];
  newConnection: NodeConnection;
  previousConnectionToInput?: NodeConnection;
}): NodeConnection[] {
  const withoutNewConnection = removeMatchingConnection(options.connections, options.newConnection);

  return options.previousConnectionToInput
    ? [...withoutNewConnection, options.previousConnectionToInput]
    : withoutNewConnection;
}
