import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ChatMessage, ChatMessageDataValue, GptFunction } from '../../../src/model/DataValue.js';
import type { Outputs } from '../../../src/model/GraphProcessor.js';
import type {
  ChatV2NormalizedUsage,
  ChatV2PipelineResult,
  ChatV2ReasoningOutput,
  RunChatV2PipelineOptions,
} from '../../../src/model/chat-v2/chatV2Types.js';
import {
  runChatV2PipelineWithToolContinuation,
  type ToolContinuationToolResult,
} from '../../../src/model/chat-v2/toolContinuation.js';
import type { StreamedFunctionCall } from '../../../src/model/chat/streamChatResponse.js';

function makeToolCall(id: string, name: string, args: object = {}): StreamedFunctionCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
    lastParsedArguments: args,
  };
}

function makeToolResultMessage(toolCall: StreamedFunctionCall, value: string): ChatMessageDataValue {
  return {
    type: 'chat-message',
    value: {
      type: 'function',
      name: toolCall.id,
      toolName: toolCall.name,
      message: value,
    },
  };
}

function makeDelegatedToolResultMessage(toolCall: StreamedFunctionCall, value: string): ToolContinuationToolResult {
  const message = makeToolResultMessage(toolCall, value).value;

  return {
    type: 'chat-message',
    value: message,
    delegatedToolCall: {
      delegatedToolCall: true,
      name: toolCall.name,
      arguments: toolCall.lastParsedArguments ?? {},
      id: toolCall.id,
      output: value,
      message,
    },
  };
}

function makePipelineResult(
  response: string,
  functionCalls: StreamedFunctionCall[],
  requestMessages: ChatMessage[] = [{ type: 'user', message: 'Hello' }],
  usage?: ChatV2NormalizedUsage,
  outputUsage = false,
  reasoning: ChatV2ReasoningOutput = '',
  outputReasoning = false,
): ChatV2PipelineResult {
  const allMessages: ChatMessage[] = [
    ...requestMessages,
    {
      type: 'assistant',
      message: response,
      function_call:
        functionCalls.length === 1
          ? {
              id: functionCalls[0]!.id,
              name: functionCalls[0]!.name,
              arguments: functionCalls[0]!.arguments,
            }
          : undefined,
      function_calls:
        functionCalls.length > 0
          ? functionCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            }))
          : undefined,
    },
  ];
  const commonOutputs: Outputs = {
    response: { type: 'string', value: response },
    'in-messages': { type: 'chat-message[]', value: requestMessages },
    'all-messages': { type: 'chat-message[]', value: allMessages },
  };

  if (outputUsage) {
    commonOutputs.usage = {
      type: 'object',
      value: usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalCost: undefined,
      },
    };
  }

  if (outputReasoning) {
    commonOutputs.reasoning = {
      type: Array.isArray(reasoning) ? 'string[]' : 'string',
      value: reasoning,
    };
  }

  return {
    commonOutputs,
    requestMessages,
    allMessages,
    response,
    functionCalls,
    reasoning,
    usage,
    rawUsage: undefined,
    finishReason: functionCalls.length > 0 ? 'tool-calls' : 'stop',
    providerMetadata: undefined,
  };
}

function makeUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  cachedTokens: number,
  reasoningTokens: number,
  totalCost: number | undefined,
): ChatV2NormalizedUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    totalCost,
  };
}

function makeFunction(name: string, resultHandling: GptFunction['resultHandling'] = 'continue'): GptFunction {
  return {
    name,
    description: `${name} tool`,
    parameters: {},
    strict: false,
    resultHandling,
  };
}

function baseOptions(
  overrides: Partial<Parameters<typeof runChatV2PipelineWithToolContinuation>[0]> = {},
): Parameters<typeof runChatV2PipelineWithToolContinuation>[0] {
  return {
    provider: 'openai',
    model: {} as any,
    modelId: 'gpt-test',
    prompt: { type: 'string', value: 'Hello' },
    functions: [makeFunction('foo')],
    context: {
      signal: new AbortController().signal,
    },
    autoContinue: true,
    maxToolRounds: 3,
    delegateToolCall: async (toolCall) => makeToolResultMessage(toolCall, `${toolCall.name} result`),
    runPipeline: async () => makePipelineResult('done', []),
    ...overrides,
  };
}

