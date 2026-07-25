import {
  LLMProfileNodeImpl,
  llmProfileInputIds,
  pickLLMChatV2ProfileData,
  type LLMChatV2Node,
  type LLMProfileNode,
  type NodeConnection,
  type PortId,
} from '@valerypopoff/rivet2-core';

export const LLM_PROFILE_EXTRACTION_HORIZONTAL_GAP = 80;

export type LLMChatProfileExtraction = {
  profileNode: LLMProfileNode;
  nextChatNode: LLMChatV2Node;
  nextConnections: NodeConnection[];
  nextChatRecoverableConnections: NodeConnection[];
  nextProfileRecoverableConnections: NodeConnection[];
};

function isProfileOwnedChatInput(
  connection: NodeConnection,
  chatNode: LLMChatV2Node,
  profileInputIds: ReadonlySet<string>,
): boolean {
  return connection.inputNodeId === chatNode.id && profileInputIds.has(connection.inputId);
}

function isLLMProfileInputConnection(connection: NodeConnection, chatNode: LLMChatV2Node): boolean {
  return connection.inputNodeId === chatNode.id && connection.inputId === ('llmProfile' as PortId);
}

function rewireProfileOwnedChatInputs({
  chatNode,
  connections,
  profileInputIds,
  profileNode,
}: {
  chatNode: LLMChatV2Node;
  connections: readonly NodeConnection[];
  profileInputIds: ReadonlySet<string>;
  profileNode: LLMProfileNode;
}): NodeConnection[] {
  return connections.map((connection) =>
    isProfileOwnedChatInput(connection, chatNode, profileInputIds)
      ? { ...connection, inputNodeId: profileNode.id }
      : structuredClone(connection),
  );
}

/**
 * Extracts an inline LLM Chat configuration into an adjacent LLM Profile.
 *
 * Provider-owned input connections move with the configuration. Invocation
 * inputs (prompt, messages, tools, and response format) stay on the chat
 * node. Recoverable connections move by the complete Profile input contract,
 * so disabled configuration inputs remain attached to their eventual owner.
 * The caller owns creating the profile node and applying this result as one
 * graph command.
 */
export function extractLLMChatConfigurationToProfile({
  chatNode,
  connections,
  profileNode: initialProfileNode,
  recoverableConnections,
}: {
  chatNode: LLMChatV2Node;
  connections: readonly NodeConnection[];
  profileNode: LLMProfileNode;
  recoverableConnections: readonly NodeConnection[];
}): LLMChatProfileExtraction {
  if (chatNode.data.configurationMode === 'profile') {
    throw new Error('LLM Chat already uses an LLM Profile.');
  }

  const profileNode: LLMProfileNode = {
    ...structuredClone(initialProfileNode),
    data: structuredClone(pickLLMChatV2ProfileData(chatNode.data)),
  };
  const activeProfileInputIds = new Set(
    new LLMProfileNodeImpl(profileNode).getInputDefinitions().map((input) => input.id),
  );
  const profileOwnedInputIds = new Set<string>(llmProfileInputIds);
  const nextChatNode: LLMChatV2Node = {
    ...structuredClone(chatNode),
    data: {
      ...structuredClone(chatNode.data),
      configurationMode: 'profile',
    },
  };
  const rewiredConnections = rewireProfileOwnedChatInputs({
    chatNode,
    connections,
    profileInputIds: activeProfileInputIds,
    profileNode,
  }).filter((connection) => !isLLMProfileInputConnection(connection, chatNode));
  const rewiredRecoverableConnections = rewireProfileOwnedChatInputs({
    chatNode,
    connections: recoverableConnections,
    profileInputIds: profileOwnedInputIds,
    profileNode,
  });

  return {
    profileNode,
    nextChatNode,
    nextConnections: [
      ...rewiredConnections,
      {
        outputNodeId: profileNode.id,
        outputId: 'profile' as PortId,
        inputNodeId: chatNode.id,
        inputId: 'llmProfile' as PortId,
      },
    ],
    nextChatRecoverableConnections: rewiredRecoverableConnections.filter(
      (connection) => connection.inputNodeId !== profileNode.id && !isLLMProfileInputConnection(connection, chatNode),
    ),
    nextProfileRecoverableConnections: rewiredRecoverableConnections.filter(
      (connection) => connection.inputNodeId === profileNode.id,
    ),
  };
}
