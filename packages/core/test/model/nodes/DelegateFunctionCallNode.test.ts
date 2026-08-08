import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DelegateFunctionCallNodeImpl,
  findAutoDelegateGraphCandidate,
  type DelegateFunctionCallNode,
  type GraphId,
  type InternalProcessContext,
  type NodeId,
  type Outputs,
  type PortId,
  type ProcessId,
  type ToolCallFinishedEvent,
} from '../../../src/index.js';
import { applyStreamedFunctionCallOutputs } from '../../../src/model/chat/streamChatResponse.js';

function createNode(data: Partial<DelegateFunctionCallNode['data']> = {}) {
  return new DelegateFunctionCallNodeImpl({
    ...DelegateFunctionCallNodeImpl.create(),
    data: {
      ...DelegateFunctionCallNodeImpl.create().data,
      ...data,
    },
  });
}

function createContext(onExternalFunction: (argumentsValue: Record<string, unknown>) => unknown) {
  return {
    project: {
      graphs: {},
    },
    externalFunctions: {
      foo: (_context: InternalProcessContext, argumentsValue: Record<string, unknown>) =>
        onExternalFunction(argumentsValue),
    },
    signal: new AbortController().signal,
  } as unknown as InternalProcessContext;
}

function createSubgraphContext(
  graphs: Array<{ id: GraphId; name: string }>,
  onProcessGraph: (graphId: GraphId) => Outputs,
) {
  return {
    project: {
      graphs: Object.fromEntries(
        graphs.map(({ id, name }) => [
          id,
          {
            metadata: { id, name },
            nodes: [],
            connections: [],
          },
        ]),
      ),
    },
    externalFunctions: {},
    signal: new AbortController().signal,
    contextValues: {},
    createSubProcessor: (graphId: GraphId) => ({
      processGraph: async () => onProcessGraph(graphId),
    }),
  } as unknown as InternalProcessContext;
}

function delegatedToolCallRecord(name: string, output: string, id = `call_${name}`, executionTimeMs?: number) {
  return {
    delegatedToolCall: true,
    name,
    arguments: {},
    id,
    output,
    ...(executionTimeMs == null ? {} : { executionTimeMs }),
    message: {
      type: 'function',
      message: output,
      name: id,
      toolName: name,
    },
  };
}