describe('runChatV2PipelineWithToolContinuation', () => {
  it('returns the first model result when auto-continue is disabled', async () => {
    const firstResult = makePipelineResult('', [makeToolCall('call_1', 'foo')]);
    let runCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        autoContinue: false,
        runPipeline: async () => {
          runCount++;
          return firstResult;
        },
      }),
    );

    assert.equal(runCount, 1);
    assert.equal(result, firstResult);
  });

  it('does not execute a tool from a provider-failure diagnostic result', async () => {
    const failedToolCall = makeToolCall('call_failed', 'foo');
    const failedResult = makePipelineResult('partial provider content', [failedToolCall]);
    failedResult.terminalOutcome = 'provider-failure';
    let delegated = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        runPipeline: async () => failedResult,
        delegateToolCall: async (toolCall) => {
          delegated += 1;
          return makeToolResultMessage(toolCall, 'must not run');
        },
      }),
    );

    assert.strictEqual(result, failedResult);
    assert.equal(delegated, 0);
  });

  it('delegates all tool calls in a round before asking the model again', async () => {
    const fooCall = makeToolCall('call_foo', 'foo');
    const barCall = makeToolCall('call_bar', 'bar');
    const prompts: unknown[] = [];
    const pipelineFunctions: Array<GptFunction[] | undefined> = [];
    const delegated: string[] = [];

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo'), makeFunction('bar')],
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          prompts.push(options.prompt);
          pipelineFunctions.push(options.functions);

          return prompts.length === 1
            ? makePipelineResult('', [fooCall, barCall])
            : makePipelineResult('final answer', [], (options.prompt as any).value);
        },
        delegateToolCall: async (toolCall) => {
          delegated.push(toolCall.name);
          return makeToolResultMessage(toolCall, `${toolCall.name} result`);
        },
      }),
    );

    assert.deepEqual(delegated, ['foo', 'bar']);
    assert.equal(result.response, 'final answer');
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      pipelineFunctions.map((functions) => functions?.map((fn) => fn.name)),
      [
        ['foo', 'bar'],
        ['foo', 'bar'],
      ],
    );

    const secondPromptMessages = (prompts[1] as any).value as ChatMessage[];
    assert.equal(secondPromptMessages.at(-2)?.type, 'function');
    assert.equal((secondPromptMessages.at(-2) as any).toolName, 'foo');
    assert.equal(secondPromptMessages.at(-1)?.type, 'function');
    assert.equal((secondPromptMessages.at(-1) as any).toolName, 'bar');
  });

  it('captures one immutable page per completed logical model round', async () => {
    const firstToolCall = makeToolCall('call_1', 'foo');
    const secondToolCall = makeToolCall('call_2', 'foo');
    const completedPages: Array<{ entryId: string; roundIndex: number; response: string }> = [];
    const terminalPages: Array<{ entryId: string; roundIndex: number; outcome: string }> = [];
    let providerCalls = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        runPipeline: async (options) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return makePipelineResult('first tool request', [firstToolCall], (options.prompt as any).value);
          }
          if (providerCalls === 2) {
            return makePipelineResult('second tool request', [secondToolCall], (options.prompt as any).value);
          }
          return makePipelineResult('final answer', [], (options.prompt as any).value);
        },
        onCompletedModelRound: (snapshot) => {
          completedPages.push({
            entryId: snapshot.entryId,
            roundIndex: snapshot.roundIndex,
            response: String(snapshot.outputs.response?.value),
          });
        },
        onTerminalRound: (snapshot) => {
          terminalPages.push({
            entryId: snapshot.entryId,
            roundIndex: snapshot.roundIndex,
            outcome: snapshot.outcome,
          });
        },
      }),
    );

    assert.equal(providerCalls, 3);
    assert.deepEqual(completedPages, [
      { entryId: 'model-round:0', roundIndex: 0, response: 'first tool request' },
      { entryId: 'model-round:1', roundIndex: 1, response: 'second tool request' },
    ]);
    assert.deepEqual(terminalPages, [{ entryId: 'model-round:2', roundIndex: 2, outcome: 'final-answer' }]);

    // Mutating a later terminal result cannot rewrite an already emitted page.
    (result.commonOutputs.response as any).value = 'mutated terminal output';
    assert.deepEqual(completedPages, [
      { entryId: 'model-round:0', roundIndex: 0, response: 'first tool request' },
      { entryId: 'model-round:1', roundIndex: 1, response: 'second tool request' },
    ]);
  });

  it('returns the exact sole direct tool result without another provider request', async () => {
    const directMarkdown = 'Dear user, here is your JSON:\n\n```json\n{\n  "example": true\n}\n```';
    const firstUsage = makeUsage(12, 3, 15, 2, 1, 0.002);
    const toolCall = makeToolCall('call_direct', 'exportJson');
    let pipelineRunCount = 0;
    let delegationCount = 0;

    const completedPages: string[] = [];
    const terminalPages: Array<{ entryId: string; kind: string; outcome: string }> = [];
    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('exportJson', 'return-direct')],
        includeFunctionCalls: true,
        outputUsage: true,
        outputReasoning: true,
        runPipeline: async (options) => {
          pipelineRunCount++;
          return makePipelineResult(
            'Preparing the export.',
            [toolCall],
            undefined,
            firstUsage,
            options.outputUsage,
            'Use the deterministic exporter.',
            options.outputReasoning,
          );
        },
        delegateToolCall: async (call) => {
          delegationCount++;
          return makeDelegatedToolResultMessage(call, directMarkdown);
        },
        onCompletedModelRound: (snapshot) => completedPages.push(snapshot.entryId),
        onTerminalRound: (snapshot) =>
          terminalPages.push({ entryId: snapshot.entryId, kind: snapshot.kind, outcome: snapshot.outcome }),
      }),
    );

    assert.equal(pipelineRunCount, 1);
    assert.equal(delegationCount, 1);
    assert.equal(result.response, directMarkdown);
    assert.deepEqual(result.functionCalls, []);
    assert.equal(result.allMessages.at(-1)?.type, 'function');
    assert.equal((result.allMessages.at(-1) as any).message, directMarkdown);
    assert.equal(result.requestMessages.length, 1);
    assert.deepEqual(result.commonOutputs.response, { type: 'string', value: directMarkdown });
    assert.deepEqual(result.commonOutputs['in-messages'], {
      type: 'chat-message[]',
      value: result.requestMessages,
    });
    assert.deepEqual(result.commonOutputs.usage, { type: 'object', value: firstUsage });
    assert.equal('responseTokens' in result.commonOutputs, false);
    assert.deepEqual(result.commonOutputs.reasoning, {
      type: 'string[]',
      value: ['Use the deterministic exporter.'],
    });
    assert.deepEqual(
      (result.commonOutputs['function-calls']?.value as any[]).map(({ name, output }) => ({ name, output })),
      [{ name: 'exportJson', output: directMarkdown }],
    );
    assert.deepEqual(completedPages, ['model-round:0']);
    assert.deepEqual(terminalPages, [
      { entryId: 'direct-tool-result:0', kind: 'direct-tool-result', outcome: 'direct-tool-result' },
    ]);
  });

  it('supports direct return through the connected Delegate round callback', async () => {
    const toolCall = makeToolCall('call_direct', 'exportJson');
    let pipelineRunCount = 0;
    let fallbackCount = 0;
    let roundCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('exportJson', 'return-direct')],
        runPipeline: async () => {
          pipelineRunCount++;
          return makePipelineResult('Exporting.', [toolCall]);
        },
        delegateToolCall: async (call) => {
          fallbackCount++;
          return makeDelegatedToolResultMessage(call, 'fallback');
        },
        delegateToolCallRound: async (calls, preToolMessage) => {
          roundCount++;
          assert.equal(preToolMessage, 'Exporting.');
          return [makeDelegatedToolResultMessage(calls[0]!, 'direct result')];
        },
      }),
    );

    assert.equal(pipelineRunCount, 1);
    assert.equal(fallbackCount, 0);
    assert.equal(roundCount, 1);
    assert.equal(result.response, 'direct result');
  });

  it('uses normal continuation when a round contains multiple direct-return calls', async () => {
    const calls = [makeToolCall('call_foo', 'foo'), makeToolCall('call_bar', 'bar')];
    let pipelineRunCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo', 'return-direct'), makeFunction('bar', 'return-direct')],
        runPipeline: async (options) => {
          pipelineRunCount++;
          return pipelineRunCount === 1
            ? makePipelineResult('', calls)
            : makePipelineResult('combined answer', [], (options.prompt as any).value);
        },
      }),
    );

    assert.equal(pipelineRunCount, 2);
    assert.equal(result.response, 'combined answer');
  });

  it('uses normal continuation when a round mixes direct and continuing tools', async () => {
    const calls = [makeToolCall('call_foo', 'foo'), makeToolCall('call_bar', 'bar')];
    let pipelineRunCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo', 'return-direct'), makeFunction('bar')],
        runPipeline: async (options) => {
          pipelineRunCount++;
          return pipelineRunCount === 1
            ? makePipelineResult('', calls)
            : makePipelineResult('combined answer', [], (options.prompt as any).value);
        },
      }),
    );

    assert.equal(pipelineRunCount, 2);
    assert.equal(result.response, 'combined answer');
  });

  it('delegates a complete model round through the connected Delegate callback', async () => {
    const fooCall = makeToolCall('call_foo', 'foo');
    const barCall = makeToolCall('call_bar', 'bar');
    const rounds: Array<{ calls: StreamedFunctionCall[]; preToolMessage: string }> = [];
    let pipelineRunCount = 0;
    let singleCallFallbackCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo'), makeFunction('bar')],
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          pipelineRunCount++;
          return pipelineRunCount === 1
            ? makePipelineResult('I will run both tools.', [fooCall, barCall])
            : makePipelineResult('final answer', [], (options.prompt as any).value);
        },
        delegateToolCall: async (toolCall) => {
          singleCallFallbackCount++;
          return makeDelegatedToolResultMessage(toolCall, 'fallback');
        },
        delegateToolCallRound: async (calls, preToolMessage) => {
          rounds.push({ calls, preToolMessage });
          return calls.map((call) => makeDelegatedToolResultMessage(call, `${call.name} result`));
        },
      }),
    );

    assert.equal(singleCallFallbackCount, 0);
    assert.equal(rounds.length, 1);
    assert.deepEqual(
      rounds[0]!.calls.map((call) => call.id),
      ['call_foo', 'call_bar'],
    );
    assert.equal(rounds[0]!.preToolMessage, 'I will run both tools.');
    assert.equal(result.response, 'final answer');
    const secondPromptMessages = result.requestMessages;
    assert.equal(secondPromptMessages.at(-2)?.type, 'function');
    assert.equal((secondPromptMessages.at(-2) as any).toolName, 'foo');
    assert.equal(secondPromptMessages.at(-1)?.type, 'function');
    assert.equal((secondPromptMessages.at(-1) as any).toolName, 'bar');
  });

  it('emits delegated tool call records when auto-continue reaches a final answer', async () => {
    const fooCall = makeToolCall('call_foo', 'foo');
    const barCall = makeToolCall('call_bar', 'bar');
    const delegated: string[] = [];

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo'), makeFunction('bar')],
        includeFunctionCalls: true,
        runPipeline: async (options: RunChatV2PipelineOptions) =>
          delegated.length === 0
            ? makePipelineResult('', [fooCall, barCall])
            : makePipelineResult('final answer', [], (options.prompt as any).value),
        delegateToolCall: async (toolCall) => {
          delegated.push(toolCall.name);
          return makeDelegatedToolResultMessage(toolCall, `${toolCall.name} result`);
        },
      }),
    );

    const functionCallsOutput = result.commonOutputs['function-calls' as keyof Outputs];

    assert.equal(result.response, 'final answer');
    assert.equal(functionCallsOutput?.type, 'object[]');
    assert.deepEqual(
      functionCallsOutput?.value.map((record: any) => ({
        delegatedToolCall: record.delegatedToolCall,
        name: record.name,
        output: record.output,
      })),
      [
        { delegatedToolCall: true, name: 'foo', output: 'foo result' },
        { delegatedToolCall: true, name: 'bar', output: 'bar result' },
      ],
    );
  });

  it('sums token usage across auto-continued model rounds', async () => {
    const toolRoundUsage = makeUsage(10, 2, 12, 1, 0, 0.001);
    const finalRoundUsage = makeUsage(20, 5, 25, 3, 1, 0.004);
    const fooCall = makeToolCall('call_foo', 'foo');
    let runCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        outputUsage: true,
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          runCount++;

          return runCount === 1
            ? makePipelineResult('', [fooCall], undefined, toolRoundUsage, options.outputUsage)
            : makePipelineResult(
                'final answer',
                [],
                (options.prompt as any).value,
                finalRoundUsage,
                options.outputUsage,
              );
        },
        delegateToolCall: async (toolCall) => makeToolResultMessage(toolCall, `${toolCall.name} result`),
      }),
    );

    assert.equal(runCount, 2);
    assert.deepEqual(result.usage, {
      promptTokens: 30,
      completionTokens: 7,
      totalTokens: 37,
      cachedTokens: 4,
      reasoningTokens: 1,
      totalCost: 0.005,
    });
    assert.equal('responseTokens' in result.commonOutputs, false);
    assert.deepEqual(result.commonOutputs.usage, { type: 'object', value: result.usage });
  });

  it('accumulates reasoning output across auto-continued model rounds', async () => {
    const fooCall = makeToolCall('call_foo', 'foo');
    let runCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        outputReasoning: true,
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          runCount++;

          return runCount === 1
            ? makePipelineResult('', [fooCall], undefined, undefined, false, 'Need a tool.', options.outputReasoning)
            : makePipelineResult(
                'final answer',
                [],
                (options.prompt as any).value,
                undefined,
                false,
                'Use the tool result.',
                options.outputReasoning,
              );
        },
        delegateToolCall: async (toolCall) => makeToolResultMessage(toolCall, `${toolCall.name} result`),
      }),
    );

    assert.equal(runCount, 2);
    assert.deepEqual(result.reasoning, ['Need a tool.', 'Use the tool result.']);
    assert.deepEqual(result.commonOutputs.reasoning, {
      type: 'string[]',
      value: result.reasoning,
    });
  });

  it('ignores missing reasoning output across auto-continued model rounds', async () => {
    const fooCall = makeToolCall('call_foo', 'foo');
    let runCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        outputReasoning: true,
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          runCount++;

          return runCount === 1
            ? makePipelineResult(
                '',
                [fooCall],
                undefined,
                undefined,
                false,
                undefined as unknown as ChatV2ReasoningOutput,
                options.outputReasoning,
              )
            : makePipelineResult(
                'final answer',
                [],
                (options.prompt as any).value,
                undefined,
                false,
                'Use the tool result.',
                options.outputReasoning,
              );
        },
        delegateToolCall: async (toolCall) => makeToolResultMessage(toolCall, `${toolCall.name} result`),
      }),
    );

    assert.equal(runCount, 2);
    assert.deepEqual(result.reasoning, ['Use the tool result.']);
    assert.deepEqual(result.commonOutputs.reasoning, {
      type: 'string[]',
      value: result.reasoning,
    });
  });

  it('stops auto-continuing after max tool rounds', async () => {
    const delegated: string[] = [];
    let runCount = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        outputUsage: true,
        maxToolRounds: 1,
        runPipeline: async (options: RunChatV2PipelineOptions) => {
          runCount++;
          return makePipelineResult(
            '',
            [makeToolCall(`call_${runCount}`, 'foo')],
            undefined,
            makeUsage(runCount * 10, runCount, runCount * 10 + runCount, 0, 0, undefined),
            options.outputUsage,
          );
        },
        delegateToolCall: async (toolCall) => {
          delegated.push(toolCall.id);
          return makeToolResultMessage(toolCall, 'result');
        },
      }),
    );

    assert.equal(runCount, 2);
    assert.deepEqual(delegated, ['call_1']);
    assert.equal(result.functionCalls[0]?.id, 'call_2');
    assert.deepEqual(result.usage, {
      promptTokens: 30,
      completionTokens: 3,
      totalTokens: 33,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalCost: undefined,
    });
    assert.equal('responseTokens' in result.commonOutputs, false);
    assert.deepEqual(result.commonOutputs.usage, { type: 'object', value: result.usage });
  });

  it('allows 21 calls across ten batches but does not auto-continue an eleventh batch', async () => {
    const firstTenBatches = Array.from({ length: 10 }, (_, roundIndex) =>
      Array.from({ length: roundIndex === 0 ? 3 : 2 }, (_, callIndex) =>
        makeToolCall(`call_${roundIndex + 1}_${callIndex + 1}`, 'foo', {
          round: roundIndex + 1,
          call: callIndex + 1,
        }),
      ),
    );
    const delegatedBatches: string[][] = [];
    let providerCalls = 0;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        maxToolRounds: 10,
        runPipeline: async () => {
          providerCalls++;
          const batch = firstTenBatches[providerCalls - 1] ?? [makeToolCall('call_11_1', 'foo')];
          return makePipelineResult('', batch);
        },
        delegateToolCallRound: async (toolCalls) => {
          delegatedBatches.push(toolCalls.map((toolCall) => toolCall.id));
          return toolCalls.map((toolCall) => makeDelegatedToolResultMessage(toolCall, `${toolCall.id} result`));
        },
      }),
    );

    assert.equal(providerCalls, 11);
    assert.equal(delegatedBatches.length, 10);
    assert.deepEqual(
      delegatedBatches,
      firstTenBatches.map((batch) => batch.map((toolCall) => toolCall.id)),
    );
    assert.equal(delegatedBatches.flat().length, 21);
    assert.deepEqual(
      result.functionCalls.map((toolCall) => toolCall.id),
      ['call_11_1'],
    );
  });

  it('does not auto-continue unknown tool calls', async () => {
    let delegated = false;

    const result = await runChatV2PipelineWithToolContinuation(
      baseOptions({
        functions: [makeFunction('foo')],
        runPipeline: async () => makePipelineResult('', [makeToolCall('call_bar', 'bar')]),
        delegateToolCall: async (toolCall) => {
          delegated = true;
          return makeToolResultMessage(toolCall, 'result');
        },
      }),
    );

    assert.equal(delegated, false);
    assert.equal(result.functionCalls[0]?.name, 'bar');
  });
});
