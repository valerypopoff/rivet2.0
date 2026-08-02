import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DelegateFunctionCallNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  NodeImpl,
  NodeRegistration,
  RIVET_WEB_APP_STATUS_FUNCTION_NAME,
  delegateFunctionCallNode,
  graphOutputNode,
  nodeDefinition,
  raceInputsNode,
  startBackgroundBranchNode,
  subGraphNode,
  type ChartNode,
  type DelegatedToolCallRecord,
  type GraphId,
  type GraphProcessorScheduler,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type ProcessEvents,
  type ProcessId,
  type Project,
} from '../../src/index.js';
import type { StreamedFunctionCall } from '../../src/model/chat/streamChatResponse.js';
import { testProcessContext } from '../testUtils.js';

type FakeLLMRound = {
  assistantMessage: string;
  toolCalls: StreamedFunctionCall[];
};

type FakeLLMNode = ChartNode<
  'llmChatV2',
  {
    autoContinueToolCalls: true;
    rawCallsAfterContinuation?: StreamedFunctionCall[];
    replayedRecords?: DelegatedToolCallRecord[];
    rounds: FakeLLMRound[];
    useToolCalling: true;
  }
>;

type AssistantMessageProbeNode = ChartNode<'assistantMessageProbe', { scenario: string }>;
type IndependentValueNode = ChartNode<'independentValue', { scenario: string; value: string }>;
type CombinedFinalConsumerNode = ChartNode<'combinedFinalConsumer', { scenario: string }>;
type AssistantMessageTransformNode = ChartNode<'assistantMessageTransform', { scenario: string }>;
type ActiveOutputProbeNode = ChartNode<'activeOutputProbe', Record<string, never>>;
type NestedSubgraphProbeNode = ChartNode<'nestedSubgraphProbe', { graphId: GraphId; scenario: string }>;

type AssistantMessageProbeHandler = (
  message: string,
  context: InternalProcessContext,
  otherValue?: string,
) => void | Promise<void>;

class FakeLLMNodeImpl extends NodeImpl<FakeLLMNode> {
  static processCount = 0;
  static continuationRecords: DelegatedToolCallRecord[] = [];

  static create(): FakeLLMNode {
    return {
      id: 'fake-llm' as NodeId,
      type: 'llmChatV2',
      title: 'Fake LLM Chat',
      data: {
        autoContinueToolCalls: true,
        rounds: [],
        useToolCalling: true,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'feedback' as PortId,
        title: 'Feedback',
        dataType: 'string',
        required: false,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'function-calls' as PortId,
        title: 'Tool Calls',
        dataType: 'object[]',
      },
      {
        id: 'response' as PortId,
        title: 'Response',
        dataType: 'string',
      },
    ];
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    FakeLLMNodeImpl.processCount++;

    if (!context.toolCallContinuation) {
      throw new Error('Expected the connected Delegate Tool Call continuation runner.');
    }

    const records = [];
    for (const round of this.data.rounds) {
      const results = await context.toolCallContinuation.run(round.toolCalls, round.assistantMessage);
      FakeLLMNodeImpl.continuationRecords.push(...results.map((result) => result.record));
      records.push(...results.map((result) => result.record));
    }

    if (this.data.rawCallsAfterContinuation) {
      context.toolCallContinuation.release();
      return {
        ['function-calls' as PortId]: {
          type: 'object[]',
          value: this.data.rawCallsAfterContinuation.map((toolCall) => ({
            arguments: toolCall.lastParsedArguments ?? toolCall.arguments,
            id: toolCall.id,
            name: toolCall.name,
          })),
        },
        ['response' as PortId]: {
          type: 'string',
          value: 'response with unresolved calls',
        },
      };
    }

    if (this.data.replayedRecords) {
      return {
        ['function-calls' as PortId]: {
          type: 'object[]',
          value: this.data.replayedRecords,
        },
        ['response' as PortId]: {
          type: 'string',
          value: 'cached final response',
        },
      };
    }

    return {
      ['function-calls' as PortId]: {
        type: 'object[]',
        value: records,
      },
      ['response' as PortId]: {
        type: 'string',
        value: 'final response',
      },
    };
  }
}

class AssistantMessageProbeNodeImpl extends NodeImpl<AssistantMessageProbeNode> {
  static readonly handlers = new Map<string, AssistantMessageProbeHandler>();

  static create(): AssistantMessageProbeNode {
    return {
      id: 'assistant-message-probe' as NodeId,
      type: 'assistantMessageProbe',
      title: 'Assistant Message Probe',
      data: { scenario: 'default' },
      visualData: { x: 600, y: 0, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'message' as PortId,
        title: 'Message',
        dataType: 'string',
        required: true,
      },
      {
        id: 'other' as PortId,
        title: 'Other',
        dataType: 'string',
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [];
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const message = inputs['message' as PortId];
    assert.equal(message?.type, 'string');

    const handler = AssistantMessageProbeNodeImpl.handlers.get(this.data.scenario);
    if (!handler) {
      throw new Error(`No Assistant Message probe handler registered for ${this.data.scenario}.`);
    }

    const otherValue = inputs['other' as PortId];
    assert.ok(otherValue == null || otherValue.type === 'string');
    await handler(message.value, context, otherValue?.value);
    return {};
  }
}

class IndependentValueNodeImpl extends NodeImpl<IndependentValueNode> {
  static readonly handlers = new Map<string, (context: InternalProcessContext) => void | Promise<void>>();

  static create(): IndependentValueNode {
    return {
      id: 'independent-value' as NodeId,
      type: 'independentValue',
      title: 'Independent Value',
      data: { scenario: 'default', value: 'independent value' },
      visualData: { x: 0, y: 300, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'output' as PortId,
        title: 'Output',
        dataType: 'string',
      },
    ];
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const handler = IndependentValueNodeImpl.handlers.get(this.data.scenario);
    if (handler) {
      await handler(context);
    }

    return {
      ['output' as PortId]: {
        type: 'string',
        value: this.data.value,
      },
    };
  }
}

class CombinedFinalConsumerNodeImpl extends NodeImpl<CombinedFinalConsumerNode> {
  static readonly handlers = new Map<string, (llmValue: string, delegateValue: string) => void | Promise<void>>();

  static create(): CombinedFinalConsumerNode {
    return {
      id: 'combined-final-consumer' as NodeId,
      type: 'combinedFinalConsumer',
      title: 'Combined Final Consumer',
      data: { scenario: 'default' },
      visualData: { x: 800, y: 200, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'llm' as PortId,
        title: 'LLM',
        dataType: 'string',
        required: true,
      },
      {
        id: 'delegate' as PortId,
        title: 'Delegate',
        dataType: 'string',
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [];
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const llmValue = inputs['llm' as PortId];
    const delegateValue = inputs['delegate' as PortId];
    assert.equal(llmValue?.type, 'string');
    assert.equal(delegateValue?.type, 'string');

    const handler = CombinedFinalConsumerNodeImpl.handlers.get(this.data.scenario);
    if (!handler) {
      throw new Error(`No combined-final consumer handler registered for ${this.data.scenario}.`);
    }

    await handler(llmValue.value, delegateValue.value);
    return {};
  }
}

class AssistantMessageTransformNodeImpl extends NodeImpl<AssistantMessageTransformNode> {
  static readonly handlers = new Map<string, (message: string) => string | Promise<string>>();

  static create(): AssistantMessageTransformNode {
    return {
      id: 'assistant-message-transform' as NodeId,
      type: 'assistantMessageTransform',
      title: 'Assistant Message Transform',
      data: { scenario: 'default' },
      visualData: { x: 600, y: 300, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'message' as PortId,
        title: 'Message',
        dataType: 'string',
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'output' as PortId,
        title: 'Output',
        dataType: 'string',
      },
    ];
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const message = inputs['message' as PortId];
    assert.equal(message?.type, 'string');

    const handler = AssistantMessageTransformNodeImpl.handlers.get(this.data.scenario);
    if (!handler) {
      throw new Error(`No Assistant Message transform handler registered for ${this.data.scenario}.`);
    }

    return {
      ['output' as PortId]: {
        type: 'string',
        value: await handler(message.value),
      },
    };
  }
}

class ActiveOutputProbeNodeImpl extends NodeImpl<ActiveOutputProbeNode> {
  static create(): ActiveOutputProbeNode {
    return {
      id: 'active-output-probe' as NodeId,
      type: 'activeOutputProbe',
      title: 'Active Output Probe',
      data: {},
      visualData: { x: 600, y: 300, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ id: 'message' as PortId, title: 'Message', dataType: 'string', required: true }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'immediate' as PortId, title: 'Immediate', dataType: 'string' },
      { id: 'deferred' as PortId, title: 'Deferred', dataType: 'string' },
    ];
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const message = inputs['message' as PortId];
    assert.equal(message?.type, 'string');

    const outputs: Outputs = {};
    for (const outputId of ['immediate', 'deferred'] as const) {
      if (context.activeOutputPortIds.has(outputId as PortId)) {
        outputs[outputId as PortId] = { type: 'string', value: `${outputId}:${message.value}` };
      }
    }
    return outputs;
  }
}

class NestedSubgraphProbeNodeImpl extends NodeImpl<NestedSubgraphProbeNode> {
  static readonly handlers = new Map<string, () => void | Promise<void>>();

  static create(): NestedSubgraphProbeNode {
    return {
      id: 'nested-subgraph-probe' as NodeId,
      type: 'nestedSubgraphProbe',
      title: 'Nested Subgraph Probe',
      data: {
        graphId: 'nested-subgraph' as GraphId,
        scenario: 'default',
      },
      visualData: { x: 600, y: 300, width: 240 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'message' as PortId,
        title: 'Message',
        dataType: 'string',
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'output' as PortId,
        title: 'Output',
        dataType: 'string',
      },
    ];
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const message = inputs['message' as PortId];
    assert.equal(message?.type, 'string');

    const child = context.createSubProcessor(this.data.graphId, { signal: context.signal });
    await child.processGraph(context, {}, context.contextValues);
    await NestedSubgraphProbeNodeImpl.handlers.get(this.data.scenario)?.();

    return {
      ['output' as PortId]: message,
    };
  }
}

const fakeLLMNode = nodeDefinition(FakeLLMNodeImpl, 'Fake LLM Chat');
const assistantMessageProbeNode = nodeDefinition(AssistantMessageProbeNodeImpl, 'Assistant Message Probe');
const independentValueNode = nodeDefinition(IndependentValueNodeImpl, 'Independent Value');
const combinedFinalConsumerNode = nodeDefinition(CombinedFinalConsumerNodeImpl, 'Combined Final Consumer');
const assistantMessageTransformNode = nodeDefinition(AssistantMessageTransformNodeImpl, 'Assistant Message Transform');
const activeOutputProbeNode = nodeDefinition(ActiveOutputProbeNodeImpl, 'Active Output Probe');
const nestedSubgraphProbeNode = nodeDefinition(NestedSubgraphProbeNodeImpl, 'Nested Subgraph Probe');
const graphId = 'tool-continuation-integration' as GraphId;

function createRegistry() {
  return new NodeRegistration()
    .register(fakeLLMNode)
    .register(delegateFunctionCallNode)
    .register(assistantMessageProbeNode)
    .register(independentValueNode)
    .register(combinedFinalConsumerNode)
    .register(assistantMessageTransformNode)
    .register(activeOutputProbeNode)
    .register(nestedSubgraphProbeNode)
    .register(startBackgroundBranchNode)
    .register(subGraphNode)
    .register(raceInputsNode)
    .register(graphOutputNode);
}

function makeToolCall(id: string, name: string, argumentsValue: Record<string, unknown> = {}): StreamedFunctionCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(argumentsValue),
    lastParsedArguments: argumentsValue,
  };
}

function makeLLM(rounds: FakeLLMRound[]): FakeLLMNode {
  return {
    ...FakeLLMNodeImpl.create(),
    id: 'llm' as NodeId,
    data: {
      autoContinueToolCalls: true,
      rounds,
      useToolCalling: true,
    },
  };
}

function makeDelegate() {
  const created = DelegateFunctionCallNodeImpl.create();
  return {
    ...created,
    id: 'delegate' as NodeId,
    data: {
      ...created.data,
      passthroughErrors: false,
    },
  };
}

function makeStartAsync(id = 'async-trigger'): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title: 'Start Async Branch',
    type: 'startBackgroundBranch',
    visualData: { x: 500, y: 0, width: 200 },
  };
}

