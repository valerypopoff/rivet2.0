import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatNodeImpl, DelegateFunctionCallNodeImpl, LLMChatV2NodeImpl } from '../../../src/index.js';
import { ChatAnthropicNodeImpl } from '../../../src/plugins/anthropic/nodes/ChatAnthropicNode.js';

test('model nodes identify their response and prompt ports for Run Activity', () => {
  const legacyChat = new ChatNodeImpl(ChatNodeImpl.create());
  const llmChat = new LLMChatV2NodeImpl(LLMChatV2NodeImpl.create());

  assert.deepEqual(legacyChat.getRunActivityDescriptor(), {
    category: 'model',
    primaryOutputPortId: 'response',
    contextInputPortIds: ['prompt'],
  });
  assertDescriptorUsesDeclaredPorts(
    legacyChat.getRunActivityDescriptor(),
    legacyChat.getInputDefinitions(),
    legacyChat.getOutputDefinitions(),
  );

  assert.deepEqual(llmChat.getRunActivityDescriptor(), {
    category: 'model',
    primaryOutputPortId: 'response',
    contextInputPortIds: ['prompt'],
  });
  assertDescriptorUsesDeclaredPorts(
    llmChat.getRunActivityDescriptor(),
    llmChat.getInputDefinitions(),
    llmChat.getOutputDefinitions(),
  );
});

test('Delegate Tool Call identifies the delegated result and actual tool-call input port', () => {
  const delegate = new DelegateFunctionCallNodeImpl(DelegateFunctionCallNodeImpl.create());

  assert.deepEqual(delegate.getRunActivityDescriptor(), {
    category: 'tool',
    primaryOutputPortId: 'output',
    contextInputPortIds: ['function-call'],
  });
  assertDescriptorUsesDeclaredPorts(
    delegate.getRunActivityDescriptor(),
    delegate.getInputDefinitions(),
    delegate.getOutputDefinitions(),
  );
});

test('legacy Anthropic Chat opts into the same provider-neutral model presentation', () => {
  const data = ChatAnthropicNodeImpl.create().data;
  const descriptor = ChatAnthropicNodeImpl.getRunActivityDescriptor?.(data);

  assert.deepEqual(descriptor, {
    category: 'model',
    primaryOutputPortId: 'response',
    contextInputPortIds: ['prompt'],
  });
  assertDescriptorUsesDeclaredPorts(
    descriptor,
    ChatAnthropicNodeImpl.getInputDefinitions(data, [], {}, {} as never),
    ChatAnthropicNodeImpl.getOutputDefinitions(data, [], {}, {} as never),
  );
});

function assertDescriptorUsesDeclaredPorts(
  descriptor: { primaryOutputPortId?: string; contextInputPortIds?: string[] } | undefined,
  inputs: readonly { id: string }[],
  outputs: readonly { id: string }[],
): void {
  assert.ok(descriptor?.primaryOutputPortId);
  assert.ok(outputs.some((output) => output.id === descriptor.primaryOutputPortId));
  for (const portId of descriptor.contextInputPortIds ?? []) {
    assert.ok(inputs.some((input) => input.id === portId));
  }
}
