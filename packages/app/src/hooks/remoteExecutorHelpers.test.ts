import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  decodeDebuggerTransportSentinels,
  type ChartNode,
  type FrozenNodeOutputsByGraph,
  type GraphExecutionMetadata,
  type GraphId,
  type GraphRunId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodePrefabId,
  type PortId,
  type ProcessEventMessageMap,
  type ProcessId,
  type Project,
  type ProjectId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import {
  canPreloadEditorRunFromPlan,
  createProcessEventDispatcher,
  getDependentDataForNodeForPreload,
  getEditorRunFromPlan,
  getEditorRunToPlan,
  getFrozenNodeOptionsForExecutorTarget,
  getFrozenNodeOutputsForExecutorRunPayload,
  shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent,
} from './remoteExecutorHelpers';
import { createRunActivityNodeKey, createRunActivityJournal } from '../features/runActivity/runActivityJournal';
import { applyProcessEventToRunActivityJournal } from '../features/runActivity/runActivityProcessEvents';
import { deleteGlobalDataRef, setGlobalDataRef } from '../utils/globals/globalDataRefs';

const registry = createBuiltInRegistry();
const graphId = 'graph-1' as GraphId;

function makeTextNode(nodeId: string, text = 'value'): ChartNode {
  const node = registry.createDynamic('text');
  node.id = nodeId as NodeId;
  node.title = nodeId;
  node.data = {
    ...(node.data as Record<string, unknown>),
    text,
  };

  return node;
}

function makeStartAsyncBranchNode(nodeId: string): ChartNode {
  const node = registry.createDynamic('startBackgroundBranch');
  node.id = nodeId as NodeId;
  node.title = nodeId;
  return node;
}

function makeDataBusNode(nodeId: string): ChartNode {
  const node = registry.createDynamic('dataBus');
  node.id = nodeId as NodeId;
  node.title = nodeId;
  return node;
}

function makeLinkedNode(nodeId: string, prefabId: NodePrefabId): ChartNode {
  const node = registry.createDynamic('nodePrefabInstance');
  node.id = nodeId as NodeId;
  node.title = nodeId;
  node.data = { prefabId };
  return node;
}

function makeConnection(
  outputNodeId: string,
  inputNodeId: string,
  inputId = 'input',
  outputId = 'output',
): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    inputNodeId: inputNodeId as NodeId,
    outputId: outputId as PortId,
    inputId: inputId as PortId,
  };
}

function makeProject(graph: NodeGraph): Project {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: graph,
    },
  };
}

function makeRunFromGraph(): NodeGraph {
  return {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [
      makeTextNode('source'),
      makeTextNode('selected', '{{input}}'),
      makeTextNode('downstream', '{{main}} {{side}}'),
      makeTextNode('side'),
      makeTextNode('unrelated-source'),
      makeTextNode('unrelated-sink', '{{input}}'),
    ],
    connections: [
      makeConnection('source', 'selected'),
      makeConnection('selected', 'downstream', 'main'),
      makeConnection('side', 'downstream', 'side'),
      makeConnection('unrelated-source', 'unrelated-sink'),
    ],
  };
}

function makeDataBusRunGraph(): NodeGraph {
  return {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [
      makeTextNode('source'),
      makeDataBusNode('bus'),
      makeTextNode('selected', '{{input}}'),
      makeTextNode('downstream', '{{input}}'),
      makeTextNode('unrelated-source'),
      makeTextNode('unrelated-sink', '{{input}}'),
    ],
    connections: [
      makeConnection('source', 'bus', 'input1'),
      makeConnection('bus', 'selected', 'input', 'output1'),
      makeConnection('selected', 'downstream'),
      makeConnection('unrelated-source', 'unrelated-sink'),
    ],
  };
}

test('Run Activity observer failures do not suppress primary execution-state events', () => {
  let primaryNodeStartCount = 0;
  const previousConsoleError = console.error;
  console.error = () => undefined;

  try {
    const dispatcher = createProcessEventDispatcher({
      onRunActivityEvent: () => {
        throw new Error('projection failed');
      },
      onNodeStart: () => {
        primaryNodeStartCount += 1;
      },
    } as any);

    assert.equal(dispatcher.nodeStart({}), true);
    assert.equal(primaryNodeStartCount, 1);
  } finally {
    console.error = previousConsoleError;
  }
});

