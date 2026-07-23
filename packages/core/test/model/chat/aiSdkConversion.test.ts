import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { rivetMessagesToAiSdk } from '../../../src/model/chat/aiSdkMessages.js';
import { rivetToolsToAiSdk } from '../../../src/model/chat/aiSdkTools.js';
import type { ChatMessage, GptFunction } from '../../../src/model/DataValue.js';

describe('rivetMessagesToAiSdk', () => {
  it('converts a system message', async () => {
    const messages: ChatMessage[] = [{ type: 'system', message: 'You are helpful.' }];
    const result = await rivetMessagesToAiSdk(messages);

    assert.deepEqual(result, [{ role: 'system', content: 'You are helpful.' }]);
  });

  it('joins multi-part system message with double newlines', async () => {
    const messages: ChatMessage[] = [{ type: 'system', message: ['part1', 'part2'] }];
    const result = await rivetMessagesToAiSdk(messages);

    assert.deepEqual(result, [{ role: 'system', content: 'part1\n\npart2' }]);
  });

  it('converts a simple user text message', async () => {
    const messages: ChatMessage[] = [{ type: 'user', message: 'Hello' }];
    const result = await rivetMessagesToAiSdk(messages);

    assert.deepEqual(result, [{ role: 'user', content: 'Hello' }]);
  });

  it('converts a user message with an inline image', async () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const messages: ChatMessage[] = [
      {
        type: 'user',
        message: ['Describe this image', { type: 'image', mediaType: 'image/png', data: imageData }],
      },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    assert.equal(result.length, 1);
    assert.equal(result[0]!.role, 'user');
    assert.ok(Array.isArray(result[0]!.content));

    const parts = result[0]!.content as any[];
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Describe this image');
    assert.equal(parts[1].type, 'image');
    assert.deepEqual(parts[1].image, imageData);
    assert.equal(parts[1].mediaType, 'image/png');
  });

  it('converts a user message with a URL image', async () => {
    const messages: ChatMessage[] = [
      {
        type: 'user',
        message: [{ type: 'url', url: 'https://example.com/image.png' }],
      },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    const parts = result[0]!.content as any[];
    assert.equal(parts[0].type, 'image');
    assert.ok(parts[0].image instanceof URL);
    assert.equal(parts[0].image.href, 'https://example.com/image.png');
  });

  it('converts a user message with a document', async () => {
    const docData = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const messages: ChatMessage[] = [
      {
        type: 'user',
        message: [
          {
            type: 'document',
            title: 'Report',
            context: undefined,
            mediaType: 'application/pdf' as const,
            data: docData,
            enableCitations: false,
          },
        ],
      },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    const parts = result[0]!.content as any[];
    assert.equal(parts[0].type, 'file');
    assert.deepEqual(parts[0].data, docData);
    assert.equal(parts[0].mediaType, 'application/pdf');
  });

  it('converts an assistant message with tool calls', async () => {
    const messages: ChatMessage[] = [
      {
        type: 'assistant',
        message: 'Let me look that up.',
        function_call: undefined,
        function_calls: [{ id: 'call_1', name: 'search', arguments: '{"query":"test"}' }],
      },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    assert.equal(result[0]!.role, 'assistant');
    const parts = result[0]!.content as any[];
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Let me look that up.');
    assert.equal(parts[1].type, 'tool-call');
    assert.equal(parts[1].toolCallId, 'call_1');
    assert.equal(parts[1].toolName, 'search');
    assert.deepEqual(parts[1].input, { query: 'test' });
  });

  it('falls back to deprecated function_call field', async () => {
    const messages: ChatMessage[] = [
      {
        type: 'assistant',
        message: '',
        function_call: { id: 'fc_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
        function_calls: undefined,
      },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    const parts = result[0]!.content as any[];
    const toolCall = parts.find((p: any) => p.type === 'tool-call');
    assert.equal(toolCall.toolCallId, 'fc_1');
    assert.equal(toolCall.toolName, 'get_weather');
    assert.deepEqual(toolCall.input, { city: 'NYC' });
  });

  it('converts a function response message to tool role', async () => {
    const messages: ChatMessage[] = [
      { type: 'function', message: '{"result": 42}', name: 'call_1', toolName: 'search' },
    ];
    const result = await rivetMessagesToAiSdk(messages);

    assert.equal(result[0]!.role, 'tool');
    const parts = result[0]!.content as any[];
    assert.equal(parts[0].type, 'tool-result');
    assert.equal(parts[0].toolCallId, 'call_1');
    assert.equal(parts[0].toolName, 'search');
    assert.deepEqual(parts[0].output, { type: 'text', value: '{"result": 42}' });
  });

  it('returns empty array for empty input', async () => {
    const result = await rivetMessagesToAiSdk([]);
    assert.deepEqual(result, []);
  });
});

describe('rivetToolsToAiSdk', () => {
  it('converts GptFunction array to AI SDK tool map', () => {
    const functions: GptFunction[] = [
      {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
        strict: false,
        resultHandling: 'return-direct',
      },
    ];

    const tools = rivetToolsToAiSdk(functions);

    assert.ok('get_weather' in tools);
    assert.equal(tools['get_weather']!.description, 'Get weather for a city');
    assert.ok(tools['get_weather']!.inputSchema);
    assert.equal('resultHandling' in tools['get_weather']!, false);
  });

  it('handles multiple functions', () => {
    const functions: GptFunction[] = [
      { name: 'foo', description: 'Foo', parameters: {}, strict: false },
      { name: 'bar', description: 'Bar', parameters: {}, strict: false },
    ];

    const tools = rivetToolsToAiSdk(functions);

    assert.ok('foo' in tools);
    assert.ok('bar' in tools);
  });

  it('returns empty object for empty array', () => {
    const tools = rivetToolsToAiSdk([]);
    assert.deepEqual(tools, {});
  });
});
