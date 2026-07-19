import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DelegateFunctionCallNodeImpl,
  type DelegateFunctionCallNode,
  type GraphId,
  type InternalProcessContext,
  type Outputs,
  type PortId,
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

function delegatedToolCallRecord(name: string, output: string, id = `call_${name}`) {
  return {
    delegatedToolCall: true,
    name,
    arguments: {},
    id,
    output,
    message: {
      type: 'function',
      message: output,
      name: id,
      toolName: name,
    },
  };
}

describe('DelegateFunctionCallNodeImpl', () => {
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
    assert.equal(result.output?.value, 'ok');
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
    const messageOutput = node.getOutputDefinitions().find((output) => output.id === 'message');
    const assistantMessageOutput = node.getOutputDefinitions().find((output) => output.id === 'assistant-message');

    assert.deepEqual(messageOutput?.dataType, ['chat-message', 'chat-message[]', 'object', 'object[]']);
    assert.equal(messageOutput?.title, 'Tool Result Message');
    assert.deepEqual(assistantMessageOutput, {
      id: 'assistant-message',
      dataType: 'string',
      title: 'Message (fires before the tool call is invoked)',
      description:
        'Nonblank text the assistant emitted alongside a connected tool-call round. This output fires before the tools are invoked.',
    });
    assert.equal(node.getOutputDefinitions().some((output) => output.id === ('cost' as PortId)), false);
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
    assert.deepEqual(result.message?.value, delegatedToolCallRecord('foo', 'stored output').message);
    assert.equal(result['cost' as PortId], undefined);
  });

  it('surfaces multiple already-delegated tool call records as arrays without running them again', async () => {
    const node = createNode();
    let externalCallCount = 0;
    const fooRecord = delegatedToolCallRecord('foo', 'foo output', 'call_foo');
    const barRecord = delegatedToolCallRecord('bar', 'bar output', 'call_bar');

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