test('projects replay-shaped waiting, progress, model, profile-health, and tool events into Run Activity', () => {
  const execution: GraphExecutionMetadata = {
    graphId,
    graphRunId: 'replay-graph-run' as GraphRunId,
    rootRunId: 'replay-root-run' as RootRunId,
  };
  const node = makeTextNode('replayed-agent');
  const processId = 'replayed-agent-process' as ProcessId;
  const replayedInputProcessId = 'replayed-user-input-process' as ProcessId;
  let occurredAt = 0;
  let journal = createRunActivityJournal();
  let primaryUserInputCount = 0;
  let primaryModelCallCount = 0;
  let primaryProfileAttemptCount = 0;
  let primaryToolCallCount = 0;
  let primarySnapshotCount = 0;
  let primaryPauseCount = 0;
  let primaryResumeCount = 0;
  const projectRunActivityEvent = <K extends keyof ProcessEventMessageMap>(
    message: K,
    data: ProcessEventMessageMap[K],
  ) => {
    journal = applyProcessEventToRunActivityJournal({
      journal,
      message,
      data,
      occurredAt: ++occurredAt,
    });
  };

  const dispatcher = createProcessEventDispatcher({
    onRunActivityEvent: projectRunActivityEvent,
    onUserInput: () => {
      primaryUserInputCount += 1;
    },
    onLlmCallFinished: () => {
      primaryModelCallCount += 1;
    },
    onLlmChatOutputSnapshot: () => {
      primarySnapshotCount += 1;
    },
    onLlmProfileAttempt: () => {
      primaryProfileAttemptCount += 1;
    },
    onToolCallFinished: () => {
      primaryToolCallCount += 1;
    },
    onPause: () => {
      primaryPauseCount += 1;
    },
    onResume: () => {
      primaryResumeCount += 1;
    },
  } as any);

  assert.equal(
    dispatcher.userInput({
      node,
      processId,
      inputs: {},
      inputStrings: ['Which option?'],
      renderingType: 'markdown',
      execution,
    } satisfies ProcessEventMessageMap['userInput']),
    true,
  );
  assert.equal(
    dispatcher.userInput({
      node,
      processId: replayedInputProcessId,
      inputs: {},
      inputStrings: ['Historical choice'],
      renderingType: 'markdown',
      isReplay: true,
      execution,
    } satisfies ProcessEventMessageMap['userInput']),
    true,
  );
  assert.equal(
    dispatcher.progress({
      node,
      processId,
      progress: { percent: 50, message: 'Thinking' },
      execution,
    } satisfies ProcessEventMessageMap['progress']),
    true,
  );
  assert.equal(
    dispatcher.llmCallFinished({
      execution,
      callId: 'replayed-model-call' as never,
      nodeId: node.id,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      outcome: 'success',
      attemptIndex: 0,
      startedAt: 10,
      durationMs: 12,
      normalizedUsage: { promptTokens: 5, completionTokens: 3 },
      pricing: { status: 'unknown' },
    } satisfies ProcessEventMessageMap['llmCallFinished']),
    true,
  );
  assert.equal(
    dispatcher.llmChatOutputSnapshot({
      execution,
      entryId: 'model-round:0',
      kind: 'model-round',
      nodeId: node.id,
      outcome: 'tool-calls',
      outputs: { ['response' as never]: { type: 'string', value: 'calling tool' } },
      processId,
      roundIndex: 0,
      splitIndex: 0,
    } satisfies ProcessEventMessageMap['llmChatOutputSnapshot']),
    true,
  );
  assert.equal(
    dispatcher.llmProfileAttempt({
      execution,
      eventId: 'replayed-profile-attempt',
      roundIndex: 0,
      profileIndex: 0,
      nodeId: node.id,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      stage: 'health-gate',
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
      retryAt: 30_000,
    } satisfies ProcessEventMessageMap['llmProfileAttempt']),
    true,
  );
  assert.equal(
    dispatcher.toolCallFinished({
      execution,
      toolCallId: 'replayed-tool-call',
      toolName: 'lookup',
      sourceNodeId: node.id,
      sourceProcessId: processId,
      resultOwner: {
        nodeId: 'delegate' as NodeId,
        processId: 'delegate-process' as ProcessId,
        outputPortId: 'output' as PortId,
      },
      handlerKind: 'graph',
      handlerGraphId: graphId,
      handlerName: 'Lookup',
      outcome: 'success',
      startedAt: 25,
      durationMs: 8,
    } satisfies ProcessEventMessageMap['toolCallFinished']),
    true,
  );
  assert.equal(dispatcher.pause({ isReplay: true } satisfies ProcessEventMessageMap['pause']), true);
  assert.equal(dispatcher.resume({ isReplay: true } satisfies ProcessEventMessageMap['resume']), true);

  assert.equal(primaryUserInputCount, 1);
  assert.equal(primaryModelCallCount, 1);
  assert.equal(primarySnapshotCount, 1);
  assert.equal(primaryProfileAttemptCount, 1);
  assert.equal(primaryToolCallCount, 1);
  assert.equal(primaryPauseCount, 0);
  assert.equal(primaryResumeCount, 0);

  const invocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]!;
  assert.equal(invocation.status, 'waiting');
  assert.deepEqual(invocation.waitingForUserInput, { questionCount: 1, renderingType: 'markdown' });

  const replayedInputInvocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId: replayedInputProcessId })
    ]!;
  assert.equal(replayedInputInvocation.status, 'waiting');
  assert.deepEqual(replayedInputInvocation.waitingForUserInput, { questionCount: 1, renderingType: 'markdown' });
  assert.deepEqual(invocation.progress, { percent: 50, message: 'Thinking' });
  assert.deepEqual(
    invocation.modelCalls.map(({ sequence: _sequence, ...call }) => call),
    [
      {
        callId: 'replayed-model-call',
        nodeId: node.id,
        processId,
        provider: 'openai',
        model: 'gpt-test',
        outcome: 'success',
        attemptIndex: 0,
        startedAt: 10,
        durationMs: 12,
        usage: { promptTokens: 5, completionTokens: 3 },
        pricing: { status: 'unknown' },
      },
    ],
  );
  assert.deepEqual(
    invocation.profileAttempts?.map(({ sequence: _sequence, ...attempt }) => attempt),
    [
      {
        eventId: 'replayed-profile-attempt',
        roundIndex: 0,
        profileIndex: 0,
        nodeId: node.id,
        processId,
        provider: 'openai',
        model: 'gpt-test',
        stage: 'health-gate',
        outcome: 'skipped',
        healthState: 'open',
        healthDisposition: 'deny',
        retryAt: 30_000,
      },
    ],
  );
  assert.deepEqual(
    invocation.toolCalls.map(({ sequence: _sequence, ...call }) => call),
    [
      {
        toolCallId: 'replayed-tool-call',
        toolName: 'lookup',
        sourceNodeId: node.id,
        sourceProcessId: processId,
        resultOwner: {
          nodeId: 'delegate',
          processId: 'delegate-process',
          outputPortId: 'output',
        },
        handlerKind: 'graph',
        handlerGraphId: graphId,
        handlerName: 'Lookup',
        outcome: 'success',
        startedAt: 25,
        durationMs: 8,
      },
    ],
  );
});

