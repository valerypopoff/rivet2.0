import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadTestGraphs } from './testUtils';
import {
  CodeNodeImpl,
  createProcessor,
  ExecutionRecorder,
  globalRivetNodeRegistry,
  runGraph,
  type ChartNode,
  type CodeRunner,
  type GraphId,
  type NodeImpl,
  type NodeGraph,
  type NodeId,
  type NodeRegistration,
  type Outputs,
  type PortId,
  type Project,
} from '../src/index.js';
import {
  makeCallGraphFanInProject,
  makeNestedSubgraphProject,
  makeReferencedGraphAliasFanInProject,
  makeRepeatedSubgraphFanInProject,
  makeSubgraphChainProject,
  makeTextChainProject,
} from './runtimeSpeedFixtures.js';

function makeCodeProject(code: string): Project {
  const codeNode = CodeNodeImpl.create();
  codeNode.id = 'code-node' as NodeId;
  codeNode.data = {
    ...codeNode.data,
    allowProcess: true,
    code,
    inputNames: [],
    outputNames: ['output1'],
  };

  const graph: NodeGraph = {
    connections: [],
    metadata: {
      description: '',
      id: 'code-graph' as GraphId,
      name: 'Code Graph',
    },
    nodes: [codeNode],
  };

  return {
    graphs: {
      [graph.metadata!.id!]: graph,
    },
    metadata: {
      id: 'node-api-test-project' as GraphId,
      mainGraphId: graph.metadata!.id,
      title: 'Node API Test Project',
    },
  } as Project;
}

function makeStoredValueProject(mode: 'get' | 'set'): Project {
  const graphId = `stored-value-${mode}-graph` as GraphId;
  const storedNode: ChartNode =
    mode === 'set'
      ? ({
          type: 'setStoredValue',
          title: 'Set Stored Value',
          id: 'stored-node' as NodeId,
          visualData: { x: 200, y: 0 },
          data: { dataType: 'string', key: 'shared', useKeyInput: false },
        } as ChartNode)
      : ({
          type: 'getStoredValue',
          title: 'Get Stored Value',
          id: 'stored-node' as NodeId,
          visualData: { x: 200, y: 0 },
          data: { dataType: 'string', key: 'shared', onDemand: false, useKeyInput: false, wait: false },
        } as ChartNode);
  const graph: NodeGraph = {
    metadata: { description: '', id: graphId, name: `Stored Value ${mode}` },
    nodes: [
      ...(mode === 'set'
        ? [
            {
              type: 'graphInput' as const,
              title: 'Input',
              id: 'input-node' as NodeId,
              visualData: { x: 0, y: 0 },
              data: { dataType: 'string', id: 'input' },
            },
          ]
        : []),
      storedNode,
      {
        type: 'graphOutput',
        title: 'Output',
        id: 'output-node' as NodeId,
        visualData: { x: 400, y: 0 },
        data: { dataType: 'string', id: 'result' },
      },
    ],
    connections: [
      ...(mode === 'set'
        ? [
            {
              inputId: 'value' as PortId,
              inputNodeId: storedNode.id,
              outputId: 'data' as PortId,
              outputNodeId: 'input-node' as NodeId,
            },
          ]
        : []),
      {
        inputId: 'value' as PortId,
        inputNodeId: 'output-node' as NodeId,
        outputId: (mode === 'set' ? 'saved-value' : 'value') as PortId,
        outputNodeId: storedNode.id,
      },
    ],
  };
  return {
    graphs: { [graphId]: graph },
    metadata: { id: 'stored-value-project' as never, mainGraphId: graphId, title: 'Stored Value Project' },
  } as Project;
}

function createCountingRegistry(): {
  getDefinitionCalls: () => number;
  registry: NodeRegistration<any, any>;
} {
  let definitionCalls = 0;

  return {
    getDefinitionCalls: () => definitionCalls,
    registry: {
      createDynamicImpl(node: ChartNode) {
        const impl = globalRivetNodeRegistry.createDynamicImpl(node);
        return trackDefinitionCalls(impl, () => {
          definitionCalls += 1;
        });
      },
      getPluginFor(type: string) {
        return globalRivetNodeRegistry.getPluginFor(type);
      },
      getPlugins() {
        return globalRivetNodeRegistry.getPlugins();
      },
    } as unknown as NodeRegistration<any, any>,
  };
}