describe('DelegateFunctionCallNodeImpl', () => {
  it('resolves ordered auto-delegate candidates through exact then containing name matches', () => {
    const candidates = [
      { id: 'partial-first', name: 'weather helper' },
      { id: 'exact-later', name: 'weather' },
      { id: 'partial-later', name: 'weather fallback' },
    ];

    assert.equal(
      findAutoDelegateGraphCandidate(candidates, 'weather', (candidate) => candidate.name)?.id,
      'exact-later',
    );
    assert.equal(
      findAutoDelegateGraphCandidate(candidates, 'unknown', (candidate) => candidate.name),
      undefined,
    );
    assert.equal(
      findAutoDelegateGraphCandidate(
        candidates.filter((candidate) => candidate.name !== 'weather'),
        'weather',
        (candidate) => candidate.name,
      )?.id,
      'partial-first',
    );
  });

  it('does not require a setting to enable its pre-tool message output', () => {
    const node = DelegateFunctionCallNodeImpl.create();
    const editors = createNode().getEditors();

    assert.equal('runAssistantMessageImmediately' in node.data, false);
    assert.equal(
      editors.some((editor) => 'dataKey' in editor && editor.dataKey === 'autoDelegate'),
      true,
    );
    assert.equal(
      editors.some((editor) => 'dataKey' in editor && editor.dataKey === 'runAssistantMessageImmediately'),
      false,
    );
  });

  it('delegates a direct function call object', async () => {
    const node = createNode();
    let receivedArguments: Record<string, unknown> | undefined;
    const result = await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: {
            name: 'foo',
            arguments: { value: 123 },
            id: 'call_1',
          },
        },
      },
      createContext((argumentsValue) => {
        receivedArguments = argumentsValue;
        return 'ok';
      }),
    );

    assert.deepEqual(receivedArguments, { value: 123 });
    assert.deepEqual(Object.keys(result), [
      'tool-name',
      'tool-arguments',
      'assistant-message',
      'output',
      'execution-time',
      'message',
    ]);
    assert.deepEqual(result['tool-name' as PortId], { type: 'string', value: 'foo' });
    assert.deepEqual(result['tool-arguments' as PortId], { type: 'object', value: { value: 123 } });
    assert.equal(result.output?.value, 'ok');
    assert.equal(result['execution-time' as PortId]?.type, 'number');
    assert.ok((result['execution-time' as PortId]?.value as number) >= 0);
    assert.deepEqual(result.message?.value, {
      type: 'function',
      message: 'ok',
      name: 'call_1',
      toolName: 'foo',
    });
    assert.deepEqual(result['assistant-message' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  it('reports one privacy-bounded execution event without exposing tool arguments or results', async () => {
    const events: ToolCallFinishedEvent[] = [];
    const node = createNode();
    const context = createContext(() => 'private result');
    context.node = node.chartNode;
    context.processId = 'delegate-process' as ProcessId;
    context.toolCallTraceSource = {
      nodeId: 'llm-node' as NodeId,
      processId: 'llm-process' as ProcessId,
    };
    context.onToolCallFinished = (event) => events.push(event);

    await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: { secret: 'private' }, id: 'call_1' },
        },
      },
      context,
    );

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      toolCallId: 'call_1',
      toolName: 'foo',
      sourceNodeId: 'llm-node',
      sourceProcessId: 'llm-process',
      resultOwner: {
        nodeId: node.id,
        processId: 'delegate-process',
        outputPortId: 'output',
      },
      handlerKind: 'external',
      handlerName: 'foo',
      outcome: 'success',
      startedAt: events[0]!.startedAt,
      durationMs: events[0]!.durationMs,
    });
    assert.equal(typeof events[0]!.startedAt, 'number');
    assert.equal(typeof events[0]!.durationMs, 'number');
    assert.equal('arguments' in events[0]!, false);
    assert.equal('result' in events[0]!, false);
  });

  it('does not point a failed delegate invocation at an output that was never persisted', async () => {
    const events: ToolCallFinishedEvent[] = [];
    const node = createNode({ passthroughErrors: false });
    const context = createContext(() => {
      throw new Error('handler failed');
    });
    context.node = node.chartNode;
    context.processId = 'failed-delegate-process' as ProcessId;
    context.onToolCallFinished = (event) => events.push(event);

    await assert.rejects(
      () =>
        node.process(
          {
            ['function-call' as PortId]: {
              type: 'object',
              value: { name: 'foo', arguments: {}, id: 'call_failed' },
            },
          },
          context,
        ),
      /External function call failed for foo: handler failed/,
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.outcome, 'failure');
    assert.equal(events[0]?.resultOwner, undefined);
    assert.equal('resultOwner' in events[0]!, false);
  });

  it('does not let a trace observer failure change successful tool execution', async () => {
    const context = createContext(() => 'ok');
    context.onToolCallFinished = () => {
      throw new Error('observer failure');
    };

    const result = await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: {}, id: 'call_1' },
        },
      },
      context,
    );

    assert.equal(result.output?.value, 'ok');
  });

  it('preserves the cost returned by an external-function fallback', async () => {
    const result = await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: {}, id: 'call_1' },
        },
      },
      createContext(() => ({ type: 'string', value: 'ok', cost: 0.75 })),
    );

    assert.deepEqual(result['cost' as PortId], { type: 'number', value: 0.75 });
  });

  it('prefers an exact auto-delegate graph name and preserves its derived cost', async () => {
    const partialGraphId = 'partial-handler' as GraphId;
    const exactGraphId = 'exact-handler' as GraphId;
    let selectedGraphId: GraphId | undefined;

    const result = await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: {}, id: 'call_1' },
        },
      },
      createSubgraphContext(
        [
          { id: partialGraphId, name: 'foo helper' },
          { id: exactGraphId, name: 'foo' },
        ],
        (graphId) => {
          selectedGraphId = graphId;
          return {
            ['output' as PortId]: { type: 'string', value: 'exact output' },
            ['cost' as PortId]: { type: 'number', value: 1.25 },
          };
        },
      ),
    );

    assert.equal(selectedGraphId, exactGraphId);
    assert.equal(result.output?.value, 'exact output');
    assert.deepEqual(result['cost' as PortId], { type: 'number', value: 1.25 });
  });

  it('keeps Rivet-owned tool inputs safe from reserved and prototype-like arguments', async () => {
    const graphId = 'safe-handler' as GraphId;
    let receivedInputs: Record<string, unknown> | undefined;

    await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: {
            name: 'safe',
            arguments: JSON.parse(
              '{"_function_name":"overwritten","_arguments":{"overwritten":true},"__proto__":{"polluted":true},"ordinary":"value"}',
            ),
            id: 'call_safe',
          },
        },
      },
      {
        project: {
          graphs: {
            [graphId]: { metadata: { id: graphId, name: 'safe' }, nodes: [], connections: [] },
          },
        },
        externalFunctions: {},
        signal: new AbortController().signal,
        contextValues: {},
        createSubProcessor: () => ({
          processGraph: async (_context: unknown, inputs: Record<string, unknown>) => {
            receivedInputs = inputs;
            return { ['output' as PortId]: { type: 'string', value: 'done' } };
          },
        }),
      } as unknown as InternalProcessContext,
    );

    assert.equal(Object.getPrototypeOf(receivedInputs!), null);
    assert.deepEqual(receivedInputs!._function_name, { type: 'string', value: 'safe' });
    assert.deepEqual(receivedInputs!._arguments, {
      type: 'object',
      value: JSON.parse(
        '{"_function_name":"overwritten","_arguments":{"overwritten":true},"__proto__":{"polluted":true},"ordinary":"value"}',
      ),
    });
    assert.deepEqual(receivedInputs!._rivet_tool_call, {
      type: 'object',
      value: {
        id: 'call_safe',
        name: 'safe',
        arguments: JSON.parse(
          '{"_function_name":"overwritten","_arguments":{"overwritten":true},"__proto__":{"polluted":true},"ordinary":"value"}',
        ),
      },
    });
    assert.equal(receivedInputs!.ordinary != null, true);
    assert.equal(Object.prototype.hasOwnProperty.call(receivedInputs!, '__proto__'), true);
    assert.deepEqual(receivedInputs!.__proto__, { type: 'any', value: { polluted: true } });
    assert.equal((receivedInputs! as { polluted?: boolean }).polluted, undefined);
  });

  it('fails clearly when a graph handler does not return a string output', async () => {
    const graphId = 'missing-output-handler' as GraphId;

    await assert.rejects(
      () =>
        createNode().process(
          {
            ['function-call' as PortId]: {
              type: 'object',
              value: { name: 'missingOutput', arguments: {}, id: 'call_missing' },
            },
          },
          createSubgraphContext([{ id: graphId, name: 'missingOutput' }], () => ({})),
        ),
      /must return a string Graph Output named "output"/,
    );
  });

  it('retains the containing-name auto-delegate fallback when no exact graph exists', async () => {
    const matchingGraphId = 'compatible-handler' as GraphId;
    let selectedGraphId: GraphId | undefined;

    await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: {}, id: 'call_1' },
        },
      },
      createSubgraphContext([{ id: matchingGraphId, name: 'legacy foo handler' }], (graphId) => {
        selectedGraphId = graphId;
        return {
          ['output' as PortId]: { type: 'string', value: 'fallback output' },
        };
      }),
    );

    assert.equal(selectedGraphId, matchingGraphId);
  });

  it('keeps runtime auto-delegate selection on graph metadata IDs rather than project map keys', async () => {
    const metadataGraphId = 'runtime-metadata-id' as GraphId;
    let selectedGraphId: GraphId | undefined;

    await createNode().process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: { name: 'foo', arguments: {}, id: 'call_1' },
        },
      },
      {
        project: {
          graphs: {
            ['serialized-map-key' as GraphId]: {
              metadata: { id: metadataGraphId, name: 'foo' },
              nodes: [],
              connections: [],
            },
          },
        },
        externalFunctions: {},
        signal: new AbortController().signal,
        contextValues: {},
        createSubProcessor: (graphId: GraphId) => ({
          processGraph: async () => {
            selectedGraphId = graphId;
            return { ['output' as PortId]: { type: 'string', value: 'ok' } };
          },
        }),
      } as unknown as InternalProcessContext,
    );

    assert.equal(selectedGraphId, metadataGraphId);
  });

  it('delegates the legacy Chat function-call output object', async () => {
    const node = createNode();
    const legacyChatOutputs: Outputs = {};
    let receivedArguments: Record<string, unknown> | undefined;

    applyStreamedFunctionCallOutputs(
      legacyChatOutputs,
      [
        [
          {
            type: 'function',
            id: 'call_1',
            name: 'foo',
            arguments: '{"value":123}',
            lastParsedArguments: { value: 123 },
          },
        ],
      ],
      false,
      false,
    );

    const result = await node.process(
      {
        ['function-call' as PortId]: legacyChatOutputs['function-call' as PortId]!,
      },
      createContext((argumentsValue) => {
        receivedArguments = argumentsValue;
        return 'ok';
      }),
    );

    assert.deepEqual(receivedArguments, { value: 123 });
    assert.equal(result.output?.value, 'ok');
  });

  it('unwraps a single legacy Chat parallel function-calls output item', async () => {
    const node = createNode();
    const legacyChatOutputs: Outputs = {};
    let receivedArguments: Record<string, unknown> | undefined;

    applyStreamedFunctionCallOutputs(
      legacyChatOutputs,
      [
        [
          {
            type: 'function',
            id: 'call_1',
            name: 'foo',
            arguments: '{"value":123}',
            lastParsedArguments: { value: 123 },
          },
        ],
      ],
      false,
      true,
    );

    const result = await node.process(
      {
        ['function-call' as PortId]: legacyChatOutputs['function-calls' as PortId]!,
      },
      createContext((argumentsValue) => {
        receivedArguments = argumentsValue;
        return 'ok';
      }),
    );

    assert.deepEqual(receivedArguments, { value: 123 });
    assert.equal(result.output?.value, 'ok');
  });

  it('unwraps a single function call from Chat v2 Function Calls output', async () => {
    const node = createNode();
    let receivedArguments: Record<string, unknown> | undefined;

    const result = await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object[]',
          value: [
            {
              name: 'foo',
              arguments: {},
              id: 'call_1',
            },
          ],
        },
      },
      createContext((argumentsValue) => {
        receivedArguments = argumentsValue;
        return 'ok';
      }),
    );

    assert.deepEqual(receivedArguments, {});
    assert.equal(result.output?.value, 'ok');
  });

  it('keeps the message output compatible with old object-based wiring', () => {
    const node = createNode();
    const outputs = node.getOutputDefinitions();
    const messageOutput = outputs.find((output) => output.id === 'message');
    const assistantMessageOutput = outputs.find((output) => output.id === 'assistant-message');

    assert.deepEqual(
      outputs.map((output) => output.id),
      ['tool-name', 'tool-arguments', 'assistant-message', 'output', 'execution-time', 'message'],
    );
    assert.deepEqual(
      outputs.find((output) => output.id === 'tool-name'),
      {
        id: 'tool-name',
        dataType: ['string', 'string[]'],
        title: 'Tool Name',
        description: 'The name of the tool selected by the LLM.',
      },
    );
    assert.deepEqual(
      outputs.find((output) => output.id === 'tool-arguments'),
      {
        id: 'tool-arguments',
        dataType: ['object', 'object[]'],
        title: 'Tool Arguments',
        description: 'The resolved arguments passed to the selected tool.',
      },
    );
    assert.deepEqual(messageOutput?.dataType, ['chat-message', 'chat-message[]', 'object', 'object[]']);
    assert.equal(messageOutput?.title, 'Tool Result Message');
    assert.deepEqual(assistantMessageOutput, {
      id: 'assistant-message',
      dataType: 'string',
      title: 'Message',
      description:
        'Nonblank text the assistant emitted alongside a connected tool-call round. This output fires before the tools are invoked.',
    });
    assert.deepEqual(
      outputs.find((output) => output.id === 'execution-time'),
      {
        id: 'execution-time',
        dataType: ['number', 'number[]'],
        title: 'Tool Execution Time (sec)',
        description: 'Seconds spent running the tool handler graph or external function.',
      },
    );
    assert.equal(
      node.getOutputDefinitions().some((output) => output.id === ('cost' as PortId)),
      false,
    );
  });

  it('surfaces a single already-delegated tool call record without running it again', async () => {
    const node = createNode();
    let externalCallCount = 0;

    const result = await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: delegatedToolCallRecord('foo', 'stored output'),
        },
      },
      createContext(() => {
        externalCallCount++;
        return 'rerun output';
      }),
    );

    assert.equal(externalCallCount, 0);
    assert.equal(result.output?.type, 'string');
    assert.equal(result.output?.value, 'stored output');
    assert.deepEqual(result['tool-name' as PortId], { type: 'string', value: 'foo' });
    assert.deepEqual(result['tool-arguments' as PortId], { type: 'object', value: {} });
    assert.deepEqual(result['execution-time' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(result.message?.value, delegatedToolCallRecord('foo', 'stored output').message);
    assert.equal(result['cost' as PortId], undefined);
  });

  it('surfaces multiple already-delegated tool call records as arrays without running them again', async () => {
    const node = createNode();
    let externalCallCount = 0;
    const fooRecord = delegatedToolCallRecord('foo', 'foo output', 'call_foo', 12.5);
    const barRecord = delegatedToolCallRecord('bar', 'bar output', 'call_bar', 34.5);
    fooRecord.arguments = { value: 'foo input' };
    barRecord.arguments = { value: 'bar input' };

    const result = await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object[]',
          value: [fooRecord, barRecord],
        },
      },
      createContext(() => {
        externalCallCount++;
        return 'rerun output';
      }),
    );

    assert.equal(externalCallCount, 0);
    assert.equal(result.output?.type, 'string[]');
    assert.deepEqual(result.output?.value, ['foo output', 'bar output']);
    assert.deepEqual(result['execution-time' as PortId], {
      type: 'number[]',
      value: [0.0125, 0.0345],
    });
    assert.deepEqual(result['tool-name' as PortId], {
      type: 'string[]',
      value: ['foo', 'bar'],
    });
    assert.deepEqual(result['tool-arguments' as PortId], {
      type: 'object[]',
      value: [fooRecord.arguments, barRecord.arguments],
    });
    assert.equal(result.message?.type, 'chat-message[]');
    assert.deepEqual(result.message?.value, [fooRecord.message, barRecord.message]);
  });

  it('parses JSON string arguments from legacy function call shapes', async () => {
    const node = createNode();
    let receivedArguments: Record<string, unknown> | undefined;

    await node.process(
      {
        ['function-call' as PortId]: {
          type: 'object',
          value: {
            name: 'foo',
            arguments: '{"value":123}',
            id: 'call_1',
          },
        },
      },
      createContext((argumentsValue) => {
        receivedArguments = argumentsValue;
        return 'ok';
      }),
    );

    assert.deepEqual(receivedArguments, { value: 123 });
  });

  it('fails clearly when multiple function calls are provided without splitting', async () => {
    const node = createNode();

    await assert.rejects(
      () =>
        node.process(
          {
            ['function-call' as PortId]: {
              type: 'object[]',
              value: [
                { name: 'foo', arguments: {}, id: 'call_1' },
                { name: 'bar', arguments: {}, id: 'call_2' },
              ],
            },
          },
          createContext(() => 'ok'),
        ),
      /expected a single tool call, but received 2/,
    );
  });
});
