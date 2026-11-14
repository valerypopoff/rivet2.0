import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AssemblePromptNodeImpl,
  ArrayNodeImpl,
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
  it('enables filtering by default and only shows it in the body when enabled', () => {
    const created = AssemblePromptNodeImpl.create();
    const node = new AssemblePromptNodeImpl(created);
    const filterEditor = node.getEditors().find((editor) => editor.dataKey === 'filterEmptyPrompts');
    const cacheBreakpointEditor = node.getEditors().find((editor) => editor.dataKey === 'isLastMessageCacheBreakpoint');

    assert.equal(created.data.filterEmptyPrompts, true);
    assert.deepEqual(filterEditor, {
      type: 'toggle',
      label: 'Filter empty prompts',
      dataKey: 'filterEmptyPrompts',
      defaultValue: true,
      helperMessage:
        'Removes text-only messages whose content is empty or whitespace. Rich content, tool exchanges and reasoning continuity are preserved.',
    });
    assert.equal(cacheBreakpointEditor?.useInputToggleDataKey, 'useIsLastMessageCacheBreakpointInput');
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled');

    created.data.filterEmptyPrompts = false;
    assert.equal(node.getBody(), '');

    created.data.filterEmptyPrompts = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled');

    created.data.isLastMessageCacheBreakpoint = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled\nLast message is cache breakpoint');

    created.data.useIsLastMessageCacheBreakpointInput = true;
    assert.equal(node.getBody(), 'Filter empty prompts: Enabled\nLast message cache breakpoint: From input');
  });

  it('filters empty messages when unset or enabled and honors an explicit opt-out', async () => {
    for (const filterEmptyPrompts of [undefined, true, false]) {
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

      assert.deepEqual(
        result.prompt?.value,
        filterEmptyPrompts === false
          ? [
              { type: 'user', message: '' },
              { type: 'user', message: '' },
              { type: 'user', message: 'kept' },
            ]
          : [{ type: 'user', message: 'kept' }],
      );
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

  it('keeps original text, rich content, tool exchanges and reasoning-only messages intact', async () => {
    const chartNode = AssemblePromptNodeImpl.create();
    chartNode.data.filterEmptyPrompts = true;
    const kept: ChatMessage[] = [
      { type: 'user', message: '  Keep this spacing\n' },
      { type: 'user', message: '0' },
      { type: 'user', message: ['', { type: 'image', mediaType: 'image/png', data: new Uint8Array([1]) }] },
      {
        type: 'user',
        message: [
          {
            type: 'document',
            mediaType: 'application/pdf',
            data: new Uint8Array([2]),
            title: 'File',
            context: undefined,
            enableCitations: true,
          },
        ],
      },
      {
        type: 'assistant',
        message: '',
        function_call: { id: 'call-legacy', name: 'lookup', arguments: '{}' },
        function_calls: undefined,
      },
      { type: 'function', name: 'lookup', toolName: 'lookup', message: '' },
      {
        type: 'assistant',
        message: [],
        function_call: undefined,
        function_calls: undefined,
        openRouterReasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-fixture' }],
      },
    ];
    const result = await new AssemblePromptNodeImpl(chartNode).process(
      {
        message1: {
          type: 'chat-message[]',
          value: [
            {
              type: 'assistant',
              message: ' ',
              function_call: undefined,
              function_calls: [],
              openRouterReasoningDetails: [],
            },
            ...kept,
          ],
        },
      },
      processContext,
    );
    assert.deepEqual(result.prompt?.value, kept);
    const output = result.prompt?.value as ChatMessage[];
    kept.forEach((value, index) => assert.equal(output[index], value));
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

  it('ignores null and missing Array entries before coercing or filtering messages', async () => {
    const array = await new ArrayNodeImpl(ArrayNodeImpl.create()).process({
      input1: { type: 'any', value: null },
      input2: undefined,
      input3: message({ type: 'user', message: 'Kept' }),
      input4: { type: 'string', value: '  ' },
    });
    const node = new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create());
    const result = await node.process({ message1: array.output }, processContext);
    assert.deepEqual(result.prompt?.value, [{ type: 'user', message: 'Kept' }]);
  });

  it('preserves multipart and reasoning-only messages passed through Array', async () => {
    const kept: ChatMessage[] = [
      { type: 'user', message: ['Caption', { type: 'image', mediaType: 'image/png', data: new Uint8Array([1]) }] },
      {
        type: 'assistant',
        message: [],
        function_call: undefined,
        function_calls: undefined,
        openRouterReasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque-fixture' }],
      },
    ];
    const array = await new ArrayNodeImpl(ArrayNodeImpl.create()).process({
      input1: { type: 'chat-message[]', value: kept },
    });
    const node = new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create());
    const result = await node.process({ message1: array.output }, processContext);
    assert.deepEqual(result.prompt?.value, kept);
  });

  it('ignores deferred empty inputs and evaluates each one once', async () => {
    for (const value of [null, undefined, []]) {
      let calls = 0;
      const node = new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create());
      const result = await node.process(
        {
          message1: {
            type: 'fn<any>',
            value: () => {
              calls++;
              return value;
            },
          },
          message2: message({ type: 'user', message: 'Kept' }),
        },
        processContext,
      );
      assert.deepEqual(result.prompt?.value, [{ type: 'user', message: 'Kept' }]);
      assert.equal(calls, 1);
    }
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