test('getEditorRunFromPlan runs the selected node and downstream nodes while preloading upstream and side inputs', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'selected' as NodeId, registry);

  assert.deepEqual(plan.nodesToRun, ['selected', 'downstream']);
  assert.deepEqual(plan.preserveNodeIds, ['source', 'side', 'unrelated-source', 'unrelated-sink']);
  assert.deepEqual(plan.preloadNodeIds, ['source', 'side']);
  assert.deepEqual(plan.runToNodeIds, ['downstream']);
});

test('getEditorRunFromPlan lets source nodes run from here without requiring their own previous output', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'source' as NodeId, registry);

  assert.deepEqual(plan.nodesToRun, ['source', 'selected', 'downstream']);
  assert.deepEqual(plan.preserveNodeIds, ['side', 'unrelated-source', 'unrelated-sink']);
  assert.deepEqual(plan.preloadNodeIds, ['side']);
  assert.deepEqual(plan.runToNodeIds, ['downstream']);
});

test('getEditorRunFromPlan preloads only direct boundary inputs for a selected leaf node', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'downstream' as NodeId, registry);

  assert.deepEqual(plan.nodesToRun, ['downstream']);
  assert.deepEqual(plan.preserveNodeIds, ['source', 'selected', 'side', 'unrelated-source', 'unrelated-sink']);
  assert.deepEqual(plan.preloadNodeIds, ['selected', 'side']);
  assert.deepEqual(plan.runToNodeIds, ['downstream']);
});