function makeSubgraph(id: string, childGraphId: GraphId): ChartNode {
  return {
    data: {
      graphId: childGraphId,
      useAsGraphPartialOutput: false,
      useErrorOutput: false,
    },
    id: id as NodeId,
    title: id,
    type: 'subGraph',
    visualData: { x: 0, y: 0, width: 220 },
  };
}

function makeRaceInputs(id: string): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title: 'Race Inputs',
    type: 'raceInputs',
    visualData: { x: 400, y: 0, width: 220 },
  };
}

function makeProbe(scenario: string): AssistantMessageProbeNode {
  return {
    ...AssistantMessageProbeNodeImpl.create(),
    id: 'probe' as NodeId,
    data: { scenario },
  };
}

function makeIndependentValue(scenario: string, value: string): IndependentValueNode {
  return {
    ...IndependentValueNodeImpl.create(),
    id: 'independent' as NodeId,
    data: { scenario, value },
  };
}

function makeCombinedFinalConsumer(scenario: string): CombinedFinalConsumerNode {
  return {
    ...CombinedFinalConsumerNodeImpl.create(),
    id: 'combined' as NodeId,
    data: { scenario },
  };
}

function makeAssistantMessageTransform(scenario: string): AssistantMessageTransformNode {
  return {
    ...AssistantMessageTransformNodeImpl.create(),
    id: 'transform' as NodeId,
    data: { scenario },
  };
}

function makeNestedSubgraphProbe(scenario: string, nestedGraphId: GraphId): NestedSubgraphProbeNode {
  return {
    ...NestedSubgraphProbeNodeImpl.create(),
    id: 'nested-probe' as NodeId,
    data: { graphId: nestedGraphId, scenario },
  };
}

