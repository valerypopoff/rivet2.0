import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AssemblePromptNodeImpl,
  type ChatMessage,
  type DataValue,
  type InternalProcessContext,
  type PortId,
} from '../../../src/index.js';

const message = (value: ChatMessage): DataValue => ({ type: 'chat-message', value });

const processContext = {
  tokenizer: {
    getTokenCountForMessages: async () => 0,
  },
} as unknown as InternalProcessContext;

describe('AssemblePromptNode', () => {
  it('exposes filtering as an opt-in setting and only shows it in the body when enabled', () => {
    const created = AssemblePromptNodeImpl.create();
    const node = new AssemblePromptNodeImpl(created);
    const filterEditor = node.getEditors().find((editor) => editor.dataKey === 'filterEmptyPrompts');
    const cacheBreakpointEditor = node.getEditors().find((editor) => editor.dataKey === 'isLastMessageCacheBreakpoint');

    assert.equal(created.data.filterEmptyPrompts, false);
    assert.deepEqual(filterEditor, {
      type: 'toggle',
      label: 'Filter empty prompts',
      dataKey: 'filterEmptyPrompts',
      defaultValue: false,
      helperMessage:
        'Removes text-only messages whose content is empty or whitespace. Rich-content and tool-protocol messages are preserved.',
    });
    assert.equal(cacheBreakpointEditor?.useInputToggleDataKey, 'useIsLastMessageCacheBreakpointInput');
    assert.equal(node.getBody(), '');

    created.data.filterEmptyPrompts = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled');

    created.data.isLastMessageCacheBreakpoint = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled\nLast message is cache breakpoint');

    created.data.useIsLastMessageCacheBreakpointInput = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled\nLast message cache breakpoint: From input');
  });

  it('preserves empty chat messages when the setting is absent or disabled', async () => {
    for (const filterEmptyPrompts of [undefined, false]) {
      const chartNode = AssemblePromptNodeImpl.create();
      chartNode.data.filterEmptyPrompts = filterEmptyPrompts;
      const node = new AssemblePromptNodeImpl(chartNode);

      const result = await node.process(
        {
          ['message1' as PortId]: message({ type: 'user', message: '' }),
          ['message2' as PortId]: { type: 'string[]', value: ['', 'kept'] },
        },
        processContext,
      );

      assert.deepEqual(result.prompt?.value, [
        { type: 'user', message: '' },
        { type: 'user', message: '' },
        { type: 'user', message: 'kept' },
      ]);
    }
  });

  it('filters content-empty messages while preserving order and meaningful structured messages', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.filterEmptyPrompts = true;
    const node = new AssemblePromptNodeImpl(chartNode);
    const assistantToolCall: ChatMessage = {
      type: 'assistant',
      message: '',
      function_call: undefined,
      function_calls: [{ id: 'call-1', name: 'lookup', arguments: '{}' }],
    };

    const result = await node.process(
      {
        ['message1' as PortId]: message({ type: 'system', message: '   ' }),
        ['message2' as PortId]: {
          type: 'chat-message[]',
          value: [
            { type: 'user', message: [] },
            { type: 'user', message: ['', '\t'] },
            { type: 'user', message: 'First' },
            { type: 'user', message: ['', { type: 'url', url: 'https://example.com/image.png' }] },
            assistantToolCall,
            { type: 'function', message: '', name: 'lookup' },
            { type: 'developer', message: 'Last' },
          ],
        },
        ['message3' as PortId]: { type: 'string[]', value: ['', '   ', 'From strings'] },
      },
      processContext,
    );

    assert.deepEqual(result.prompt?.value, [
      { type: 'user', message: 'First' },
      { type: 'user', message: ['', { type: 'url', url: 'https://example.com/image.png' }] },
      assistantToolCall,
      { type: 'function', message: '', name: 'lookup' },
      { type: 'developer', message: 'Last' },
      { type: 'user', message: 'From strings' },
    ]);
  });

  it('returns an empty prompt when every message is filtered', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.filterEmptyPrompts = true;
    const node = new AssemblePromptNodeImpl(chartNode);

    const result = await node.process(
      {
        ['message1' as PortId]: message({ type: 'user', message: '' }),
        ['message2' as PortId]: message({ type: 'system', message: [' ', '\n'] }),
      },
      processContext,
    );

    assert.deepEqual(result.prompt, { type: 'chat-message[]', value: [] });
  });

  it('orders numbered inputs numerically instead of lexicographically', async () => {
    const node = new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create());

    const result = await node.process(
      {
        ['message10' as PortId]: message({ type: 'user', message: 'Ten' }),
        ['message2' as PortId]: message({ type: 'user', message: 'Two' }),
        ['message1' as PortId]: message({ type: 'user', message: 'One' }),
      },
      processContext,
    );

    assert.deepEqual(result.prompt?.value, [
      { type: 'user', message: 'One' },
      { type: 'user', message: 'Two' },
      { type: 'user', message: 'Ten' },
    ]);
  });

  it('applies cache breakpoints and token counting to the filtered prompt', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.filterEmptyPrompts = true;
    chartNode.data.isLastMessageCacheBreakpoint = true;
    chartNode.data.computeTokenCount = true;
    const node = new AssemblePromptNodeImpl(chartNode);
    let tokenizedMessages: ChatMessage[] | undefined;
    const context = {
      tokenizer: {
        getTokenCountForMessages: async (messages: ChatMessage[]) => {
          tokenizedMessages = messages;
          return messages.length * 10;
        },
      },
    } as unknown as InternalProcessContext;

    const lastInput: ChatMessage = {
      type: 'assistant',
      message: 'Last',
      function_call: undefined,
      function_calls: undefined,
    };
    const result = await node.process(
      {
        ['message1' as PortId]: message({ type: 'user', message: 'First' }),
        ['message2' as PortId]: message({ type: 'user', message: '' }),
        ['message3' as PortId]: message(lastInput),
      },
      context,
    );

    assert.deepEqual(result.prompt?.value, [
      { type: 'user', message: 'First' },
      {
        type: 'assistant',
        message: 'Last',
        function_call: undefined,
        function_calls: undefined,
        isCacheBreakpoint: true,
      },
    ]);
    assert.deepEqual(tokenizedMessages, result.prompt?.value);
    assert.deepEqual(result.tokenCount, { type: 'number', value: 20 });
    assert.equal(lastInput.isCacheBreakpoint, undefined);
  });

  it('reads the cache-breakpoint setting from its optional input port', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.isLastMessageCacheBreakpoint = false;
    chartNode.data.useIsLastMessageCacheBreakpointInput = true;
    const node = new AssemblePromptNodeImpl(chartNode);

    const result = await node.process(
      {
        ['isLastMessageCacheBreakpoint' as PortId]: { type: 'boolean', value: true },
        ['message1' as PortId]: message({ type: 'user', message: 'First' }),
        ['message2' as PortId]: message({ type: 'user', message: 'Last' }),
      },
      processContext,
    );

    assert.deepEqual(result.prompt?.value, [
      { type: 'user', message: 'First' },
      { type: 'user', message: 'Last', isCacheBreakpoint: true },
    ]);
  });

  it('retains the existing multi-message requirement for a cache breakpoint after filtering', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.filterEmptyPrompts = true;
    chartNode.data.isLastMessageCacheBreakpoint = true;
    const node = new AssemblePromptNodeImpl(chartNode);

    const result = await node.process(
      {
        ['message1' as PortId]: message({ type: 'user', message: '' }),
        ['message2' as PortId]: message({ type: 'user', message: 'Only retained message' }),
      },
      processContext,
    );

    assert.deepEqual(result.prompt?.value, [{ type: 'user', message: 'Only retained message' }]);
  });
});