test('editor partial-run plans compile Data Bus channels into ordinary dependency boundaries', () => {
  const project = makeProject(makeDataBusRunGraph());

  const providerRunFromPlan = getEditorRunFromPlan(project, graphId, 'source' as NodeId, registry);
  assert.deepEqual(providerRunFromPlan.nodesToRun, ['source', 'selected', 'downstream']);
  assert.deepEqual(providerRunFromPlan.preloadNodeIds, []);
  assert.deepEqual(providerRunFromPlan.runToNodeIds, ['downstream']);

  const runFromPlan = getEditorRunFromPlan(project, graphId, 'selected' as NodeId, registry);
  assert.deepEqual(runFromPlan.nodesToRun, ['selected', 'downstream']);
  assert.deepEqual(runFromPlan.preserveNodeIds, ['source', 'unrelated-source', 'unrelated-sink']);
  assert.deepEqual(runFromPlan.preloadNodeIds, ['source']);
  assert.deepEqual(runFromPlan.runToNodeIds, ['downstream']);

  const runToPlan = getEditorRunToPlan(project, graphId, ['selected' as NodeId], registry);
  assert.deepEqual(runToPlan.nodesToRun, ['source', 'selected']);
  assert.deepEqual(runToPlan.preserveNodeIds, []);
  assert.deepEqual(runToPlan.runToNodeIds, ['selected']);
});

test('editor partial-run plans reject Data Buses as topology-only targets', () => {
  const project = makeProject(makeDataBusRunGraph());

  assert.throws(
    () => getEditorRunFromPlan(project, graphId, 'bus' as NodeId, registry),
    /Data Bus "bus" is topology-only and cannot be used as a run-from target/,
  );
  assert.throws(
    () => getEditorRunToPlan(project, graphId, ['bus' as NodeId], registry),
    /Data Bus "bus" is topology-only and cannot be used as a run-to target/,
  );
});

test('editor partial-run plans reject Data Buses linked from the Node Library', () => {
  const prefabId = 'shared-data-bus' as NodePrefabId;
  const linkedBus = makeLinkedNode('linked-bus', prefabId);
  const graph: NodeGraph = {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [makeTextNode('source'), linkedBus, makeTextNode('receiver', '{{input}}')],
    connections: [
      makeConnection('source', linkedBus.id, 'input1'),
      makeConnection(linkedBus.id, 'receiver', 'input', 'output1'),
    ],
  };
  const project = makeProject(graph);
  project.nodePrefabs = {
    [prefabId]: {
      id: prefabId,
      sourceNode: makeDataBusNode('library-data-bus'),
    },
  };

  assert.throws(
    () => getEditorRunFromPlan(project, graphId, linkedBus.id, registry),
    /Data Bus "library-data-bus" is topology-only and cannot be used as a run-from target/,
  );
  assert.throws(
    () => getEditorRunToPlan(project, graphId, [linkedBus.id], registry),
    /Data Bus "library-data-bus" is topology-only and cannot be used as a run-to target/,
  );
});