function trackDefinitionCalls(impl: NodeImpl<ChartNode>, onDefinitionCall: () => void): NodeImpl<ChartNode> {
  const getInputDefinitionsIncludingBuiltIn = impl.getInputDefinitionsIncludingBuiltIn.bind(impl);
  const getOutputDefinitions = impl.getOutputDefinitions.bind(impl);

  impl.getInputDefinitionsIncludingBuiltIn = (...args) => {
    onDefinitionCall();
    return getInputDefinitionsIncludingBuiltIn(...args);
  };
  impl.getOutputDefinitions = (...args) => {
    onDefinitionCall();
    return getOutputDefinitions(...args);
  };

  return impl;
}

async function countCreateProcessorDefinitionCalls(
  project: Project,
  options: Parameters<typeof createProcessor>[1],
): Promise<number> {
  const countingRegistry = createCountingRegistry();

  await createProcessor(project, {
    ...options,
    registry: countingRegistry.registry,
  }).run();

  return countingRegistry.getDefinitionCalls();
}

async function countRunGraphDefinitionCalls(
  project: Project,
  options: Parameters<typeof runGraph>[1] & { runtimeProfile?: unknown },
): Promise<number> {
  const countingRegistry = createCountingRegistry();

  await runGraph(project, {
    ...options,
    registry: countingRegistry.registry,
  });

  return countingRegistry.getDefinitionCalls();
}

function makeStandardRunOptions(
  graphId: GraphId,
  overrides: Partial<Parameters<typeof runGraph>[1]> = {},
): Parameters<typeof runGraph>[1] {
  return {
    graph: graphId,
    inputs: {
      input: 'same',
    },
    ...overrides,
  };
}

async function assertRunGraphMatchesDefaultSafeAndBeatsCompatible(
  project: Project,
  options: Parameters<typeof runGraph>[1],
): Promise<void> {
  const compatibleDefinitionCalls = await countCreateProcessorDefinitionCalls(project, {
    ...options,
    runtimeProfile: 'compatible',
  });
  const defaultCreateProcessorDefinitionCalls = await countCreateProcessorDefinitionCalls(project, options);
  const runGraphDefinitionCalls = await countRunGraphDefinitionCalls(project, options);

  assert.equal(runGraphDefinitionCalls, defaultCreateProcessorDefinitionCalls);
  assert.ok(runGraphDefinitionCalls < compatibleDefinitionCalls);
}

async function assertRunGraphMatchesCompatible(
  project: Project,
  options: Parameters<typeof runGraph>[1],
): Promise<void> {
  const compatibleDefinitionCalls = await countCreateProcessorDefinitionCalls(project, {
    ...options,
    runtimeProfile: 'compatible',
  });
  const runGraphDefinitionCalls = await countRunGraphDefinitionCalls(project, options);

  assert.equal(runGraphDefinitionCalls, compatibleDefinitionCalls);
}

