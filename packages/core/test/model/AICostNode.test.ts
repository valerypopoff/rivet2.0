import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AICostNodeImpl,
  DidRunNodeImpl,
  ExecutionRecorder,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  NodeImpl,
  StartBackgroundBranchNodeImpl,
  SubGraphNodeImpl,
  createBuiltInRegistry,
  nodeDefinition,
  type ChartNode,
  type GraphId,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeGraph,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { RunCostLedger } from '../../src/model/RunCostLedger.js';
import { getWarnings } from '../../src/utils/outputs.js';
import { testProcessContext } from '../testUtils.js';

const wire = (from: ChartNode, output: string, to: ChartNode, input: string): NodeConnection => ({
  outputNodeId: from.id,
  outputId: output as PortId,
  inputNodeId: to.id,
  inputId: input as PortId,
});

test('AI Cost exposes three Debug outputs and preserves unknown versus genuine zero', async () => {
  const node = new AICostNodeImpl(AICostNodeImpl.create());
  assert.deepEqual(AICostNodeImpl.getUIData().group, ['Debug']);
  assert.deepEqual(node.getInputDefinitions(), []);
  node.chartNode.isConditional = true;
  assert.deepEqual(
    node
      .getInputDefinitionsIncludingBuiltIn(
        [],
        {},
        { metadata: { id: 'ports' as ProjectId, title: '', description: '' }, graphs: {} },
        {},
      )
      .map((port) => port.id),
    ['$if'],
  );
  assert.deepEqual(
    node.getOutputDefinitions().map((p) => [p.id, p.title, p.dataType]),
    [
      ['llmCost', 'LLM cost', 'number'],
      ['decisionAICost', 'Decision AI cost', 'number'],
      ['totalCost', 'Sum cost', 'number'],
    ],
  );
  const ledger = new RunCostLedger();
  const context = { getRunCostBreakdown: () => ledger.breakdown() } as InternalProcessContext;
  assert.deepEqual(await node.process({}, context), {
    llmCost: { type: 'number', value: 0 },
    decisionAICost: { type: 'number', value: 0 },
    totalCost: { type: 'number', value: 0 },
  });
  ledger.observeClassifier({ family: 'classifier', attemptIndex: 0, eventId: 'unknown' } as never);
  let result = await node.process({}, context);
  assert.equal(result.llmCost?.value, 0);
  assert.equal(result.decisionAICost?.type, 'control-flow-excluded');
  assert.equal(result.totalCost?.type, 'control-flow-excluded');
  assert.ok(getWarnings(result)?.length);
  ledger.observeChat({ callId: 'paid', pricing: { status: 'known', costUsd: 0.25 } } as never);
  result = await node.process({}, context);
  assert.deepEqual(result.totalCost, { type: 'number', value: 0.25 });
  assert.deepEqual(ledger.snapshot(), { status: 'partial', knownCostUsd: 0.25 });
  await assert.rejects(node.process({}, {} as InternalProcessContext), /accounting is unavailable/);
});

