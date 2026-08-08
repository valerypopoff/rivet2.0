import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChatNodeImpl,
  DelegateFunctionCallNodeImpl,
  GptFunctionNodeImpl,
  LLMChatV2NodeImpl,
} from '../../../src/index.js';
import { ChatAnthropicNodeImpl } from '../../../src/plugins/anthropic/nodes/ChatAnthropicNode.js';

test('model nodes identify their response ports for Run Activity', () => {
  const legacyChat = new ChatNodeImpl(ChatNodeImpl.create());
  const llmChat = new LLMChatV2NodeImpl(LLMChatV2NodeImpl.create());

  assert.deepEqual(legacyChat.getRunActivityDescriptor(), {
    category: 'model',
    primaryOutputPortId: 'response',
  });
  assertDescriptorUsesDeclaredPorts(legacyChat.getRunActivityDescriptor(), legacyChat.getOutputDefinitions());

  assert.deepEqual(llmChat.getRunActivityDescriptor(), {
    category: 'model',
    primaryOutputPortId: 'response',
  });
  assertDescriptorUsesDeclaredPorts(llmChat.getRunActivityDescriptor(), llmChat.getOutputDefinitions());
});

test('Delegate Tool Call identifies the delegated result output for Run Activity', () => {
  const delegate = new DelegateFunctionCallNodeImpl(DelegateFunctionCallNodeImpl.create());

  assert.deepEqual(delegate.getRunActivityDescriptor(), {
    category: 'tool',
    primaryOutputPortId: 'output',
    fullOutputActionLabel: 'Open tool result',
  });
  assertDescriptorUsesDeclaredPorts(delegate.getRunActivityDescriptor(), delegate.getOutputDefinitions());
});

test('Tool identifies its output as a definition rather than a delegated result', () => {
  const tool = new GptFunctionNodeImpl(GptFunctionNodeImpl.create());

  assert.deepEqual(tool.getRunActivityDescriptor(), {
    category: 'tool',
    primaryOutputPortId: 'function',
    fullOutputActionLabel: 'Open tool definition',
  });
  assertDescriptorUsesDeclaredPorts(tool.getRunActivityDescriptor(), tool.getOutputDefinitions());
});

test('legacy Anthropic Chat opts into the same provider-neutral model presentation', () => {
  const data = ChatAnthropicNodeImpl.create().data;
  const descriptor = ChatAnthropicNodeImpl.getRunActivityDescriptor?.(data);

  assert.deepEqual(descriptor, {
    category: 'model',
    primaryOutputPortId: 'response',
  });
  assertDescriptorUsesDeclaredPorts(descriptor, ChatAnthropicNodeImpl.getOutputDefinitions(data, [], {}, {} as never));
});

function assertDescriptorUsesDeclaredPorts(
  descriptor: { primaryOutputPortId?: string } | undefined,
  outputs: readonly { id: string }[],
): void {
  assert.ok(descriptor?.primaryOutputPortId);
  assert.ok(outputs.some((output) => output.id === descriptor.primaryOutputPortId));
}