describe('api', () => {
  it('persists Stored Value nodes across separate runGraph calls through synchronous host callbacks', async () => {
    const values = new Map<string, string>();
    const storedValueStore = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value as string),
    };

    await runGraph(makeStoredValueProject('set'), { inputs: { input: 'persisted' }, storedValueStore });
    const outputs = await runGraph(makeStoredValueProject('get'), { storedValueStore });
    assert.deepEqual(outputs.result, { type: 'string', value: 'persisted' });
  });

  it('supports asynchronous stores and gives reused processors a fresh per-run read cache', async () => {
    let reads = 0;
    const processor = createProcessor(makeStoredValueProject('get'), {
      storedValueStore: {
        async get() {
          reads += 1;
          return 'persisted';
        },
        async set() {},
      },
    });

    assert.deepEqual((await processor.run()).result, { type: 'string', value: 'persisted' });
    assert.deepEqual((await processor.run()).result, { type: 'string', value: 'persisted' });
    assert.equal(reads, 2);
  });
  it('can stream processor events', async () => {
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
    });

    void processor.run();

    const eventNames: string[] = [];
    for await (const event of processor.getEvents({ done: true, nodeStart: true, nodeFinish: true })) {
      eventNames.push(event.type);
    }

    // 3 nodes start and finish + done
    assert.deepEqual(eventNames, [
      'nodeStart',
      'nodeFinish',
      'nodeStart',
      'nodeFinish',
      'nodeStart',
      'nodeFinish',
      'done',
    ]);
  });

  it('streams node finish duration when timing capture is enabled', async () => {
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      captureNodeTimings: true,
    });

    void processor.run();

    let sawDuration = false;
    for await (const event of processor.getEvents({ nodeFinish: true })) {
      assert.equal(event.type, 'nodeFinish');
      if (event.durationMs !== undefined) {
        assert.equal(typeof event.durationMs, 'number');
        assert.ok(event.durationMs >= 0);
        sawDuration = true;
      }
    }
    assert.equal(sawDuration, true);
  });

  it('can easily filter for a node', async () => {
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
    });

    void processor.run();

    for await (const event of processor.getEvents({ nodeStart: ['Passthrough'] })) {
      assert.equal(event.type, 'nodeStart');
    }
  });

  it('Can get an event stream for a processor', async () => {
    const processor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
    });

    void processor.run();

    const reader = processor
      .getSSEStream({
        nodeFinish: true,
      })
      .getReader();

    const decoder = new TextDecoder();

    // Kind of a mess but whatev
    const eventNames: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const data = decoder.decode(value);

      const event = /event: (?<event>.*)/.exec(data)!.groups!.event!;
      eventNames.push(event);
    }

    assert.deepEqual(eventNames, ['nodeFinish', 'nodeFinish', 'nodeFinish']);
  });

  it('passes remote debugger request ids through attach', async () => {
    let attachedRequestId: string | undefined;

    const remoteDebugger = {
      on: () => undefined,
      off: () => undefined,
      webSocketServer: {} as never,
      broadcast: () => undefined,
      attach: (_processor: unknown, requestId?: string) => {
        attachedRequestId = requestId;
      },
      detach: () => undefined,
    };

    createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger,
      remoteDebuggerRequestId: 'request-123',
    });

    assert.equal(attachedRequestId, 'request-123');
  });

  it('detaches the remote debugger when an unstarted processor is aborted or disposed', async () => {
    for (const release of ['abort', 'dispose'] as const) {
      const abortController = new AbortController();
      let attachCount = 0;
      let detachCount = 0;
      const remoteDebugger = {
        on: () => undefined,
        off: () => undefined,
        webSocketServer: {} as never,
        broadcast: () => undefined,
        attach: () => {
          attachCount += 1;
        },
        detach: () => {
          detachCount += 1;
        },
      };
      const processor = createProcessor(await loadTestGraphs(), {
        abortSignal: abortController.signal,
        graph: 'Passthrough',
        inputs: { input: 'input value' },
        remoteDebugger,
      });

      if (release === 'abort') abortController.abort();
      else processor.dispose();

      assert.equal(attachCount, 1);
      assert.equal(detachCount, 1);
      processor.dispose();
      assert.equal(detachCount, 1);
      await assert.rejects(() => processor.run(), /disposed/);
    }
  });

  it('does not detach a remote debugger when a concurrent run is rejected', async () => {
    let releaseRun: (() => void) | undefined;
    let markRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolveStarted) => {
      markRunStarted = resolveStarted;
    });
    const releaseRunPromise = new Promise<void>((resolveRelease) => {
      releaseRun = resolveRelease;
    });
    let attachCount = 0;
    let detachCount = 0;

    const remoteDebugger = {
      on: () => undefined,
      off: () => undefined,
      webSocketServer: {} as never,
      broadcast: () => undefined,
      attach: () => {
        attachCount += 1;
      },
      detach: () => {
        detachCount += 1;
      },
    };
    const customCodeRunner: CodeRunner = {
      async runCode() {
        markRunStarted?.();
        await releaseRunPromise;
        return {
          output1: {
            type: 'string',
            value: 'done',
          },
        };
      },
    };
    const processor = createProcessor(makeCodeProject(`return { output1: { type: 'string', value: 'done' } };`), {
      graph: 'code-graph',
      codeRunner: customCodeRunner,
      remoteDebugger,
    });

    const firstRun = processor.run();
    await runStarted;
    await assert.rejects(() => processor.run(), /Cannot process graph while already processing/);

    assert.equal(attachCount, 1);
    assert.equal(detachCount, 0);

    releaseRun?.();
    await firstRun;

    assert.equal(detachCount, 1);
  });

  it('keeps the default programmatic Code runner behavior', async () => {
    let codeOutput: Outputs | undefined;
    const processor = createProcessor(
      makeCodeProject(`return { output1: { type: 'string', value: process.release.name } };`),
      {
        graph: 'code-graph',
        onNodeFinish: ({ outputs }) => {
          codeOutput = outputs;
        },
      },
    );

    await processor.run();

    assert.deepEqual(codeOutput?.['output1' as PortId], {
      type: 'string',
      value: 'node',
    });
  });

  it('keeps custom programmatic Code runners opt-in and unchanged', async () => {
    let runCount = 0;
    const customCodeRunner: CodeRunner = {
      async runCode() {
        runCount += 1;
        return {
          output1: {
            type: 'string',
            value: 'custom runner',
          },
        };
      },
    };
    let codeOutput: Outputs | undefined;

    const processor = createProcessor(
      makeCodeProject(`throw new Error('the custom runner should replace this code');`),
      {
        codeRunner: customCodeRunner,
        graph: 'code-graph',
        onNodeFinish: ({ outputs }) => {
          codeOutput = outputs;
        },
      },
    );

    await processor.run();

    assert.equal(runCount, 1);
    assert.deepEqual(codeOutput?.['output1' as PortId], {
      type: 'string',
      value: 'custom runner',
    });
  });

  it('uses default createProcessor subprocessor planning only inside each run', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const countingRegistry = createCountingRegistry();
    const processor = createProcessor(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
      registry: countingRegistry.registry,
    });

    await processor.run();
    assert.equal(countingRegistry.getDefinitionCalls(), 18);

    await processor.run();
    assert.equal(countingRegistry.getDefinitionCalls(), 36);
  });

  it('keeps simple runGraph planning on the compatible path', async () => {
    const fixture = makeTextChainProject(3);

    await assertRunGraphMatchesCompatible(fixture.project, makeStandardRunOptions(fixture.graphId));
  });

  it('uses default-safe runGraph planning for repeated subgraphs', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);

    await assertRunGraphMatchesDefaultSafeAndBeatsCompatible(fixture.project, makeStandardRunOptions(fixture.graphId));
  });

  it('keeps observable repeated subgraph runGraph planning on the default-safe path', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);

    await assertRunGraphMatchesDefaultSafeAndBeatsCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        onNodeFinish: () => undefined,
      }),
    );
  });

  it('keeps abortable repeated subgraph runGraph planning on the default-safe path', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const abortController = new AbortController();

    await assertRunGraphMatchesDefaultSafeAndBeatsCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        abortSignal: abortController.signal,
      }),
    );
  });

  it('keeps single static subgraph runGraph planning on the compatible path', async () => {
    const fixture = makeSubgraphChainProject(1);

    await assertRunGraphMatchesCompatible(fixture.project, makeStandardRunOptions(fixture.graphId));
  });

  it('keeps nested static subgraph runGraph planning on the compatible path', async () => {
    const fixture = makeNestedSubgraphProject(3);

    await assertRunGraphMatchesCompatible(fixture.project, makeStandardRunOptions(fixture.graphId));
  });

  it('uses default-safe runGraph planning for repeated Call Graph nodes', async () => {
    const fixture = makeCallGraphFanInProject(3);

    await assertRunGraphMatchesDefaultSafeAndBeatsCompatible(fixture.project, makeStandardRunOptions(fixture.graphId));
  });

  it('uses default-safe runGraph planning for repeated referenced graph aliases', async () => {
    const fixture = makeReferencedGraphAliasFanInProject(3);

    await assertRunGraphMatchesDefaultSafeAndBeatsCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        projectReferenceLoader: fixture.projectReferenceLoader,
      }),
    );
  });

  it('keeps single static referenced graph alias runGraph planning on the compatible path', async () => {
    const fixture = makeReferencedGraphAliasFanInProject(1);

    await assertRunGraphMatchesCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        projectReferenceLoader: fixture.projectReferenceLoader,
      }),
    );
  });

  it('keeps repeated subgraph runGraph planning stable when the target graph is selected by name', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const idSelectedDefinitionCalls = await countRunGraphDefinitionCalls(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
    });
    const nameSelectedDefinitionCalls = await countRunGraphDefinitionCalls(fixture.project, {
      graph: 'Runtime Speed Main',
      inputs: {
        input: 'same',
      },
    });

    assert.equal(nameSelectedDefinitionCalls, idSelectedDefinitionCalls);
  });

  it('does not expose runtimeProfile through runGraph options', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const omittedProfileDefinitionCalls = await countRunGraphDefinitionCalls(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
    });
    const untypedProfileDefinitionCalls = await countRunGraphDefinitionCalls(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
      runtimeProfile: 'compatible',
    });

    assert.equal(untypedProfileDefinitionCalls, omittedProfileDefinitionCalls);
  });

  it('honors custom runGraph Code runners without replacing them', async () => {
    let runCount = 0;
    const customCodeRunner: CodeRunner = {
      async runCode() {
        runCount += 1;
        return {
          output1: {
            type: 'string',
            value: 'custom runner',
          },
        };
      },
    };
    let codeOutput: Outputs | undefined;

    await runGraph(makeCodeProject(`throw new Error('the custom runner should replace this code');`), {
      codeRunner: customCodeRunner,
      graph: 'code-graph',
      onNodeFinish: ({ outputs }) => {
        codeOutput = outputs;
      },
    });

    assert.equal(runCount, 1);
    assert.deepEqual(codeOutput?.['output1' as PortId], {
      type: 'string',
      value: 'custom runner',
    });
  });

  it('keeps remote-debugger createProcessor runs on the compatible planning path', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const countingRegistry = createCountingRegistry();
    const remoteDebugger = {
      on: () => undefined,
      off: () => undefined,
      webSocketServer: {} as never,
      broadcast: () => undefined,
      attach: () => undefined,
      detach: () => undefined,
    };
    const processor = createProcessor(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
      registry: countingRegistry.registry,
      remoteDebugger,
      runtimeProfile: 'removed-profile' as never,
    });

    await processor.run();

    assert.equal(countingRegistry.getDefinitionCalls(), 30);
  });

  it('keeps remote-debugger runGraph runs on the compatible planning path', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const remoteDebugger = {
      on: () => undefined,
      off: () => undefined,
      webSocketServer: {} as never,
      broadcast: () => undefined,
      attach: () => undefined,
      detach: () => undefined,
    };

    await assertRunGraphMatchesCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        remoteDebugger,
      }),
    );
  });

  it('keeps trace-sensitive runGraph runs on the compatible planning path', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);

    await assertRunGraphMatchesCompatible(
      fixture.project,
      makeStandardRunOptions(fixture.graphId, {
        includeTrace: true,
      }),
    );
  });

  it('captures node durations for remote-debugger processors unless explicitly disabled', async () => {
    const remoteDebugger = {
      on: () => undefined,
      off: () => undefined,
      webSocketServer: {} as never,
      broadcast: () => undefined,
      attach: () => undefined,
      detach: () => undefined,
    };

    const timedProcessor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger,
    });
    let timedFinishDuration: number | undefined;
    timedProcessor.processor.on('nodeFinish', (event) => {
      if (event.processId !== 'preload') {
        timedFinishDuration ??= event.durationMs;
      }
    });
    await timedProcessor.run();
    assert.equal(typeof timedFinishDuration, 'number');

    const untimedProcessor = createProcessor(await loadTestGraphs(), {
      graph: 'Passthrough',
      inputs: {
        input: 'input value',
      },
      remoteDebugger,
      captureNodeTimings: false,
    });
    let untimedFinish: unknown;
    untimedProcessor.processor.on('nodeFinish', (event) => {
      if (event.processId !== 'preload') {
        untimedFinish = event;
      }
    });
    await untimedProcessor.run();
    assert.equal(Object.prototype.hasOwnProperty.call(untimedFinish!, 'durationMs'), false);
  });

  it('keeps default createProcessor runs recordable through processor events', async () => {
    const fixture = makeRepeatedSubgraphFanInProject(3);
    const processor = createProcessor(fixture.project, {
      graph: fixture.graphId,
      inputs: {
        input: 'same',
      },
    });
    const recorder = new ExecutionRecorder();
    recorder.record(processor.processor);

    const outputs = await processor.run();
    const eventTypes = recorder.events.map((event) => event.type);

    assert.deepEqual(outputs.result, {
      type: 'string',
      value: 'samexsamexsamex',
    });
    assert.ok(eventTypes.indexOf('start') > eventTypes.indexOf('newAbortController'));
    assert.ok(eventTypes.includes('graphStart'));
    assert.ok(eventTypes.includes('nodeStart'));
    assert.ok(eventTypes.includes('nodeFinish'));
    assert.ok(eventTypes.includes('graphFinish'));
    assert.ok(eventTypes.includes('done'));
    assert.equal(eventTypes.at(-1), 'finish');
  });
});
