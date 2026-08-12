import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LLMChatV2NodeImpl,
  LLMProfileNodeImpl,
  type LLMChatV2Node,
  type LLMProfileNode,
  type NodeConnection,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { extractLLMChatConfigurationToProfile } from './extractLLMChatProfile.js';

const chatNodeId = 'chat-node' as NodeId;
const profileNodeId = 'profile-node' as NodeId;

function createChatNode(): LLMChatV2Node {
  const node = LLMChatV2NodeImpl.create();
  return {
    ...node,
    id: chatNodeId,
    visualData: { ...node.visualData, x: 500, y: 300 },
    data: {
      ...node.data,
      configurationMode: 'inline',
      provider: 'custom',
      model: 'custom-model',
      apiKeySource: 'input',
      providerApiKeyNames: {
        openai: {
          programmaticName: 'billingOpenAiKey',
          environmentVariableName: 'BILLING_OPENAI_KEY',
        },
      },
      useModelInput: true,
      useCustomProviderBaseURLInput: true,
      useTemperatureInput: true,
      useHeadersInput: true,
      useExtraProviderOptionsInput: true,
    },
  };
}

function createProfileNode(): LLMProfileNode {
  const node = LLMProfileNodeImpl.create();
  return {
    ...node,
    id: profileNodeId,
    visualData: { ...node.visualData, x: 130, y: 300 },
  };
}

function incomingConnection(inputId: string): NodeConnection {
  return {
    inputNodeId: chatNodeId,
    inputId: inputId as PortId,
    outputNodeId: `source-${inputId}` as NodeId,
    outputId: 'output' as PortId,
  };
}

test('extractLLMChatConfigurationToProfile moves profile-owned inputs and keeps chat invocation inputs', () => {
  const chatNode = createChatNode();
  const profileNode = createProfileNode();
  const result = extractLLMChatConfigurationToProfile({
    chatNode,
    profileNode,
    connections: [
      incomingConnection('model'),
      incomingConnection('apiKey'),
      incomingConnection('customProviderBaseURL'),
      incomingConnection('temperature'),
      incomingConnection('headers'),
      incomingConnection('extraProviderOptions'),
      incomingConnection('prompt'),
      {
        inputNodeId: 'output-node' as NodeId,
        inputId: 'value' as PortId,
        outputNodeId: chatNodeId,
        outputId: 'response' as PortId,
      },
      {
        inputNodeId: chatNodeId,
        inputId: 'llmProfile' as PortId,
        outputNodeId: 'stale-profile' as NodeId,
        outputId: 'profile' as PortId,
      },
    ],
    recoverableConnections: [
      incomingConnection('temperature'),
      incomingConnection('prompt'),
      {
        inputNodeId: chatNodeId,
        inputId: 'llmProfile' as PortId,
        outputNodeId: 'stale-recoverable-profile' as NodeId,
        outputId: 'profile' as PortId,
      },
    ],
  });

  assert.equal(result.nextChatNode.data.configurationMode, 'profile');
  assert.equal(result.profileNode.data.provider, 'custom');
  assert.equal(result.profileNode.data.model, 'custom-model');
  assert.equal(result.profileNode.data.useModelInput, true);
  assert.equal(result.profileNode.data.apiKeySource, 'input');
  assert.deepEqual(result.profileNode.data.providerApiKeyNames, chatNode.data.providerApiKeyNames);

  const profileInputConnections = result.nextConnections.filter(
    (connection) => connection.inputNodeId === profileNodeId,
  );
  assert.deepEqual(
    profileInputConnections.map((connection) => connection.inputId).sort(),
    ['apiKey', 'customProviderBaseURL', 'extraProviderOptions', 'headers', 'model', 'temperature'].sort(),
  );
  assert.ok(
    result.nextConnections.some(
      (connection) =>
        connection.outputNodeId === profileNodeId &&
        connection.outputId === ('profile' as PortId) &&
        connection.inputNodeId === chatNodeId &&
        connection.inputId === ('llmProfile' as PortId),
    ),
  );
  assert.ok(
    result.nextConnections.some(
      (connection) => connection.inputNodeId === chatNodeId && connection.inputId === ('prompt' as PortId),
    ),
  );
  assert.ok(
    result.nextConnections.some(
      (connection) => connection.outputNodeId === chatNodeId && connection.outputId === ('response' as PortId),
    ),
  );
  assert.equal(
    result.nextConnections.filter(
      (connection) => connection.inputNodeId === chatNodeId && connection.inputId === ('llmProfile' as PortId),
    ).length,
    1,
  );

  assert.deepEqual(
    result.nextChatRecoverableConnections.map((connection) => connection.inputId),
    ['prompt'],
  );
  assert.deepEqual(
    result.nextProfileRecoverableConnections.map((connection) => connection.inputId),
    ['temperature'],
  );
});

test('extractLLMChatConfigurationToProfile rejects chats already configured from a profile', () => {
  const chatNode = createChatNode();
  chatNode.data.configurationMode = 'profile';

  assert.throws(
    () =>
      extractLLMChatConfigurationToProfile({
        chatNode,
        connections: [],
        profileNode: createProfileNode(),
        recoverableConnections: [],
      }),
    /already uses an LLM Profile/,
  );
});

test('extractLLMChatConfigurationToProfile moves an input-driven Previous Response ID into an OpenAI profile', () => {
  const chatNode = createChatNode();
  chatNode.data.provider = 'openai';
  chatNode.data.useOpenAIPreviousResponseIdInput = true;
  const profileNode = createProfileNode();
  const previousResponseIdConnection = incomingConnection('previousResponseId');

  const result = extractLLMChatConfigurationToProfile({
    chatNode,
    profileNode,
    connections: [previousResponseIdConnection],
    recoverableConnections: [previousResponseIdConnection],
  });

  assert.equal(result.profileNode.data.useOpenAIPreviousResponseIdInput, true);
  assert.deepEqual(result.nextProfileRecoverableConnections, [
    { ...previousResponseIdConnection, inputNodeId: profileNodeId },
  ]);
  assert.deepEqual(result.nextChatRecoverableConnections, []);
  assert.deepEqual(result.nextConnections, [
    { ...previousResponseIdConnection, inputNodeId: profileNodeId },
    {
      outputNodeId: profileNodeId,
      outputId: 'profile' as PortId,
      inputNodeId: chatNodeId,
      inputId: 'llmProfile' as PortId,
    },
  ]);
});

test('extractLLMChatConfigurationToProfile moves disabled profile-owned recoverable inputs', () => {
  const chatNode = createChatNode();
  chatNode.data.useTopPInput = false;
  const profileNode = createProfileNode();
  const topPConnection = incomingConnection('topP');

  const result = extractLLMChatConfigurationToProfile({
    chatNode,
    profileNode,
    connections: [],
    recoverableConnections: [topPConnection],
  });

  assert.deepEqual(result.nextChatRecoverableConnections, []);
  assert.deepEqual(result.nextProfileRecoverableConnections, [{ ...topPConnection, inputNodeId: profileNodeId }]);
});
