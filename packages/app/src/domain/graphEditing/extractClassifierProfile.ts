import {
  ClassifierProfileNodeImpl,
  pickClassifierProfileData,
  classifierProfileInputIds,
  type ClassifierEvaluateNode,
  type ClassifierProfileNode,
  type NodeConnection,
  type PortId,
} from '@valerypopoff/rivet2-core';

export function extractClassifierConfigurationToProfile(input: {
  evaluateNode: ClassifierEvaluateNode;
  profileNode: ClassifierProfileNode;
  connections: readonly NodeConnection[];
  recoverableConnections: readonly NodeConnection[];
}) {
  const { evaluateNode } = input;
  if (evaluateNode.data.configurationMode === 'profile') throw new Error('Classifier Evaluate already uses a profile.');
  const profileNode = {
    ...structuredClone(input.profileNode),
    data: {
      ...input.profileNode.data,
      ...structuredClone(pickClassifierProfileData(evaluateNode.data)),
      responseTimeoutMs: evaluateNode.data.responseTimeoutMs ?? evaluateNode.data.timeoutMs ?? 30_000,
    },
  };
  const active = new Set<string>(
    new ClassifierProfileNodeImpl(profileNode).getInputDefinitions().map((port) => port.id),
  );
  const owned = new Set<string>(classifierProfileInputIds);
  const rewire = (connection: NodeConnection, ports: ReadonlySet<string>): NodeConnection => ({
    ...structuredClone(connection),
    ...(connection.inputNodeId === evaluateNode.id && ports.has(connection.inputId)
      ? { inputNodeId: profileNode.id }
      : {}),
  });
  const isOldProfile = (connection: NodeConnection) =>
    connection.inputNodeId === evaluateNode.id && connection.inputId === 'classifierProfile';
  const recovered = input.recoverableConnections
    .map((connection) => rewire(connection, owned))
    .filter((connection) => !isOldProfile(connection));
  return {
    profileNode,
    evaluateNode: {
      ...structuredClone(evaluateNode),
      data: { ...structuredClone(evaluateNode.data), configurationMode: 'profile' as const },
    },
    connections: [
      ...input.connections
        .filter((connection) => !isOldProfile(connection))
        .map((connection) => rewire(connection, active)),
      {
        inputNodeId: evaluateNode.id,
        inputId: 'classifierProfile' as PortId,
        outputNodeId: profileNode.id,
        outputId: 'profile' as PortId,
      },
    ],
    evaluateRecoverableConnections: recovered.filter((connection) => connection.inputNodeId !== profileNode.id),
    profileRecoverableConnections: recovered.filter((connection) => connection.inputNodeId === profileNode.id),
  };
}