test('getEditorRunFromPlan rejects descendants whose async trigger would otherwise be preloaded', () => {
  const source = makeTextNode('source');
  const trigger = makeStartAsyncBranchNode('async-trigger');
  const descendant = makeTextNode('async-descendant', '{{input}}');
  const graph: NodeGraph = {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [source, trigger, descendant],
    connections: [
      {
        outputNodeId: source.id,
        outputId: 'output' as PortId,
        inputNodeId: trigger.id,
        inputId: 'input1' as PortId,
      },
      {
        outputNodeId: trigger.id,
        outputId: 'output1' as PortId,
        inputNodeId: descendant.id,
        inputId: 'input' as PortId,
      },
    ],
  };

  assert.throws(
    () => getEditorRunFromPlan(makeProject(graph), graphId, descendant.id, registry),
    /inside the async branch started by async-trigger/,
  );

  const triggerPlan = getEditorRunFromPlan(makeProject(graph), graphId, trigger.id, registry);
  assert.deepEqual(triggerPlan.nodesToRun, [trigger.id, descendant.id]);
  assert.deepEqual(triggerPlan.preloadNodeIds, [source.id]);
  assert.deepEqual(triggerPlan.runToNodeIds, [descendant.id]);
});

test('getEditorRunFromPlan permits descendants of a disabled async trigger', () => {
  const trigger = makeStartAsyncBranchNode('async-trigger');
  trigger.disabled = true;
  const descendant = makeTextNode('async-descendant', '{{input}}');
  const graph: NodeGraph = {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [trigger, descendant],
    connections: [
      {
        outputNodeId: trigger.id,
        outputId: 'output1' as PortId,
        inputNodeId: descendant.id,
        inputId: 'input' as PortId,
      },
    ],
  };

  const plan = getEditorRunFromPlan(makeProject(graph), graphId, descendant.id, registry);
  assert.deepEqual(plan.nodesToRun, [descendant.id]);
  assert.deepEqual(plan.preloadNodeIds, []);
});

test('getEditorRunFromPlan rejects a nested async trigger whose outer trigger would be preloaded', () => {
  const source = makeTextNode('source');
  const outerTrigger = makeStartAsyncBranchNode('outer-trigger');
  const innerTrigger = makeStartAsyncBranchNode('inner-trigger');
  const descendant = makeTextNode('async-descendant', '{{input}}');
  const graph: NodeGraph = {
    metadata: { id: graphId, name: 'Graph' },
    nodes: [source, outerTrigger, innerTrigger, descendant],
    connections: [
      {
        outputNodeId: source.id,
        outputId: 'output' as PortId,
        inputNodeId: outerTrigger.id,
        inputId: 'input1' as PortId,
      },
      {
        outputNodeId: outerTrigger.id,
        outputId: 'output1' as PortId,
        inputNodeId: innerTrigger.id,
        inputId: 'input1' as PortId,
      },
      {
        outputNodeId: innerTrigger.id,
        outputId: 'output1' as PortId,
        inputNodeId: descendant.id,
        inputId: 'input' as PortId,
      },
    ],
  };

  assert.throws(
    () => getEditorRunFromPlan(makeProject(graph), graphId, innerTrigger.id, registry),
    /inside the async branch started by outer-trigger/,
  );
});

test('getEditorRunToPlan preserves frozen nodes outside the run-to dependency slice', () => {
  const plan = getEditorRunToPlan(makeProject(makeRunFromGraph()), graphId, ['downstream' as NodeId], registry, {
    frozenNodeOutputs: {
      [graphId]: {
        ['source' as NodeId]: [{ ['output' as PortId]: { type: 'string', value: 'runs again' } }],
        ['unrelated-source' as NodeId]: [{ ['output' as PortId]: { type: 'string', value: 'keep me visible' } }],
        ['unrelated-sink' as NodeId]: [],
      },
    },
  });

  assert.deepEqual(plan.nodesToRun, ['source', 'selected', 'downstream', 'side']);
  assert.deepEqual(plan.preserveNodeIds, ['unrelated-source']);
  assert.deepEqual(plan.runToNodeIds, ['downstream']);
});