for (const scheduler of ['compatible', 'fast-acyclic'] as const) {
  test(`AI Cost uses only the standard conditional input to run or skip (${scheduler})`, async () => {
    const input = GraphInputNodeImpl.create();
    input.data = { id: 'enabled', dataType: 'boolean' };
    const cost = { ...AICostNodeImpl.create(), isConditional: true };
    const graphId = 'main' as GraphId;
    const project: Project = {
      metadata: { id: 'conditional-cost' as ProjectId, title: '', description: '' },
      graphs: {
        [graphId]: { metadata: { id: graphId }, nodes: [input, cost], connections: [wire(input, 'data', cost, '$if')] },
      },
    };
    const processor = new GraphProcessor(project, graphId, createBuiltInRegistry(), { scheduler });
    let executed = 0,
      excluded = 0;
    processor.on('nodeFinish', (event) => {
      if (event.node.id === cost.id) executed++;
    });
    processor.on('nodeExcluded', (event) => {
      if (event.node.id === cost.id) excluded++;
    });
    await processor.processGraph(testProcessContext(), { enabled: { type: 'boolean', value: false } });
    assert.equal(executed, 0);
    assert.equal(excluded, 1);
    await processor.processGraph(testProcessContext(), { enabled: { type: 'boolean', value: true } });
    assert.equal(executed, 1);
    assert.equal(excluded, 1);
    assert.deepEqual(processor.getRunCostSnapshot(), { status: 'complete', knownCostUsd: 0 });
  });

  for (const reenterProject of [false, true]) {
    test(`AI Cost reads each project's subtree across parallel A → B → C calls with ${reenterProject ? 'explicit project reentry' : 'local graph calls'} (${scheduler})`, async () => {
      let factor = 1;
      let pauseRoot: Promise<void> | undefined = undefined;
      const paused = Promise.withResolvers<void>();
      const rootContexts: InternalProcessContext[] = [];
      const readers: (() => ReturnType<RunCostLedger['breakdown']>)[] = [];
      const childReaders: (() => ReturnType<RunCostLedger['breakdown']>)[] = [];
      type CallNode = ChartNode<'costFixture', { llm: number; decision: number }>;
      class Call extends NodeImpl<CallNode> {
        static create(): CallNode {
          return {
            type: 'costFixture',
            id: 'call' as NodeId,
            title: 'Observation fixture',
            visualData: { x: 0, y: 0, width: 200 },
            data: { llm: 0, decision: 0 },
          };
        }
        static getUIData() {
          return { contextMenuTitle: 'Fixture', group: ['Debug'] };
        }
        getInputDefinitions(): NodeInputDefinition[] {
          return [{ id: 'trigger' as PortId, title: 'Trigger', dataType: 'any' }];
        }
        getOutputDefinitions(): NodeOutputDefinition[] {
          return [{ id: 'done' as PortId, title: 'Done', dataType: 'boolean' }];
        }
        async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
          if (context.project.metadata.id === 'a') {
            readers.push(context.getRunCostBreakdown!);
            rootContexts.push(context);
            if (pauseRoot) {
              paused.resolve();
              await pauseRoot;
            }
          }
          if (context.project.metadata.id === 'b') childReaders.push(context.getRunCostBreakdown!);
          for (let duplicate = 0; duplicate < 2; duplicate++) {
            if (this.data.llm)
              context.onChatV2CallFinished?.({
                callId: context.processId,
                pricing: { status: 'known', costUsd: this.data.llm * factor },
              } as never);
            if (this.data.decision)
              context.onLLMProfileAttempt?.({
                family: 'classifier',
                attemptIndex: 0,
                eventId: context.processId,
                classifierUsage: { estimatedCostUsd: this.data.decision * factor },
              } as never);
          }
          return { ['done' as PortId]: { type: 'boolean', value: true } };
        }
      }
      const registry = createBuiltInRegistry().register(nodeDefinition(Call, 'Observation fixture'));
      const projects = ['a', 'b', 'c'].map((name, i): Project => {
        const input = GraphInputNodeImpl.create();
        input.data = { id: 'trigger', dataType: 'any' };
        const call = Call.create();
        call.id = `call-${name}` as NodeId;
        call.data = { llm: i === 0 ? 0.1 : i === 2 ? 0.3 : 0, decision: i === 1 ? 0.2 : 0 };
        const cost = AICostNodeImpl.create();
        cost.isConditional = true;
        const nodes: ChartNode[] = [input, call, cost];
        const connections = [wire(input, 'data', call, 'trigger')];
        const extraGraphs: Record<string, NodeGraph> = {};
        let beforeChild: ChartNode = call;
        let beforeChildPort = 'done';
        if (name === 'b') {
          const localInput = GraphInputNodeImpl.create();
          localInput.data = { id: 'trigger', dataType: 'boolean' };
          const localCost = { ...AICostNodeImpl.create(), isConditional: true };
          const asyncBranch = StartBackgroundBranchNodeImpl.create();
          const localOutput = GraphOutputNodeImpl.create();
          localOutput.data = { id: 'done', dataType: 'boolean' };
          extraGraphs.local = {
            metadata: { id: 'local' as GraphId },
            nodes: [localInput, asyncBranch, localCost, localOutput],
            connections: [
              wire(localInput, 'data', asyncBranch, 'input1'),
              wire(asyncBranch, 'output1', localCost, '$if'),
              wire(localInput, 'data', localOutput, 'value'),
            ],
          };
          const localCall = SubGraphNodeImpl.create();
          localCall.data.graphId = 'local' as GraphId;
          if (reenterProject) localCall.data.targetProjectId = 'b' as ProjectId;
          nodes.push(localCall);
          connections.push(wire(call, 'done', localCall, 'trigger'));
          beforeChild = localCall;
          beforeChildPort = 'done';
        }
        if (i < 2) {
          const join = DidRunNodeImpl.create();
          nodes.push(join);
          for (let repeat = 0; repeat < (i === 0 ? 2 : 1); repeat++) {
            const child = SubGraphNodeImpl.create();
            child.data.targetProjectId = ['b', 'c'][i] as ProjectId;
            child.data.graphId = 'main' as GraphId;
            nodes.push(child);
            connections.push(
              wire(beforeChild, beforeChildPort, child, 'trigger'),
              wire(child, 'totalCost', join, `input${repeat + 1}`),
            );
          }
          connections.push(wire(join, 'ran', cost, '$if'));
        } else connections.push(wire(call, 'done', cost, '$if'));
        for (const id of ['llmCost', 'decisionAICost', 'totalCost']) {
          const output = GraphOutputNodeImpl.create();
          output.data = { id, dataType: 'number' };
          nodes.push(output);
          connections.push(wire(cost, id, output, 'value'));
        }
        return {
          metadata: { id: name as ProjectId, title: name, description: '', mainGraphId: 'main' as GraphId },
          plugins: [],
          graphs: { ...extraGraphs, main: { metadata: { id: 'main' as GraphId, name: 'Main' }, nodes, connections } },
        };
      });
      const processor = new GraphProcessor(projects[0]!, 'main' as GraphId, registry, { scheduler });
      const childSnapshots: { project: string | undefined; graph: string | undefined; outputs: Outputs }[] = [];
      processor.on('nodeFinish', (event) => {
        if (event.node.type === 'aiCost')
          childSnapshots.push({
            project: event.execution?.projectId,
            graph: event.execution?.graphId,
            outputs: event.outputs,
          });
      });
      const run = () =>
        processor.processGraph(
          {
            ...testProcessContext(),
            subgraphProjectLoader: {
              loadTarget: async ({ projectId }) => ({ project: projects.find((p) => p.metadata.id === projectId)! }),
            },
          },
          { trigger: { type: 'boolean', value: true } },
        );
      const result = await run();
      assert.ok(Math.abs(Number(result.llmCost?.value) - 0.7) < 1e-12);
      assert.ok(Math.abs(Number(result.decisionAICost?.value) - 0.4) < 1e-12);
      assert.equal(
        result.totalCost?.value,
        processor.getRunCostSnapshot().knownCostUsd,
        'Identical to recording/statistics accounting',
      );
      for (const project of ['b', 'c']) {
        const snapshots = childSnapshots.filter(
          (snapshot) => snapshot.project === project && snapshot.graph === 'main',
        );
        assert.equal(snapshots.length, 2, 'Repeated calls have distinct project-invocation scopes');
        for (const { outputs } of snapshots) {
          assert.equal(outputs['llmCost' as PortId]?.value, 0.3, 'Exclude parent and sibling LLM spending');
          assert.equal(outputs['decisionAICost' as PortId]?.value, project === 'b' ? 0.2 : 0);
          assert.equal(outputs['totalCost' as PortId]?.value, project === 'b' ? 0.5 : 0.3);
        }
      }
      const localSnapshots = childSnapshots.filter((snapshot) => snapshot.graph === 'local');
      assert.equal(localSnapshots.length, 2);
      for (const { outputs } of localSnapshots) {
        assert.equal(
          outputs['decisionAICost' as PortId]?.value,
          reenterProject ? 0 : 0.2,
          'Local graphs share the project scope; explicit project reentry starts a separate subtree',
        );
        assert.equal(outputs['llmCost' as PortId]?.value, 0);
      }
      const oldReader = readers[0]!;
      const oldTotal = oldReader().total;
      const oldChildReader = childReaders[0]!;
      const oldChildTotal = oldChildReader().total;
      childSnapshots.length = 0;
      factor = 0;
      assert.equal((await run()).totalCost?.value, 0);
      assert.deepEqual(oldReader().total, oldTotal, 'Old contexts cannot read the next invocation ledger');
      assert.deepEqual(oldChildReader().total, oldChildTotal, 'Old child scopes stay bound to their original root');
      assert.ok(childSnapshots.every((snapshot) => snapshot.outputs['totalCost' as PortId]?.value === 0));
      assert.deepEqual(processor.getRunCostSnapshot(), { status: 'complete', knownCostUsd: 0 });
      const release = Promise.withResolvers<void>();
      pauseRoot = release.promise;
      const recorder = new ExecutionRecorder();
      const stopRecording = recorder.record(processor);
      const current = run();
      try {
        await Promise.race([
          paused.promise,
          current.then(() => {
            throw new Error('Run ended before the observation gate');
          }),
        ]);
        const events: string[] = [];
        const observationTypes = new Set([
          'llmCallFinished',
          'llmProfileAttempt',
          'llmChatOutputSnapshot',
          'toolCallFinished',
        ]);
        const stopObserving = processor.onAny((event) => {
          if (observationTypes.has(event)) events.push(event);
        });
        try {
          const old = rootContexts[0]!;
          old.onChatV2CallFinished?.({ callId: 'late-llm', pricing: { status: 'known', costUsd: 0.25 } } as never);
          old.onLLMProfileAttempt?.({
            family: 'classifier',
            attemptIndex: 0,
            eventId: 'late-decision',
            classifierUsage: { estimatedCostUsd: 0.5 },
          } as never);
          await old.onLLMChatOutputSnapshot?.({ entryId: 'late-snapshot', outputs: {} } as never);
          old.onToolCallFinished?.({ toolCallId: 'late-tool' } as never);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(events, [], 'An old context must not forward its observations into a newer invocation');
          assert.equal(
            recorder.events.some((event) => observationTypes.has(event.type)),
            false,
            'The new recording must not capture stale observations',
          );
          assert.deepEqual(rootContexts.at(-1)!.getRunCostBreakdown!().total, { status: 'complete', knownCostUsd: 0 });
          assert.equal(
            old.getRunCostBreakdown!().total.knownCostUsd,
            oldTotal.knownCostUsd! + 0.25 + 0.5,
            'Late costs remain owned by the original ledger',
          );
        } finally {
          stopObserving();
        }
        release.resolve();
        assert.equal((await current).totalCost?.value, 0);
      } finally {
        release.resolve();
        await current.catch(() => undefined);
        stopRecording();
      }
    });
  }

  test(
    `AI Cost snapshots stay detached while concurrent roots settle priced or unknown calls (${scheduler})`,
    { timeout: 5_000 },
    async () => {
      await Promise.all(
        [0.5, undefined].map(async (decisionCost) => {
          const started = Promise.withResolvers<InternalProcessContext>();
          const release = Promise.withResolvers<void>();
          let executions = 0;
          type HeldNode = ChartNode<'heldCostFixture', Record<string, never>>;
          class HeldCall extends NodeImpl<HeldNode> {
            static create(): HeldNode {
              return {
                type: 'heldCostFixture',
                id: 'held' as NodeId,
                title: 'Held call',
                visualData: { x: 0, y: 0, width: 200 },
                data: {},
              };
            }
            static getUIData() {
              return { contextMenuTitle: 'Held call', group: ['Debug'] };
            }
            getInputDefinitions(): NodeInputDefinition[] {
              return [];
            }
            getOutputDefinitions(): NodeOutputDefinition[] {
              return [{ id: 'done' as PortId, title: 'Done', dataType: 'boolean' }];
            }
            async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
              executions++;
              context.onChatV2CallFinished?.({
                callId: context.processId,
                pricing: { status: 'known', costUsd: 0.25 },
              } as never);
              started.resolve(context);
              await release.promise;
              context.onLLMProfileAttempt?.({
                family: 'classifier',
                attemptIndex: 0,
                eventId: context.processId,
                classifierUsage: { estimatedCostUsd: decisionCost },
              } as never);
              return { ['done' as PortId]: { type: 'boolean', value: true } };
            }
          }
          const held = HeldCall.create();
          const cost = AICostNodeImpl.create();
          cost.isConditional = true;
          const output = GraphOutputNodeImpl.create();
          output.data = { id: 'sum', dataType: 'number' };
          const graphId = 'main' as GraphId;
          const project: Project = {
            metadata: { id: `pending-${decisionCost}` as ProjectId, title: '', description: '' },
            graphs: {
              [graphId]: {
                metadata: { id: graphId },
                nodes: [held, cost, output],
                connections: [wire(held, 'done', cost, '$if'), wire(cost, 'totalCost', output, 'value')],
              },
            },
          };
          const registry = createBuiltInRegistry().register(nodeDefinition(HeldCall, 'Held call'));
          const processor = new GraphProcessor(project, graphId, registry, { scheduler });
          let finalNodeOutputs: Outputs | undefined;
          processor.on('nodeFinish', (event) => {
            if (event.node.id === cost.id) finalNodeOutputs = event.outputs;
          });
          const recorder = new ExecutionRecorder();
          const stopRecording = recorder.record(processor);
          const running = processor.processGraph(testProcessContext());
          try {
            const context = await Promise.race([
              started.promise,
              running.then(() => {
                throw new Error('Run ended without entering the held call');
              }),
            ]);
            const early = await new AICostNodeImpl(cost).process({}, context);
            assert.deepEqual(early, {
              llmCost: { type: 'number', value: 0.25 },
              decisionAICost: { type: 'number', value: 0 },
              totalCost: { type: 'number', value: 0.25 },
            });
            assert.deepEqual(
              processor.getRunCostSnapshot(),
              { status: 'partial', knownCostUsd: 0.25 },
              'Final-summary coverage still accounts for pending work',
            );
            release.resolve();
            const result = await running;
            assert.equal(result.sum?.value, decisionCost === undefined ? 0.25 : 0.75);
            assert.equal(finalNodeOutputs?.['totalCost' as PortId]?.value, processor.getRunCostSnapshot().knownCostUsd);
            assert.equal(
              finalNodeOutputs?.['decisionAICost' as PortId]?.type,
              decisionCost === undefined ? 'control-flow-excluded' : 'number',
            );
            assert.equal(Boolean(getWarnings(finalNodeOutputs!)), decisionCost === undefined);
            assert.equal(early['totalCost' as PortId]?.value, 0.25, 'Later calls cannot change an earlier output');
            const replay = new GraphProcessor(project, graphId, registry, { scheduler });
            replay.recordingPlaybackChatLatency = 0;
            let replayedOutputs: Outputs | undefined;
            replay.on('nodeFinish', (event) => {
              if (event.node.id === cost.id) replayedOutputs = event.outputs;
            });
            const replayed = await replay.replayRecording(
              ExecutionRecorder.deserializeFromString(recorder.serialize()),
            );
            assert.deepEqual(replayed.sum, result.sum);
            for (const port of ['llmCost', 'decisionAICost', 'totalCost'] as PortId[]) {
              assert.equal(replayedOutputs?.[port]?.type, finalNodeOutputs?.[port]?.type);
              assert.equal(replayedOutputs?.[port]?.value, finalNodeOutputs?.[port]?.value);
            }
            assert.deepEqual(getWarnings(replayedOutputs!), getWarnings(finalNodeOutputs!));
            assert.equal(executions, 1, 'Playback must not rerun AI work');
            assert.deepEqual(
              replay.getRunCostSnapshot(),
              { status: 'complete', knownCostUsd: 0 },
              'Replayed observations are not new spend',
            );
          } finally {
            release.resolve();
            await running.catch(() => undefined);
            stopRecording();
          }
        }),
      );
    },
  );
}