function makeDelegatedRecord(
  id: string,
  name: string,
  output: string,
  argumentsValue: Record<string, unknown> = {},
): DelegatedToolCallRecord {
  return {
    delegatedToolCall: true,
    name,
    arguments: argumentsValue,
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

function makeGraphOutput(id: string) {
  const created = GraphOutputNodeImpl.create();
  return {
    ...created,
    id: `${id}-graph-output` as NodeId,
    data: {
      id,
      dataType: 'string' as const,
    },
  };
}

function connect(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

function makeProject(nodes: ChartNode[], connections: NodeConnection[]): Project {
  const graph = {
    metadata: {
      id: graphId,
      name: 'Tool continuation integration',
      description: '',
    },
    nodes,
    connections,
  };

  return {
    metadata: {
      id: 'tool-continuation-project' as Project['metadata']['id'],
      title: 'Tool continuation project',
      description: '',
      mainGraphId: graphId,
    },
    graphs: { [graphId]: graph },
    plugins: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  FakeLLMNodeImpl.processCount = 0;
  FakeLLMNodeImpl.continuationRecords = [];
  AssistantMessageProbeNodeImpl.handlers.clear();
  IndependentValueNodeImpl.handlers.clear();
  CombinedFinalConsumerNodeImpl.handlers.clear();
  AssistantMessageTransformNodeImpl.handlers.clear();
  NestedSubgraphProbeNodeImpl.handlers.clear();
});

describe('GraphProcessor connected tool continuation', () => {
  it('runs the connected Delegate once per tool round with distinct process IDs and no final extra run', async () => {
    const llm = makeLLM([
      { assistantMessage: 'First round', toolCalls: [makeToolCall('call-1', 'lookup')] },
      { assistantMessage: 'Second round', toolCalls: [makeToolCall('call-2', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const processor = new GraphProcessor(
      makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
      graphId,
      createRegistry(),
    );
    const starts: ProcessId[] = [];
    const finishes: ProcessId[] = [];
    const llmStarts: ProcessId[] = [];
    const llmFinishes: ProcessId[] = [];
    const lifecycleOrder: string[] = [];
    let toolRunCount = 0;

    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: `result-${toolRunCount}` };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === llm.id) {
        llmStarts.push(event.processId);
        lifecycleOrder.push(`llm:start:${event.processId}`);
      }
      if (event.node.id === delegate.id) {
        starts.push(event.processId);
        lifecycleOrder.push(`delegate:start:${event.processId}`);
      }
    });
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === llm.id) {
        llmFinishes.push(event.processId);
        lifecycleOrder.push(`llm:finish:${event.processId}`);
      }
      if (event.node.id === delegate.id) {
        finishes.push(event.processId);
        lifecycleOrder.push(`delegate:finish:${event.processId}`);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'two continuation rounds');

    assert.equal(toolRunCount, 2);
    assert.equal(starts.length, 2);
    assert.equal(finishes.length, 2);
    assert.notEqual(starts[0], starts[1]);
    assert.deepEqual(finishes, starts);
    assert.equal(llmStarts.length, 1);
    assert.deepEqual(llmFinishes, llmStarts);
    assert.equal(lifecycleOrder[0], `llm:start:${llmStarts[0]}`);
    assert.equal(lifecycleOrder.at(-1), `llm:finish:${llmStarts[0]}`);
    for (const delegateProcessId of starts) {
      assert.ok(
        lifecycleOrder.indexOf(`delegate:start:${delegateProcessId}`) > 0,
        'Every Delegate round must start after the owning LLM.',
      );
      assert.ok(
        lifecycleOrder.indexOf(`delegate:finish:${delegateProcessId}`) < lifecycleOrder.length - 1,
        'Every Delegate round must finish before the owning LLM.',
      );
    }
  });

  it('records a distinct Message-branch consumer run for every tool call in a nonblank round', async () => {
    const llm = makeLLM([
      {
        assistantMessage: 'I am checking both items now.',
        toolCalls: [makeToolCall('call-1', 'lookup'), makeToolCall('call-2', 'lookup')],
      },
    ]);
    const delegate = makeDelegate();
    const probe = makeProbe('message-history');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const probeStarts: ProcessId[] = [];
    const probeFinishes: ProcessId[] = [];
    const receivedMessages: string[] = [];

    AssistantMessageProbeNodeImpl.handlers.set('message-history', async (message) => {
      receivedMessages.push(message);
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === probe.id) {
        probeStarts.push(event.processId);
      }
    });
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === probe.id) {
        probeFinishes.push(event.processId);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'Message-branch history across a tool batch');

    assert.deepEqual(receivedMessages, ['I am checking both items now.', 'I am checking both items now.']);
    assert.equal(probeStarts.length, 2);
    assert.equal(probeFinishes.length, 2);
    assert.notEqual(probeStarts[0], probeStarts[1]);
    assert.deepEqual(probeFinishes, probeStarts);
  });

  it('records distinct async Message descendants for every tool call in a nonblank round', async () => {
    const llm = makeLLM([
      {
        assistantMessage: 'I am checking both items now.',
        toolCalls: [makeToolCall('call-1', 'lookup'), makeToolCall('call-2', 'lookup')],
      },
    ]);
    const delegate = makeDelegate();
    const asyncTrigger = makeStartAsync();
    const probe = makeProbe('async-message-history');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, asyncTrigger, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', asyncTrigger.id, 'input1'),
          connect(asyncTrigger.id, 'output1', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const probeStarts: ProcessId[] = [];
    const receivedMessages: string[] = [];

    AssistantMessageProbeNodeImpl.handlers.set('async-message-history', async (message) => {
      receivedMessages.push(message);
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === probe.id) {
        probeStarts.push(event.processId);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'async Message-branch history across a tool batch');

    assert.deepEqual(receivedMessages, ['I am checking both items now.', 'I am checking both items now.']);
    assert.equal(probeStarts.length, 2);
    assert.notEqual(probeStarts[0], probeStarts[1]);
  });

  it('fails before running the LLM or either Delegate when continuation wiring is ambiguous', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const firstDelegate = { ...makeDelegate(), id: 'delegate-a' as NodeId };
    const secondDelegate = { ...makeDelegate(), id: 'delegate-b' as NodeId };
    const processor = new GraphProcessor(
      makeProject(
        [llm, firstDelegate, secondDelegate],
        [
          connect('llm', 'function-calls', firstDelegate.id, 'function-call'),
          connect('llm', 'function-calls', secondDelegate.id, 'function-call'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const delegateStarts: ProcessId[] = [];
    const llmErrors: ProcessEvents['nodeError'][] = [];
    let toolRunCount = 0;

    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.type === 'delegateFunctionCall') {
        delegateStarts.push(event.processId);
      }
    });
    processor.on('nodeError', (event: ProcessEvents['nodeError']) => {
      if (event.node.id === llm.id) {
        llmErrors.push(event);
      }
    });

    await assert.rejects(withTimeout(processor.processGraph(testProcessContext()), 'ambiguous continuation rejection'));

    assert.equal(FakeLLMNodeImpl.processCount, 0);
    assert.equal(toolRunCount, 0);
    assert.deepEqual(delegateStarts, []);
    assert.equal(llmErrors.length, 1);
    assert.match(String(llmErrors[0]!.error), /has 2 connected Delegate Tool Call nodes/);
  });

  it('releases unresolved raw calls to the ordinary downstream Delegate exactly once', async () => {
    const llm = makeLLM([]);
    llm.data.rawCallsAfterContinuation = [makeToolCall('call-raw', 'lookup', { query: 'raw' })];
    const delegate = makeDelegate();
    const processor = new GraphProcessor(
      makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
      graphId,
      createRegistry(),
    );
    const delegateStarts: ProcessId[] = [];
    let toolRunCount = 0;

    processor.setExternalFunction('lookup', async (_context, args) => {
      toolRunCount++;
      assert.deepEqual(args, { query: 'raw' });
      return { type: 'string', value: 'raw lookup result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === delegate.id) {
        delegateStarts.push(event.processId);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'ordinary unresolved-call handoff');

    assert.equal(toolRunCount, 1);
    assert.equal(delegateStarts.length, 1);
  });

  it('seeds replayed delegated records without a phantom Delegate run and still propagates downstream', async () => {
    const cachedOutput = 'cached lookup result';
    const llm = makeLLM([]);
    llm.data.replayedRecords = [makeDelegatedRecord('call-cached', 'lookup', cachedOutput, { query: 'cached' })];
    const delegate = makeDelegate();
    const probe = makeProbe('cached-delegate-output');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const delegateStarts: ProcessId[] = [];
    const probeValues: string[] = [];
    let toolRunCount = 0;

    AssistantMessageProbeNodeImpl.handlers.set('cached-delegate-output', async (message) => {
      probeValues.push(message);
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'unexpected live result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === delegate.id) {
        delegateStarts.push(event.processId);
      }
    });

    const outputs = await withTimeout(
      processor.processGraph(testProcessContext()),
      'replayed Delegate output propagation',
    );

    assert.equal(toolRunCount, 0);
    assert.deepEqual(delegateStarts, []);
    assert.deepEqual(probeValues, [cachedOutput]);
    assert.deepEqual(outputs['cost' as PortId], { type: 'number', value: 0 });
  });

  for (const replayMode of ['preloaded', 'frozen'] as const) {
    it(`rejects ${replayMode} active Delegate outputs before running tool side effects`, async () => {
      const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
      const delegate = makeDelegate();
      const processor = new GraphProcessor(
        makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
        graphId,
        createRegistry(),
      );
      const replayedOutputs: Outputs = {
        ['output' as PortId]: { type: 'string', value: 'stale tool output' },
        ['message' as PortId]: {
          type: 'chat-message',
          value: makeDelegatedRecord('stale-call', 'lookup', 'stale tool output').message,
        },
        ['assistant-message' as PortId]: { type: 'control-flow-excluded', value: undefined },
      };
      const delegateErrors: ProcessEvents['nodeError'][] = [];
      let toolRunCount = 0;

      if (replayMode === 'preloaded') {
        processor.preloadNodeData(delegate.id, replayedOutputs);
        processor.runToNodeIds = [llm.id];
      } else {
        processor.setFrozenNodeOutputResolver(({ node }) => (node.id === delegate.id ? replayedOutputs : undefined));
      }
      processor.setExternalFunction('lookup', async () => {
        toolRunCount++;
        return { type: 'string', value: 'unexpected live result' };
      });
      processor.on('nodeError', (event: ProcessEvents['nodeError']) => {
        if (event.node.id === delegate.id) {
          delegateErrors.push(event);
        }
      });

      await assert.rejects(
        withTimeout(processor.processGraph(testProcessContext()), `${replayMode} Delegate rejection`),
      );

      assert.equal(toolRunCount, 0);
      assert.equal(delegateErrors.length, 1);
      assert.match(String(delegateErrors[0]!.error), /cannot use preloaded or frozen outputs/);
    });
  }

  it('starts an async Message branch and tool work in parallel even with node concurrency one', async () => {
    const events: string[] = [];
    const toolStarted = deferred();
    const probeStarted = deferred();
    const progressObserved = deferred();
    const progressEvents: ProcessEvents['progress'][] = [];
    let llmExecution: ProcessEvents['nodeStart']['execution'] | undefined;
    let probeRunCount = 0;
    const llm = makeLLM([
      { assistantMessage: 'I am checking that now.', toolCalls: [makeToolCall('call-1', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const asyncTrigger = makeStartAsync();
    const probe = makeProbe('parallel');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, asyncTrigger, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', asyncTrigger.id, 'input1'),
          connect(asyncTrigger.id, 'output1', 'probe', 'message'),
        ],
      ),
      graphId,
      createRegistry(),
      false,
      { concurrency: { nodeConcurrency: 1 } },
    );

    AssistantMessageProbeNodeImpl.handlers.set('parallel', async (message, context) => {
      probeRunCount++;
      events.push(`probe:start:${probeRunCount}`);
      assert.equal(message, 'I am checking that now.');

      if (probeRunCount === 1) {
        probeStarted.resolve();
        await withTimeout(toolStarted.promise, 'tool work to start alongside the Assistant Message branch');
        const setWebAppStatus = context.externalFunctions[RIVET_WEB_APP_STATUS_FUNCTION_NAME];
        assert.ok(setWebAppStatus, 'The continuation branch must inherit the built-in web-app status function.');
        await setWebAppStatus(context, message);
        await withTimeout(progressObserved.promise, 'Assistant Message progress event');
      }

      events.push(`probe:finish:${probeRunCount}`);
    });
    processor.setExternalFunction('lookup', async () => {
      events.push('tool:start');
      toolStarted.resolve();
      await withTimeout(probeStarted.promise, 'Assistant Message branch to start alongside tool work');
      await withTimeout(progressObserved.promise, 'Assistant Message progress while tool work is pending');
      events.push('tool:finish');
      return { type: 'string', value: 'lookup result' };
    });
    processor.on('progress', (event: ProcessEvents['progress']) => {
      progressEvents.push(event);
      events.push('progress');
      progressObserved.resolve();
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === llm.id) {
        llmExecution = event.execution;
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'parallel continuation work');

    const firstProbeStart = events.indexOf('probe:start:1');
    const firstProbeFinish = events.indexOf('probe:finish:1');
    const toolStart = events.indexOf('tool:start');
    const toolFinish = events.indexOf('tool:finish');
    assert.ok(firstProbeStart >= 0);
    assert.ok(toolStart >= 0);
    assert.ok(firstProbeStart < toolFinish, events.join(', '));
    assert.ok(toolStart < firstProbeFinish, events.join(', '));
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0]!.node.id, probe.id);
    assert.equal(progressEvents[0]!.progress.message, 'I am checking that now.');
    assert.deepEqual(progressEvents[0]!.execution, llmExecution);
    assert.ok(events.indexOf('progress') < toolFinish, events.join(', '));
  });

  it('uses only effective input connections when activating and planning the immediate branch', async () => {
    const independentStarted = deferred();
    const releaseIndependent = deferred();
    const toolStarted = deferred();
    const releaseTool = deferred();
    const activeProbeStarted = deferred();
    const activeProbeValues: string[] = [];
    const secondaryProbeValues: string[] = [];
    const llm = makeLLM([
      { assistantMessage: 'Effective continuation status', toolCalls: [makeToolCall('call-1', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const independent = makeIndependentValue('effective-connection-boundary', 'independent primary value');
    const activeProbe = { ...makeProbe('effective-primary'), id: 'active-probe' as NodeId };
    const secondaryProbe = { ...makeProbe('ignored-secondary'), id: 'secondary-probe' as NodeId };
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, independent, activeProbe, secondaryProbe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', activeProbe.id, 'message'),
          connect(independent.id, 'output', activeProbe.id, 'message'),
          connect(independent.id, 'output', secondaryProbe.id, 'message'),
          connect('delegate', 'assistant-message', secondaryProbe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    IndependentValueNodeImpl.handlers.set('effective-connection-boundary', async () => {
      independentStarted.resolve();
      await releaseIndependent.promise;
    });
    AssistantMessageProbeNodeImpl.handlers.set('effective-primary', async (message) => {
      activeProbeValues.push(message);
      activeProbeStarted.resolve();
    });
    AssistantMessageProbeNodeImpl.handlers.set('ignored-secondary', async (message) => {
      secondaryProbeValues.push(message);
    });
    processor.setExternalFunction('lookup', async () => {
      toolStarted.resolve();
      await releaseTool.promise;
      return { type: 'string', value: 'lookup result' };
    });

    const runPromise = withTimeout(processor.processGraph(testProcessContext()), 'effective connection continuation');
    await withTimeout(
      Promise.all([independentStarted.promise, toolStarted.promise, activeProbeStarted.promise]),
      'effective continuation branch to start without secondary dependencies',
    );

    assert.deepEqual(activeProbeValues, ['Effective continuation status']);
    assert.deepEqual(secondaryProbeValues, []);

    releaseIndependent.resolve();
    releaseTool.resolve();
    await runPromise;

    assert.deepEqual(secondaryProbeValues, ['independent primary value']);
  });

  it('ignores a stale invalid-port blocker before the valid continuation connection', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const staleSource = {
      ...makeIndependentValue('stale-continuation-source', 'unused'),
      id: 'stale-source' as NodeId,
    };
    const processor = new GraphProcessor(
      makeProject(
        [staleSource, llm, delegate],
        [
          connect(staleSource.id, 'function-calls', delegate.id, 'function-call'),
          connect(llm.id, 'function-calls', delegate.id, 'function-call'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    let toolRuns = 0;
    processor.setExternalFunction('lookup', async () => {
      toolRuns++;
      return { type: 'string', value: 'lookup result' };
    });

    await processor.processGraph(testProcessContext());

    assert.equal(toolRuns, 1);
    assert.equal(FakeLLMNodeImpl.processCount, 1);
  });

  it('starts an ordinary Message branch and tool work without serializing them', async () => {
    const events: string[] = [];
    const probeStarted = deferred();
    const toolStarted = deferred();
    const llm = makeLLM([{ assistantMessage: 'I will check.', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const probe = makeProbe('deferred');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', 'probe', 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('deferred', async () => {
      events.push('probe:start');
      probeStarted.resolve();
      await withTimeout(toolStarted.promise, 'tool to start alongside ordinary Message branch');
      events.push('probe:finish');
    });
    processor.setExternalFunction('lookup', async () => {
      events.push('tool:start');
      toolStarted.resolve();
      await withTimeout(probeStarted.promise, 'ordinary Message branch to start alongside tool');
      events.push('tool:finish');
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'deferred Assistant Message branch');

    assert.ok(events.indexOf('probe:start') < events.indexOf('tool:finish'), events.join(', '));
    assert.ok(events.indexOf('tool:start') < events.indexOf('probe:finish'), events.join(', '));
  });

  it('does not activate the Assistant Message branch for empty or whitespace-only round text', async () => {
    let probeRunCount = 0;
    let toolRunCount = 0;
    const llm = makeLLM([
      { assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] },
      { assistantMessage: ' \t\n ', toolCalls: [makeToolCall('call-2', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const probe = makeProbe('empty');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', 'probe', 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('empty', async () => {
      probeRunCount++;
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'empty-message continuation rounds');

    assert.equal(toolRunCount, 2);
    assert.equal(probeRunCount, 0);
  });

  it('does not emit a Delegate error when a normal tool-result consumer fails after Delegate finish', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const probe = makeProbe('failing-tool-result-consumer');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', 'probe', 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const delegateFinishes: ProcessId[] = [];
    const delegateErrors: ProcessId[] = [];
    const probeErrors: ProcessId[] = [];
    const terminalOrder: string[] = [];

    AssistantMessageProbeNodeImpl.handlers.set('failing-tool-result-consumer', async () => {
      throw new Error('tool-result consumer failed');
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === delegate.id) {
        delegateFinishes.push(event.processId);
        terminalOrder.push(`delegate-finish:${event.processId}`);
      }
    });
    processor.on('nodeError', (event: ProcessEvents['nodeError']) => {
      if (event.node.id === delegate.id) {
        delegateErrors.push(event.processId);
        terminalOrder.push(`delegate-error:${event.processId}`);
      }
      if (event.node.id === probe.id) {
        probeErrors.push(event.processId);
        terminalOrder.push(`probe-error:${event.processId}`);
      }
    });

    await assert.rejects(withTimeout(processor.processGraph(testProcessContext()), 'failing tool-result consumer'));

    assert.equal(delegateFinishes.length, 1);
    assert.deepEqual(delegateErrors, []);
    assert.equal(probeErrors.length, 1);
    assert.equal(terminalOrder[0], `delegate-finish:${delegateFinishes[0]}`);
    assert.equal(terminalOrder[1], `probe-error:${probeErrors[0]}`);
  });

  it('propagates a continuation-branch Graph Output value into the parent graph result', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const graphOutput = makeGraphOutput('delegatedResult');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, graphOutput],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', graphOutput.id, 'value'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));

    const outputs = await withTimeout(
      processor.processGraph(testProcessContext()),
      'continuation Graph Output propagation',
    );

    const delegatedResult = outputs['delegatedResult'];
    assert.ok(delegatedResult && delegatedResult.type === 'string');
    assert.deepEqual(JSON.parse(delegatedResult.value), {
      type: 'string',
      value: 'lookup result',
    });
  });

  it('preserves an explicit cost Graph Output produced by a continuation branch', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const graphOutput = makeGraphOutput('cost');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, graphOutput],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', graphOutput.id, 'value'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'explicit cost output' }));

    const outputs = await withTimeout(
      processor.processGraph(testProcessContext()),
      'continuation cost Graph Output propagation',
    );

    const explicitCost = outputs.cost;
    assert.ok(explicitCost && explicitCost.type === 'string');
    assert.deepEqual(JSON.parse(explicitCost.value), {
      type: 'string',
      value: 'explicit cost output',
    });
  });

  it('attributes external-tool partial outputs to the live connected Delegate run', async () => {
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const processor = new GraphProcessor(
      makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
      graphId,
      createRegistry(),
    );
    const delegateProcessIds: ProcessId[] = [];
    const delegatePartials: ProcessEvents['partialOutput'][] = [];

    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === delegate.id) {
        delegateProcessIds.push(event.processId);
      }
    });
    processor.on('partialOutput', (event: ProcessEvents['partialOutput']) => {
      if (event.node.id === delegate.id) {
        delegatePartials.push(event);
      }
    });
    processor.setExternalFunction('lookup', async (context) => {
      context.onPartialOutputs?.({
        ['stream' as PortId]: { type: 'string', value: 'partial tool output' },
      });
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'connected Delegate partial output');

    assert.equal(delegateProcessIds.length, 1);
    assert.equal(delegatePartials.length, 1);
    assert.equal(delegatePartials[0]!.processId, delegateProcessIds[0]);
    assert.equal(delegatePartials[0]!.index, 0);
    assert.deepEqual(delegatePartials[0]!.outputs, {
      ['stream' as PortId]: { type: 'string', value: 'partial tool output' },
    });
  });

  it('defers an Assistant Message consumer until its unfinished independent input is available, then runs it once', async () => {
    const slowStarted = deferred();
    const releaseSlow = deferred();
    const delegateFinished = deferred();
    const events: string[] = [];
    const probeRuns: Array<{ message: string; otherValue: string | undefined }> = [];
    const llm = makeLLM([
      { assistantMessage: 'I am checking that now.', toolCalls: [makeToolCall('call-1', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const independent = makeIndependentValue('slow-independent', 'independent result');
    const probe = makeProbe('mixed-inputs');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, independent, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', 'probe', 'message'),
          connect('independent', 'output', 'probe', 'other'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    IndependentValueNodeImpl.handlers.set('slow-independent', async () => {
      events.push('independent:start');
      slowStarted.resolve();
      await releaseSlow.promise;
      events.push('independent:finish');
    });
    AssistantMessageProbeNodeImpl.handlers.set('mixed-inputs', async (message, _context, otherValue) => {
      events.push('probe:run');
      probeRuns.push({ message, otherValue });
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === delegate.id) {
        delegateFinished.resolve();
      }
    });

    const runPromise = withTimeout(
      processor.processGraph(testProcessContext()),
      'mixed-input Assistant Message consumer',
    );
    await withTimeout(
      Promise.all([slowStarted.promise, delegateFinished.promise]),
      'independent input and Delegate to overlap',
    );
    await delay(10);

    assert.equal(probeRuns.length, 0, 'The consumer must not run early without its connected optional input.');
    releaseSlow.resolve();
    await runPromise;

    assert.deepEqual(probeRuns, [
      {
        message: 'I am checking that now.',
        otherValue: 'independent result',
      },
    ]);
    assert.deepEqual(events, ['independent:start', 'independent:finish', 'probe:run']);
  });

  for (const scheduler of ['compatible', 'fast-acyclic'] satisfies GraphProcessorScheduler[]) {
    it(`propagates completed continuation nodes exactly once with the ${scheduler} scheduler`, async () => {
      let combinedRunCount = 0;
      let branchSideEffectCount = 0;
      const scenario = `completion-${scheduler}`;
      const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
      const delegate = makeDelegate();
      const branchSideEffect = makeProbe(scenario);
      const combined = makeCombinedFinalConsumer(scenario);
      const processor = new GraphProcessor(
        makeProject(
          [llm, delegate, branchSideEffect, combined],
          [
            connect('llm', 'function-calls', 'delegate', 'function-call'),
            connect('delegate', 'output', branchSideEffect.id, 'message'),
            connect('llm', 'response', combined.id, 'llm'),
            connect('delegate', 'output', combined.id, 'delegate'),
          ],
        ),
        graphId,
        createRegistry(),
        false,
        { scheduler },
      );

      AssistantMessageProbeNodeImpl.handlers.set(scenario, async () => {
        branchSideEffectCount++;
      });
      CombinedFinalConsumerNodeImpl.handlers.set(scenario, async (llmValue, delegateValue) => {
        combinedRunCount++;
        assert.equal(llmValue, 'final response');
        assert.deepEqual(JSON.parse(delegateValue), {
          type: 'string',
          value: 'lookup result',
        });
      });
      processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));

      await withTimeout(processor.processGraph(testProcessContext()), `${scheduler} completion propagation`);

      assert.equal(combinedRunCount, 1, 'The consumer requiring final LLM and Delegate outputs must run once.');
      assert.equal(branchSideEffectCount, 1, 'A side effect already run in the continuation branch must not be rerun.');
    });
  }

  it('waits for every tool in a failed batch to settle and does not leak synthetic branch graph-abort events', async () => {
    const branchStarted = deferred();
    const fastRejected = deferred();
    const slowStarted = deferred();
    const releaseSlow = deferred();
    const events: string[] = [];
    const graphAborts: ProcessEvents['graphAbort'][] = [];
    let runSettled = false;
    const llm = makeLLM([
      {
        assistantMessage: 'I am running both tools.',
        toolCalls: [makeToolCall('call-fail', 'fail-fast'), makeToolCall('call-slow', 'slow-sibling')],
      },
    ]);
    const delegate = makeDelegate();
    const asyncTrigger = makeStartAsync();
    const probe = makeProbe('failed-batch-branch');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, asyncTrigger, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', asyncTrigger.id, 'input1'),
          connect(asyncTrigger.id, 'output1', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('failed-batch-branch', async () => {
      events.push('branch:start');
      branchStarted.resolve();
      events.push('branch:finish');
    });
    processor.setExternalFunction('fail-fast', async () => {
      await branchStarted.promise;
      events.push('fast:reject');
      fastRejected.resolve();
      throw new Error('fast tool failed');
    });
    processor.setExternalFunction('slow-sibling', async () => {
      events.push('slow:start');
      slowStarted.resolve();
      await releaseSlow.promise;
      events.push('slow:settled');
      return { type: 'string', value: 'late result' };
    });
    processor.on('graphAbort', (event: ProcessEvents['graphAbort']) => {
      graphAborts.push(event);
      events.push('graph:abort');
    });
    processor.on('graphError', () => {
      events.push('graph:error');
    });
    processor.on('finish', () => {
      events.push('graph:finish');
    });

    const runPromise = processor.processGraph(testProcessContext()).finally(() => {
      runSettled = true;
    });
    await withTimeout(
      Promise.all([branchStarted.promise, fastRejected.promise, slowStarted.promise]),
      'failed batch work to overlap',
    );
    await delay(10);

    assert.equal(runSettled, false, 'The graph must remain active until the later sibling settles.');
    assert.equal(events.includes('graph:error'), false);
    assert.equal(events.includes('graph:finish'), false);
    releaseSlow.resolve();
    await assert.rejects(withTimeout(runPromise, 'failed tool batch completion'));

    assert.deepEqual(graphAborts, []);
    assert.ok(events.indexOf('slow:settled') < events.indexOf('graph:error'), events.join(', '));
    assert.ok(events.indexOf('slow:settled') < events.indexOf('graph:finish'), events.join(', '));
  });

  it('fails the Delegate after concurrently started tool work when an ordinary Message branch fails', async () => {
    const delegateStarts: ProcessId[] = [];
    const delegateFinishes: ProcessId[] = [];
    const delegateErrors: ProcessId[] = [];
    const graphErrors: ProcessEvents['graphError'][] = [];
    let rootFinishCount = 0;
    let toolRunCount = 0;
    const llm = makeLLM([
      { assistantMessage: 'I am checking that now.', toolCalls: [makeToolCall('call-1', 'slow-tool')] },
    ]);
    const delegate = makeDelegate();
    const probe = makeProbe('failing-immediate-branch');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('failing-immediate-branch', async () => {
      throw new Error('Assistant Message branch failed');
    });
    processor.setExternalFunction('slow-tool', async () => {
      toolRunCount++;
      return { type: 'string', value: 'unexpected result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === delegate.id) {
        delegateStarts.push(event.processId);
      }
    });
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === delegate.id) {
        delegateFinishes.push(event.processId);
      }
    });
    processor.on('nodeError', (event: ProcessEvents['nodeError']) => {
      if (event.node.id === delegate.id) {
        delegateErrors.push(event.processId);
      }
    });
    processor.on('graphError', (event: ProcessEvents['graphError']) => {
      graphErrors.push(event);
    });
    processor.on('finish', () => {
      rootFinishCount++;
    });

    await assert.rejects(withTimeout(processor.processGraph(testProcessContext()), 'failing pre-tool Message branch'));

    assert.equal(toolRunCount, 1);
    assert.equal(delegateStarts.length, 1);
    assert.deepEqual(delegateErrors, delegateStarts);
    assert.deepEqual(delegateFinishes, []);
    assert.equal(graphErrors.length, 1);
    assert.equal(graphErrors[0]!.graph.metadata?.id, graphId);
    assert.equal(rootFinishCount, 1);
  });

  it('keeps root cancellation wired after a nested early-branch subgraph has already finished', async () => {
    const nestedGraphId = 'nested-continuation-child' as GraphId;
    const nestedFinished = deferred();
    const blockedStarted = deferred();
    const toolStarted = deferred();
    let blockedObservedAbort = false;
    let toolObservedAbort = false;
    const llm = makeLLM([
      { assistantMessage: 'Starting nested status work', toolCalls: [makeToolCall('call-1', 'slow-tool')] },
    ]);
    const delegate = makeDelegate();
    const asyncTrigger = makeStartAsync();
    const nestedProbe = makeNestedSubgraphProbe('nested-child-finished', nestedGraphId);
    const blockedProbe = { ...makeProbe('blocked-after-nested-child'), id: 'blocked-probe' as NodeId };
    const nestedChild = {
      ...makeIndependentValue('nested-child-value', 'nested child complete'),
      id: 'nested-child-node' as NodeId,
    };
    const project = makeProject(
      [llm, delegate, asyncTrigger, nestedProbe, blockedProbe],
      [
        connect('llm', 'function-calls', 'delegate', 'function-call'),
        connect('delegate', 'assistant-message', asyncTrigger.id, 'input1'),
        connect(asyncTrigger.id, 'output1', nestedProbe.id, 'message'),
        connect(nestedProbe.id, 'output', blockedProbe.id, 'message'),
      ],
    );
    project.graphs[nestedGraphId] = {
      metadata: {
        id: nestedGraphId,
        name: 'Nested continuation child',
        description: '',
      },
      nodes: [nestedChild],
      connections: [],
    };
    const processor = new GraphProcessor(project, graphId, createRegistry());

    NestedSubgraphProbeNodeImpl.handlers.set('nested-child-finished', async () => {
      nestedFinished.resolve();
    });
    AssistantMessageProbeNodeImpl.handlers.set('blocked-after-nested-child', async (_message, context) => {
      blockedStarted.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      blockedObservedAbort = context.signal.aborted;
    });
    processor.setExternalFunction('slow-tool', async (context) => {
      toolStarted.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      toolObservedAbort = context.signal.aborted;
      return { type: 'string', value: 'cancelled tool result' };
    });

    const runPromise = processor.processGraph(testProcessContext());
    await withTimeout(
      Promise.all([nestedFinished.promise, blockedStarted.promise, toolStarted.promise]),
      'nested child completion and later blocked continuation work',
    );

    await processor.abort(false, new Error('root cancellation after nested child completion'));
    await assert.rejects(withTimeout(runPromise, 'root cancellation after nested continuation child'));

    assert.equal(blockedObservedAbort, true);
    assert.equal(toolObservedAbort, true);
  });

  it('cancels async work launched by a nested continuation when its source subgraph loses a parent race', async () => {
    const childGraphId = 'nested-continuation-race-child' as GraphId;
    const asyncStarted = deferred();
    const asyncSettled = deferred();
    let asyncObservedAbort = false;
    const llm = makeLLM([
      { assistantMessage: 'Starting nested race status work', toolCalls: [makeToolCall('call-1', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const asyncTrigger = makeStartAsync('nested-race-async-trigger');
    const asyncProbe = { ...makeProbe('nested-race-async-probe'), id: 'nested-race-async-probe' as NodeId };
    const childForeground = {
      ...makeIndependentValue('nested-race-child-foreground', 'child result'),
      id: 'nested-race-child-foreground' as NodeId,
    };
    const childOutput = makeGraphOutput('child-result');
    const childGraph = {
      metadata: {
        id: childGraphId,
        name: 'Nested continuation race child',
        description: '',
      },
      nodes: [llm, delegate, asyncTrigger, asyncProbe, childForeground, childOutput],
      connections: [
        connect(llm.id, 'function-calls', delegate.id, 'function-call'),
        connect(delegate.id, 'assistant-message', asyncTrigger.id, 'input1'),
        connect(asyncTrigger.id, 'output1', asyncProbe.id, 'message'),
        connect(childForeground.id, 'output', childOutput.id, 'value'),
      ],
    };
    const subgraph = makeSubgraph('nested-race-subgraph', childGraphId);
    const competitor = {
      ...makeIndependentValue('nested-race-competitor', 'winner'),
      id: 'nested-race-competitor' as NodeId,
    };
    const race = makeRaceInputs('nested-continuation-parent-race');
    const raceOutput = makeGraphOutput('race-result');
    const project = makeProject(
      [subgraph, competitor, race, raceOutput],
      [
        connect(subgraph.id, 'child-result', race.id, 'input1'),
        connect(competitor.id, 'output', race.id, 'input2'),
        connect(race.id, 'result', raceOutput.id, 'value'),
      ],
    );
    project.graphs[childGraphId] = childGraph;
    const processor = new GraphProcessor(project, graphId, createRegistry());

    AssistantMessageProbeNodeImpl.handlers.set('nested-race-async-probe', async (_message, context) => {
      asyncStarted.resolve();
      if (!context.signal.aborted) {
        await Promise.race([
          new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true })),
          delay(100),
        ]);
      }
      asyncObservedAbort = context.signal.aborted;
      asyncSettled.resolve();
    });
    IndependentValueNodeImpl.handlers.set('nested-race-child-foreground', async (context) => {
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    });
    IndependentValueNodeImpl.handlers.set('nested-race-competitor', async () => {
      await asyncStarted.promise;
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));

    const outputs = await withTimeout(processor.processGraph(testProcessContext()), 'nested continuation parent race');

    await withTimeout(asyncSettled.promise, 'nested continuation async cancellation');
    assert.deepEqual(outputs['race-result' as PortId], { type: 'string', value: 'winner' });
    assert.equal(asyncObservedAbort, true);
  });

  for (const abortMode of ['successful', 'error'] as const) {
    it(`routes an immediate-branch ${abortMode} abort to the owning graph exactly once`, async () => {
      const graphAborts: ProcessEvents['graphAbort'][] = [];
      const graphAbortObserved = deferred();
      const llm = makeLLM([
        { assistantMessage: 'I need to stop this graph.', toolCalls: [makeToolCall('call-1', 'lookup')] },
      ]);
      const delegate = makeDelegate();
      const probe = makeProbe(`abort-${abortMode}`);
      const processor = new GraphProcessor(
        makeProject(
          [llm, delegate, probe],
          [
            connect('llm', 'function-calls', 'delegate', 'function-call'),
            connect('delegate', 'assistant-message', probe.id, 'message'),
          ],
        ),
        graphId,
        createRegistry(),
      );

      AssistantMessageProbeNodeImpl.handlers.set(`abort-${abortMode}`, async (_message, context) => {
        context.abortGraph(abortMode === 'error' ? new Error('branch requested error abort') : undefined);
      });
      processor.setExternalFunction('lookup', async () => {
        await delay(5);
        return { type: 'string', value: 'lookup result' };
      });
      processor.on('graphAbort', (event: ProcessEvents['graphAbort']) => {
        graphAborts.push(event);
        graphAbortObserved.resolve();
      });

      const runPromise = withTimeout(processor.processGraph(testProcessContext()), `${abortMode} owning-graph abort`);
      if (abortMode === 'successful') {
        await runPromise;
      } else {
        await assert.rejects(runPromise);
      }
      await withTimeout(graphAbortObserved.promise, `${abortMode} graphAbort event`);
      await delay(5);

      assert.equal(graphAborts.length, 1);
      assert.equal(graphAborts[0]!.graph.metadata?.id, graphId);
      assert.equal(graphAborts[0]!.successful, abortMode === 'successful');
      if (abortMode === 'error') {
        assert.match(String(graphAborts[0]!.error), /branch requested error abort/);
      }
    });
  }

  it('Run To the LLM executes its tool but skips unrelated Delegate downstream side effects', async () => {
    let toolRunCount = 0;
    let sideEffectCount = 0;
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const sideEffect = makeProbe('run-to-side-effect');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, sideEffect],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', sideEffect.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    processor.runToNodeIds = [llm.id];

    AssistantMessageProbeNodeImpl.handlers.set('run-to-side-effect', async () => {
      sideEffectCount++;
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'Run To LLM continuation');

    assert.equal(toolRunCount, 1);
    assert.equal(sideEffectCount, 0);
  });

  it('does not synthesize or re-enter a Delegate continuation branch that feeds back into its owning LLM', async () => {
    let toolRunCount = 0;
    let transformRunCount = 0;
    const llmStarts: ProcessId[] = [];
    const llm = makeLLM([{ assistantMessage: '', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const transform = makeAssistantMessageTransform('feedback-cycle');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, transform],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', transform.id, 'message'),
          connect(transform.id, 'output', llm.id, 'feedback'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    processor.runToNodeIds = [llm.id];
    // Seed the unsupported feedback cycle so Run To can reach the owning LLM.
    // The continuation scheduler must still leave the SCC to ordinary graph
    // semantics instead of synthesizing a second transform/LLM execution.
    processor.preloadNodeData(transform.id, {
      ['output' as PortId]: { type: 'string', value: 'seeded feedback' },
    });

    AssistantMessageTransformNodeImpl.handlers.set('feedback-cycle', async (message) => {
      transformRunCount++;
      return `feedback:${message}`;
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === llm.id) {
        llmStarts.push(event.processId);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'Delegate feedback-cycle guard');

    assert.equal(toolRunCount, 1);
    assert.equal(transformRunCount, 0);
    assert.equal(FakeLLMNodeImpl.processCount, 1);
    assert.equal(llmStarts.length, 1);
  });

  it('rejects an active pre-tool self-loop before invoking tools', async () => {
    let toolRunCount = 0;
    let transformRunCount = 0;
    let probeRunCount = 0;
    const llm = makeLLM([{ assistantMessage: 'Self-loop status', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const transform = makeAssistantMessageTransform('self-loop');
    const probe = makeProbe('self-loop');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, transform, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', transform.id, 'message'),
          connect(transform.id, 'output', transform.id, 'message'),
          connect(transform.id, 'output', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageTransformNodeImpl.handlers.set('self-loop', async (message) => {
      transformRunCount++;
      return message;
    });
    AssistantMessageProbeNodeImpl.handlers.set('self-loop', async () => {
      probeRunCount++;
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });

    await assert.rejects(
      withTimeout(processor.processGraph(testProcessContext()), 'self-loop continuation rejection'),
      (error: Error | AggregateError) => {
        const errors = error instanceof AggregateError ? error.errors : [error];
        assert.equal(
          errors.some((cause) => /cannot fire its pre-tool Message branch/.test(String(cause))),
          true,
        );
        return true;
      },
    );

    assert.equal(toolRunCount, 0);
    assert.equal(transformRunCount, 0);
    assert.equal(probeRunCount, 0);
  });

  it('ignores a stale invalid-port self-loop when running a pre-tool branch', async () => {
    let toolRunCount = 0;
    let transformRunCount = 0;
    let probeRunCount = 0;
    const llm = makeLLM([{ assistantMessage: 'Valid status branch', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const transform = makeAssistantMessageTransform('stale-self-loop');
    const probe = makeProbe('stale-self-loop');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, transform, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', transform.id, 'message'),
          connect(transform.id, 'output', transform.id, 'removed-port'),
          connect(transform.id, 'output', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageTransformNodeImpl.handlers.set('stale-self-loop', async (message) => {
      transformRunCount++;
      return message;
    });
    AssistantMessageProbeNodeImpl.handlers.set('stale-self-loop', async () => {
      probeRunCount++;
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'stale self-loop continuation');

    assert.equal(toolRunCount, 1);
    assert.equal(transformRunCount, 1);
    assert.equal(probeRunCount, 1);
  });

  it('runs a mixed Assistant Message and Tool Result consumer once after tools finish with both values', async () => {
    const events: string[] = [];
    const probeRuns: Array<{ assistantMessage: string; toolResult: string | undefined }> = [];
    const llm = makeLLM([
      { assistantMessage: 'I am checking that now.', toolCalls: [makeToolCall('call-1', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const probe = makeProbe('mixed-delegate-ports');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', probe.id, 'message'),
          connect('delegate', 'output', probe.id, 'other'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('mixed-delegate-ports', async (message, _context, otherValue) => {
      events.push('probe:run');
      probeRuns.push({ assistantMessage: message, toolResult: otherValue });
    });
    processor.setExternalFunction('lookup', async () => {
      events.push('tool:start');
      await delay(15);
      events.push('tool:finish');
      return { type: 'string', value: 'lookup result' };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'mixed Delegate-port consumer');

    assert.equal(probeRuns.length, 1);
    assert.equal(probeRuns[0]!.assistantMessage, 'I am checking that now.');
    assert.deepEqual(JSON.parse(probeRuns[0]!.toolResult!), {
      type: 'string',
      value: 'lookup result',
    });
    assert.deepEqual(events, ['tool:start', 'tool:finish', 'probe:run']);
  });

  it('preserves original-graph active output ports for an early branch node', async () => {
    const immediateValues: string[] = [];
    const deferredValues: Array<{ llm: string; value: string }> = [];
    const llm = makeLLM([{ assistantMessage: 'Active output status', toolCalls: [makeToolCall('call-1', 'lookup')] }]);
    const delegate = makeDelegate();
    const activeOutput = { ...ActiveOutputProbeNodeImpl.create(), id: 'active-output' as NodeId };
    const immediateProbe = makeProbe('active-output');
    const deferredConsumer = makeCombinedFinalConsumer('active-output');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, activeOutput, immediateProbe, deferredConsumer],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', activeOutput.id, 'message'),
          connect(activeOutput.id, 'immediate', immediateProbe.id, 'message'),
          connect(activeOutput.id, 'deferred', deferredConsumer.id, 'delegate'),
          connect('llm', 'response', deferredConsumer.id, 'llm'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageProbeNodeImpl.handlers.set('active-output', async (message) => {
      immediateValues.push(message);
    });
    CombinedFinalConsumerNodeImpl.handlers.set('active-output', async (llmValue, deferredValue) => {
      deferredValues.push({ llm: llmValue, value: deferredValue });
    });
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'lookup result' }));

    await withTimeout(processor.processGraph(testProcessContext()), 'original active output ports');

    assert.deepEqual(immediateValues, ['immediate:Active output status']);
    assert.deepEqual(deferredValues, [{ llm: 'final response', value: 'deferred:Active output status' }]);
  });

  it('keeps early-branch convergence state round-local across a later blank-message tool round', async () => {
    let toolRunCount = 0;
    let transformRunCount = 0;
    const convergenceRuns: Array<{ transformedMessage: string; toolResult: string }> = [];
    const llm = makeLLM([
      { assistantMessage: 'Round one status', toolCalls: [makeToolCall('call-1', 'lookup')] },
      { assistantMessage: '', toolCalls: [makeToolCall('call-2', 'lookup')] },
    ]);
    const delegate = makeDelegate();
    const transform = makeAssistantMessageTransform('round-local-convergence');
    const convergence = makeCombinedFinalConsumer('round-local-convergence');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, transform, convergence],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'assistant-message', transform.id, 'message'),
          connect(transform.id, 'output', convergence.id, 'llm'),
          connect('delegate', 'output', convergence.id, 'delegate'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    AssistantMessageTransformNodeImpl.handlers.set('round-local-convergence', async (message) => {
      transformRunCount++;
      return `transformed:${message}`;
    });
    CombinedFinalConsumerNodeImpl.handlers.set('round-local-convergence', async (transformedMessage, toolResult) => {
      convergenceRuns.push({ transformedMessage, toolResult });
    });
    processor.setExternalFunction('lookup', async () => {
      toolRunCount++;
      return { type: 'string', value: `tool result ${toolRunCount}` };
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'round-local convergence state');

    assert.equal(toolRunCount, 2);
    assert.equal(transformRunCount, 1);
    assert.equal(convergenceRuns.length, 1);
    assert.equal(convergenceRuns[0]!.transformedMessage, 'transformed:Round one status');
    assert.deepEqual(JSON.parse(convergenceRuns[0]!.toolResult), {
      type: 'string',
      value: 'tool result 1',
    });
  });

  it('runs parallel tool calls as distinct scalar Delegate invocations in model order', async () => {
    const completionOrder: string[] = [];
    const llm = makeLLM([
      {
        assistantMessage: '',
        toolCalls: [
          makeToolCall('call-slow', 'slow', { position: 1 }),
          makeToolCall('call-fast', 'fast', { position: 2 }),
          makeToolCall('call-medium', 'medium', { position: 3 }),
        ],
      },
    ]);
    const delegate = makeDelegate();
    const processor = new GraphProcessor(
      makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
      graphId,
      createRegistry(),
    );
    const delegateStarts: Array<{ processId: ProcessId; toolCallId: string }> = [];
    const delegateFinishes = new Map<ProcessId, Outputs>();
    const toolEvents: ProcessEvents['toolCallFinished'][] = [];

    processor.setExternalFunction('slow', async () => {
      await delay(30);
      completionOrder.push('slow');
      return { type: 'string', value: 'slow result' };
    });
    processor.setExternalFunction('fast', async () => {
      await delay(1);
      completionOrder.push('fast');
      return { type: 'string', value: 'fast result' };
    });
    processor.setExternalFunction('medium', async () => {
      await delay(10);
      completionOrder.push('medium');
      return { type: 'string', value: 'medium result' };
    });
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id !== delegate.id) return;
      const input = event.inputs['function-call' as PortId];
      assert.ok(input && input.type === 'object' && !Array.isArray(input.value));
      delegateStarts.push({
        processId: event.processId,
        toolCallId: String((input.value as { id?: unknown }).id),
      });
    });
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === delegate.id) {
        delegateFinishes.set(event.processId, event.outputs);
      }
    });
    processor.on('toolCallFinished', (event) => toolEvents.push(event));

    await withTimeout(processor.processGraph(testProcessContext()), 'parallel tool batch');

    assert.deepEqual(completionOrder, ['fast', 'medium', 'slow']);
    assert.deepEqual(
      delegateStarts.map((run) => run.toolCallId),
      ['call-slow', 'call-fast', 'call-medium'],
    );
    assert.equal(new Set(delegateStarts.map((run) => run.processId)).size, 3);
    assert.equal(delegateFinishes.size, 3);
    const outputsInModelOrder = delegateStarts.map((run) => {
      const outputs = delegateFinishes.get(run.processId);
      const output = outputs?.['output' as PortId];
      assert.ok(output && output.type === 'string');
      const toolName = outputs?.['tool-name' as PortId];
      const toolArguments = outputs?.['tool-arguments' as PortId];
      assert.ok(toolName && toolName.type === 'string');
      assert.ok(toolArguments && toolArguments.type === 'object' && !Array.isArray(toolArguments.value));
      return {
        arguments: toolArguments.value,
        name: toolName.value,
        output: (JSON.parse(output.value) as { value: string }).value,
      };
    });
    assert.deepEqual(outputsInModelOrder, [
      { arguments: { position: 1 }, name: 'slow', output: 'slow result' },
      { arguments: { position: 2 }, name: 'fast', output: 'fast result' },
      { arguments: { position: 3 }, name: 'medium', output: 'medium result' },
    ]);
    assert.deepEqual(
      FakeLLMNodeImpl.continuationRecords.map((record) => record.id),
      ['call-slow', 'call-fast', 'call-medium'],
    );
    assert.deepEqual(toolEvents.map((event) => event.toolCallId).sort(), ['call-fast', 'call-medium', 'call-slow']);
    assert.equal(
      toolEvents.every((event) => event.sourceNodeId === llm.id),
      true,
    );
    assert.equal(new Set(toolEvents.map((event) => event.sourceProcessId)).size, 1);
    assert.equal(
      toolEvents.every((event) => event.handlerKind === 'external' && event.outcome === 'success'),
      true,
    );
    assert.equal(
      toolEvents.every((event) => !('arguments' in event) && !('result' in event)),
      true,
    );
  });

  it('runs scalar result branches once per parallel Delegate invocation', async () => {
    const llm = makeLLM([
      {
        assistantMessage: '',
        toolCalls: [makeToolCall('call-one', 'one'), makeToolCall('call-two', 'two')],
      },
    ]);
    const delegate = makeDelegate();
    const probe = makeProbe('per-call-results');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, probe],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', probe.id, 'message'),
        ],
      ),
      graphId,
      createRegistry(),
    );
    const probeStarts: ProcessId[] = [];
    const resultValues: string[] = [];

    AssistantMessageProbeNodeImpl.handlers.set('per-call-results', async (message) => {
      resultValues.push((JSON.parse(message) as { value: string }).value);
    });
    processor.setExternalFunction('one', async () => ({ type: 'string', value: 'one result' }));
    processor.setExternalFunction('two', async () => ({ type: 'string', value: 'two result' }));
    processor.on('nodeStart', (event: ProcessEvents['nodeStart']) => {
      if (event.node.id === probe.id) probeStarts.push(event.processId);
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'per-call Delegate result branches');

    assert.deepEqual([...resultValues].sort(), ['one result', 'two result']);
    assert.equal(probeStarts.length, 2);
    assert.notEqual(probeStarts[0], probeStarts[1]);
  });

  it('commits concurrent result-branch Graph Outputs in model-call order', async () => {
    const llm = makeLLM([
      {
        assistantMessage: '',
        toolCalls: [makeToolCall('call-slow', 'slow'), makeToolCall('call-fast', 'fast')],
      },
    ]);
    const delegate = makeDelegate();
    const graphOutput = makeGraphOutput('delegatedResult');
    const processor = new GraphProcessor(
      makeProject(
        [llm, delegate, graphOutput],
        [
          connect('llm', 'function-calls', 'delegate', 'function-call'),
          connect('delegate', 'output', graphOutput.id, 'value'),
        ],
      ),
      graphId,
      createRegistry(),
    );

    processor.setExternalFunction('slow', async () => {
      await delay(30);
      return { type: 'string', value: 'first model call' };
    });
    processor.setExternalFunction('fast', async () => ({ type: 'string', value: 'second model call' }));

    const outputs = await withTimeout(
      processor.processGraph(testProcessContext()),
      'ordered continuation Graph Output commits',
    );

    const delegatedResult = outputs['delegatedResult'];
    assert.ok(delegatedResult && delegatedResult.type === 'string');
    assert.deepEqual(JSON.parse(delegatedResult.value), {
      type: 'string',
      value: 'first model call',
    });
  });

  it('keeps per-call Delegate costs and aggregates them once into the graph cost', async () => {
    const llm = makeLLM([
      {
        assistantMessage: '',
        toolCalls: [makeToolCall('call-one', 'one'), makeToolCall('call-two', 'two')],
      },
    ]);
    const delegate = makeDelegate();
    const processor = new GraphProcessor(
      makeProject([llm, delegate], [connect('llm', 'function-calls', 'delegate', 'function-call')]),
      graphId,
      createRegistry(),
    );
    const delegateCosts: number[] = [];

    processor.setExternalFunction('one', async () => ({ type: 'string', value: 'one result', cost: 2 }));
    processor.setExternalFunction('two', async () => ({ type: 'string', value: 'two result', cost: 3 }));
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      if (event.node.id === delegate.id) {
        const cost = event.outputs['cost' as PortId];
        assert.ok(cost && cost.type === 'number');
        delegateCosts.push(cost.value);
      }
    });

    const outputs = await withTimeout(processor.processGraph(testProcessContext()), 'parallel tool cost aggregation');

    assert.deepEqual(delegateCosts, [2, 3]);
    assert.deepEqual(outputs['cost' as PortId], { type: 'number', value: 5 });
  });
});