test('getEditorRunToPlan does not preserve unfrozen nodes outside the run-to dependency slice', () => {
  const plan = getEditorRunToPlan(makeProject(makeRunFromGraph()), graphId, ['downstream' as NodeId], registry);

  assert.deepEqual(plan.nodesToRun, ['source', 'selected', 'downstream', 'side']);
  assert.deepEqual(plan.preserveNodeIds, []);
  assert.deepEqual(plan.runToNodeIds, ['downstream']);
});

test('canPreloadEditorRunFromPlan only requires previous data for boundary preload nodes', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'selected' as NodeId, registry);

  assert.equal(
    canPreloadEditorRunFromPlan(plan, {
      source: [
        {
          processId: 'process-old' as any,
          data: {},
        },
        {
          processId: 'process-1' as any,
          data: {
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'source' },
            },
          },
        },
      ],
      side: [
        {
          processId: 'process-2' as any,
          data: {
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'side' },
            },
          },
        },
      ],
    } as any),
    true,
  );

  assert.equal(
    canPreloadEditorRunFromPlan(plan, {
      source: [
        {
          processId: 'process-1' as any,
          data: {
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'source' },
            },
          },
        },
      ],
    } as any),
    false,
  );
});

test('canPreloadEditorRunFromPlan treats absent output wrappers as unavailable preload data', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'selected' as NodeId, registry);

  assert.equal(
    canPreloadEditorRunFromPlan(plan, {
      source: [
        {
          processId: 'process-1' as any,
          data: {
            outputData: {
              output: undefined,
            },
          },
        },
      ],
      side: [
        {
          processId: 'process-2' as any,
          data: {
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'side' },
            },
          },
        },
      ],
    } as any),
    false,
  );
});

test('canPreloadEditorRunFromPlan treats frozen boundary outputs as available preload data', () => {
  const plan = getEditorRunFromPlan(makeProject(makeRunFromGraph()), graphId, 'selected' as NodeId, registry);

  assert.equal(
    canPreloadEditorRunFromPlan(
      plan,
      {
        source: [
          {
            processId: 'process-1' as any,
            data: {
              outputData: {
                output: { type: 'string', storage: 'inline', value: 'source' },
              },
            },
          },
        ],
      } as any,
      {
        graphId,
        frozenNodeOutputs: {
          [graphId]: {
            side: [
              {
                output: { type: 'string', value: 'frozen side' },
              },
            ],
          },
        } as any,
      },
    ),
    true,
  );
});

test('getDependentDataForNodeForPreload returns prior outputs for requested dependency nodes', () => {
  const preloadData = getDependentDataForNodeForPreload(['node-1' as any], {
    'node-1': [
      {
        processId: 'process-old' as any,
        data: {
          outputData: {
            output: { type: 'string', storage: 'inline', value: 'old value' },
          },
        },
      },
      {
        processId: 'process-1' as any,
        data: {},
      },
      {
        processId: 'process-latest' as any,
        data: {
          outputData: {
            output: { type: 'string', storage: 'inline', value: 'hello' },
          },
        },
      },
    ],
  } as any);

  assert.deepEqual(preloadData, {
    'node-1': {
      output: { type: 'string', value: 'hello' },
    },
  });
});

test('getDependentDataForNodeForPreload prefers frozen boundary outputs over previous run outputs', () => {
  const preloadData = getDependentDataForNodeForPreload(
    ['node-1' as NodeId],
    {
      'node-1': [
        {
          processId: 'process-latest' as any,
          data: {
            outputData: {
              output: { type: 'string', storage: 'inline', value: 'history value' },
            },
          },
        },
      ],
    } as any,
    {
      graphId,
      frozenNodeOutputs: {
        [graphId]: {
          ['node-1' as NodeId]: [
            {
              output: { type: 'string', value: 'frozen value' },
            },
          ],
        },
      } as any,
    },
  );

  assert.deepEqual(preloadData, {
    'node-1': {
      output: { type: 'string', value: 'frozen value' },
    },
  });
});

