import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import {
  createBuiltInRegistry,
  createGraphRunner,
  createProcessor,
  nodeDefinition,
  NodeImpl,
  runGraph,
  runGraphInFile,
  type ChartNode,
  type ChatV2CallFinishedEvent,
  type ChatV2CallId,
  type GraphId,
  type Inputs,
  type InternalProcessContext,
  type NodeGraph,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
} from '../src/index.js';

type AccountingProbeNode = ChartNode<'accountingProbe', Record<string, never>>;

class AccountingProbeNodeImpl extends NodeImpl<AccountingProbeNode> {
  static processCalls = 0;

  static create(): AccountingProbeNode {
    return {
      data: {},
      id: 'accounting-probe' as NodeId,
      title: 'Accounting Probe',
      type: 'accountingProbe',
      visualData: { x: 0, y: 0 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ dataType: 'string', id: 'output' as PortId, title: 'Output' }];
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    AccountingProbeNodeImpl.processCalls += 1;
    context.onChatV2CallFinished?.({
      callId: `probe-${context.processId}` as ChatV2CallId,
      attemptIndex: 0,
      nodeId: context.node.id,
      processId: context.processId,
      provider: 'custom',
      model: 'probe-model',
      outcome: 'success',
      pricing: { status: 'unknown' },
    });

    return { output: { type: 'string', value: 'observed' } };
  }
}

const accountingProbeNode = nodeDefinition(AccountingProbeNodeImpl, 'Accounting Probe');

function makeAccountingProbeProject(): Project {
  const graphId = 'accounting-probe-graph' as GraphId;
  const probeNode = AccountingProbeNodeImpl.create();
  const graph: NodeGraph = {
    connections: [
      {
        inputId: 'value' as PortId,
        inputNodeId: 'accounting-output' as NodeId,
        outputId: 'output' as PortId,
        outputNodeId: probeNode.id,
      },
    ],
    metadata: {
      description: '',
      id: graphId,
      name: 'Accounting Probe',
    },
    nodes: [
      probeNode,
      {
        data: { dataType: 'string', id: 'result' },
        id: 'accounting-output' as NodeId,
        title: 'Output',
        type: 'graphOutput',
        visualData: { x: 200, y: 0 },
      },
    ],
  };

  return {
    graphs: { [graphId]: graph },
    metadata: {
      id: 'accounting-probe-project' as ProjectId,
      mainGraphId: graphId,
      title: 'Accounting Probe',
    },
  };
}

void describe('Node ProcessContext parity', () => {
  void it('forwards the physical-call observer through every public Node graph runner', async () => {
    const project = makeAccountingProbeProject();
    const registry = createBuiltInRegistry().register(accountingProbeNode);
    const runners = [
      {
        name: 'runGraph',
        async run(onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => void) {
          await runGraph(project, { onChatV2CallFinished, registry });
        },
      },
      {
        name: 'createProcessor',
        async run(onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => void) {
          const processor = createProcessor(project, { onChatV2CallFinished, registry });
          try {
            await processor.run();
          } finally {
            processor.dispose();
          }
        },
      },
      {
        name: 'createGraphRunner',
        async run(onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => void) {
          const runner = createGraphRunner(project, { onChatV2CallFinished, registry });
          try {
            await runner.run();
          } finally {
            runner.dispose();
          }
        },
      },
    ] as const;

    for (const runner of runners) {
      const events: ChatV2CallFinishedEvent[] = [];
      await runner.run((event) => events.push(event));

      assert.equal(events.length, 1, runner.name);
      assert.equal(events[0]?.nodeId, 'accounting-probe', runner.name);
      assert.equal(events[0]?.provider, 'custom', runner.name);
      assert.equal(events[0]?.model, 'probe-model', runner.name);
      assert.equal(events[0]?.outcome, 'success', runner.name);
    }
  });

  void it('releases run-scoped abort listeners after every public Node graph runner settles', async () => {
    const project = makeAccountingProbeProject();
    const registry = createBuiltInRegistry().register(accountingProbeNode);

    {
      const controller = new AbortController();
      await runGraph(project, { abortSignal: controller.signal, registry });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'runGraph');
    }

    {
      const controller = new AbortController();
      const processor = createProcessor(project, { abortSignal: controller.signal, registry });
      await processor.run();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'createProcessor');
      processor.dispose();
    }

    {
      const controller = new AbortController();
      const runner = createGraphRunner(project, { registry });
      await runner.run({ abortSignal: controller.signal });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'createGraphRunner');
      runner.dispose();
    }
  });

  void it('does not enter a node when a public Node runner starts pre-aborted', async () => {
    const project = makeAccountingProbeProject();
    const registry = createBuiltInRegistry().register(accountingProbeNode);
    const runPreAborted = [
      async (signal: AbortSignal) => await runGraph(project, { abortSignal: signal, registry }),
      async (signal: AbortSignal) => {
        const processor = createProcessor(project, { abortSignal: signal, registry });
        try {
          return await processor.run();
        } finally {
          processor.dispose();
        }
      },
      async (signal: AbortSignal) => {
        const runner = createGraphRunner(project, { registry });
        try {
          return await runner.run({ abortSignal: signal });
        } finally {
          runner.dispose();
        }
      },
    ];

    for (const run of runPreAborted) {
      AccountingProbeNodeImpl.processCalls = 0;
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        run(controller.signal),
        (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
      );
      assert.equal(AccountingProbeNodeImpl.processCalls, 0);
    }
  });

  void it('rejects a pre-aborted file run before reading the project file', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runGraphInFile('does-not-exist.rivet-project', { abortSignal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  });
});
