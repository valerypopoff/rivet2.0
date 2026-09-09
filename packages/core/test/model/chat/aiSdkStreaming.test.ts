import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { consumeAiSdkStream } from '../../../src/model/chat/aiSdkStreaming.js';
import type { TextStreamPart, ToolSet } from 'ai';

type StreamPart = TextStreamPart<ToolSet>;

async function* mockStream(parts: StreamPart[]): AsyncGenerator<StreamPart> {
  for (const part of parts) {
    yield part;
  }
}

describe('consumeAiSdkStream', () => {
  it('accumulates text deltas and calls onPartialOutputs', async () => {
    const parts: StreamPart[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Hello' },
      { type: 'text-delta', id: 't1', text: ' world' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
        },
      },
    ];

    const calls: string[] = [];
    const onPartialOutputs = (text: string) => {
      calls.push(text);
    };

    const result = await consumeAiSdkStream(mockStream(parts), onPartialOutputs);

    assert.equal(result.responseText, 'Hello world');
    assert.deepEqual(calls, ['Hello', 'Hello world']);
    assert.equal(result.usage?.inputTokens, 10);
    assert.equal(result.usage?.outputTokens, 5);
    assert.equal(result.functionCalls.length, 0);
    assert.equal(result.reasoning, '');
  });

  it('keeps separate text blocks unless duplicate text-block de-duping is enabled', async () => {
    const parts: StreamPart[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: '{"answer":"yes"}' },
      { type: 'text-end', id: 't1' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', text: '{"answer":"yes"}' },
      { type: 'text-end', id: 't2' },
    ];

    const result = await consumeAiSdkStream(mockStream(parts), () => {});
    const dedupedResult = await consumeAiSdkStream(mockStream(parts), () => {}, {
      dedupeDuplicateTextBlocks: true,
    });

    assert.equal(result.responseText, '{"answer":"yes"}{"answer":"yes"}');
    assert.equal(dedupedResult.responseText, '{"answer":"yes"}');
  });

  it('does not append a duplicate text block while the duplicate block is still streaming', async () => {
    const parts: StreamPart[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: '{"answer":"yes"}' },
      { type: 'text-end', id: 't1' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', text: '{"answer"' },
    ];
    const calls: string[] = [];

    const result = await consumeAiSdkStream(
      mockStream(parts),
      (text) => {
        calls.push(text);
      },
      {
        dedupeDuplicateTextBlocks: true,
      },
    );

    assert.deepEqual(calls, ['{"answer":"yes"}', '{"answer":"yes"}']);
    assert.equal(result.responseText, '{"answer":"yes"}');
  });

  it('handles tool calls', async () => {
    const parts: StreamPart[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Calling tool' },
      { type: 'text-end', id: 't1' },
      {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'get_weather',
        input: { city: 'NYC' },
      } as StreamPart,
      {
        type: 'finish',
        finishReason: 'tool-calls',
        rawFinishReason: undefined,
        totalUsage: {
          inputTokens: 20,
          outputTokens: 15,
          totalTokens: 35,
          inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 15, reasoningTokens: undefined },
        },
      },
    ];

    const result = await consumeAiSdkStream(mockStream(parts), () => {});

    assert.equal(result.responseText, 'Calling tool');
    assert.equal(result.functionCalls.length, 1);
    assert.equal(result.functionCalls[0]!.id, 'call_123');
    assert.equal(result.functionCalls[0]!.name, 'get_weather');
    assert.equal(result.functionCalls[0]!.arguments, '{"city":"NYC"}');
    assert.deepEqual(result.functionCalls[0]!.lastParsedArguments, { city: 'NYC' });
  });

  it('accumulates reasoning deltas', async () => {
    const parts: StreamPart[] = [
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'Let me think' },
      { type: 'reasoning-delta', id: 'r1', text: ' about this' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Answer' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: {
          inputTokens: 5,
          outputTokens: 10,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 3, reasoningTokens: 7 },
        },
      },
    ];

    const partialReasoning: string[] = [];
    const result = await consumeAiSdkStream(mockStream(parts), (_text, _calls, reasoning) => {
      partialReasoning.push(reasoning);
    });

    assert.equal(result.reasoning, 'Let me think about this');
    assert.equal(result.responseText, 'Answer');
    assert.deepEqual(partialReasoning, ['Let me think', 'Let me think about this', 'Let me think about this']);
  });

  it('throws on error part', async () => {
    const parts: StreamPart[] = [
      { type: 'error', error: new Error('API failure') },
    ];

    await assert.rejects(
      () => consumeAiSdkStream(mockStream(parts), () => {}),
      { message: 'API failure' },
    );
  });

  it('returns empty result for empty stream', async () => {
    const result = await consumeAiSdkStream(mockStream([]), () => {});

    assert.equal(result.responseText, '');
    assert.equal(result.functionCalls.length, 0);
    assert.equal(result.usage, undefined);
    assert.equal(result.reasoning, '');
  });
});