test('getFrozenNodeOptionsForExecutorTarget only enables frozen outputs for internal executors', () => {
  const frozenNodeOutputs = {
    [graphId]: {
      ['node-1' as NodeId]: [
        {
          ['output' as PortId]: { type: 'string', value: 'frozen value' },
        },
      ],
    },
  } satisfies FrozenNodeOutputsByGraph;

  assert.deepEqual(
    getFrozenNodeOptionsForExecutorTarget(frozenNodeOutputs, graphId, {
      type: 'internal-hosted',
      url: 'ws://executor.example/internal',
    }),
    { frozenNodeOutputs, graphId },
  );

  assert.equal(
    getFrozenNodeOptionsForExecutorTarget(frozenNodeOutputs, graphId, {
      type: 'external-debugger',
      url: 'ws://debugger.example/latest',
    }),
    undefined,
  );
});

test('getFrozenNodeOutputsForExecutorRunPayload includes cloned data for internal executors', () => {
  const frozenNodeOutputs = {
    [graphId]: {
      ['node-1' as NodeId]: [
        {
          output: { type: 'object', value: { nested: true } },
        },
      ],
    },
  } as any;

  const payload = getFrozenNodeOutputsForExecutorRunPayload(frozenNodeOutputs, {
    type: 'internal-hosted',
    url: 'ws://executor.example/internal',
  });

  assert.deepEqual(payload, frozenNodeOutputs);
  assert.notEqual(payload, frozenNodeOutputs);
  assert.notEqual(payload?.[graphId]?.['node-1' as NodeId]?.[0], frozenNodeOutputs[graphId]['node-1' as NodeId][0]);
});

test('getFrozenNodeOutputsForExecutorRunPayload preserves undefined through the internal executor transport shape', () => {
  const frozenNodeOutputs = {
    [graphId]: {
      ['node-1' as NodeId]: [
        {
          output: {
            type: 'object',
            value: {
              messages: [{ isCacheBreakpoint: undefined, role: 'user' }],
            },
          },
        },
      ],
    },
  } as any;

  const payload = getFrozenNodeOutputsForExecutorRunPayload(frozenNodeOutputs, {
    type: 'internal-hosted',
    url: 'ws://executor.example/internal',
  });
  const roundTripped = decodeDebuggerTransportSentinels(JSON.parse(JSON.stringify(payload)));

  assert.deepEqual(roundTripped, frozenNodeOutputs);
});

test('getFrozenNodeOutputsForExecutorRunPayload rejects non-JSON-safe data for internal executors', () => {
  const frozenNodeOutputs = {
    [graphId]: {
      ['node-1' as NodeId]: [
        {
          output: { type: 'object', value: { id: BigInt(1) } },
        },
      ],
    },
  } as any;

  assert.throws(
    () =>
      getFrozenNodeOutputsForExecutorRunPayload(frozenNodeOutputs, {
        type: 'internal-hosted',
        url: 'ws://executor.example/internal',
      }),
    /BigInt/,
  );
});

test('getFrozenNodeOutputsForExecutorRunPayload excludes data for external debuggers', () => {
  const frozenNodeOutputs = {
    [graphId]: {
      ['node-1' as NodeId]: [
        {
          output: { type: 'string', value: 'frozen' },
        },
      ],
    },
  } as any;

  assert.equal(
    getFrozenNodeOutputsForExecutorRunPayload(frozenNodeOutputs, {
      type: 'external-debugger',
      url: 'ws://debugger.example/latest',
    }),
    undefined,
  );
});

test('shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent only flushes on first accepted external run event', () => {
  const externalTarget = {
    type: 'external-debugger',
    url: 'ws://debugger.example/latest',
  } as const;
  const internalTarget = {
    type: 'internal-hosted',
    url: 'ws://executor.example/internal',
  } as const;

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'graphStart',
      shouldDispatchExecutionEvent: true,
      target: externalTarget,
    }),
    true,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: true,
      message: 'graphStart',
      shouldDispatchExecutionEvent: true,
      target: externalTarget,
    }),
    false,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'graphStart',
      shouldDispatchExecutionEvent: false,
      target: externalTarget,
    }),
    false,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'trace',
      shouldDispatchExecutionEvent: true,
      target: externalTarget,
    }),
    false,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'webAppStoragePatch',
      shouldDispatchExecutionEvent: true,
      target: externalTarget,
    }),
    false,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'nodeOutputsCleared',
      shouldDispatchExecutionEvent: true,
      target: externalTarget,
    }),
    true,
  );

  assert.equal(
    shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
      alreadyFlushed: false,
      message: 'graphStart',
      shouldDispatchExecutionEvent: true,
      target: internalTarget,
    }),
    false,
  );
});

test('getDependentDataForNodeForPreload skips newer runs with only absent output wrappers', () => {
  const preloadData = getDependentDataForNodeForPreload(['node-1' as any], {
    'node-1': [
      {
        processId: 'process-valid' as any,
        data: {
          outputData: {
            output: { type: 'string', storage: 'inline', value: 'usable' },
          },
        },
      },
      {
        processId: 'process-empty' as any,
        data: {
          outputData: {
            output: undefined,
          },
        },
      },
    ],
  } as any);

  assert.deepEqual(preloadData, {
    'node-1': {
      output: { type: 'string', value: 'usable' },
    },
  });
});

test('getDependentDataForNodeForPreload rejects runs that only have absent output wrappers', () => {
  assert.throws(
    () =>
      getDependentDataForNodeForPreload(['node-1' as NodeId], {
        'node-1': [
          {
            processId: 'process-empty' as any,
            data: {
              outputData: {
                output: undefined,
              },
            },
          },
        ],
      } as any),
    /no output data/i,
  );
});

test('getDependentDataForNodeForPreload restores ref-backed media outputs', () => {
  const nodeId = 'node-2' as NodeId;
  setGlobalDataRef('image-ref', {
    type: 'image',
    value: {
      mediaType: 'image/png',
      data: Uint8Array.from([1, 2, 3]),
    },
  });

  const preloadData = getDependentDataForNodeForPreload([nodeId], {
    [nodeId]: [
      {
        processId: 'process-2' as any,
        data: {
          outputData: {
            output: {
              type: 'image',
              storage: 'ref',
              refId: 'image-ref',
              preview: {
                kind: 'summary',
                label: 'Image (image/png)',
                totalBytes: 3,
              },
            },
          },
        },
      },
    ],
  } as any);

  assert.deepEqual(preloadData[nodeId], {
    output: {
      type: 'image',
      value: {
        mediaType: 'image/png',
        data: Uint8Array.from([1, 2, 3]),
      },
    },
  });

  deleteGlobalDataRef('image-ref');
});

test('getDependentDataForNodeForPreload restores ref-backed string outputs', () => {
  const nodeId = 'node-3' as NodeId;
  setGlobalDataRef('string-ref', {
    type: 'string',
    value: 'large output',
  });

  const preloadData = getDependentDataForNodeForPreload([nodeId], {
    [nodeId]: [
      {
        processId: 'process-3' as any,
        data: {
          outputData: {
            output: {
              type: 'string',
              storage: 'ref',
              refId: 'string-ref',
              preview: {
                kind: 'text',
                excerpt: 'large output',
                totalChars: 12,
                lineCount: 1,
              },
            },
          },
        },
      },
    ],
  } as any);

  assert.deepEqual(preloadData[nodeId], {
    output: {
      type: 'string',
      value: 'large output',
    },
  });

  deleteGlobalDataRef('string-ref');
});

test('getDependentDataForNodeForPreload throws clearly for missing ref-backed values', () => {
  assert.throws(
    () =>
      getDependentDataForNodeForPreload(['node-4' as NodeId], {
        'node-4': [
          {
            processId: 'process-4' as any,
            data: {
              outputData: {
                output: {
                  type: 'string',
                  storage: 'ref',
                  refId: 'missing-ref',
                  preview: {
                    kind: 'text',
                    excerpt: 'preview',
                    totalChars: 7,
                    lineCount: 1,
                  },
                },
              },
            },
          },
        ],
      } as any),
    /cleared from execution memory/i,
  );
});
