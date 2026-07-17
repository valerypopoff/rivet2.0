import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  decodeDebuggerTransportSentinels,
  type ChartNode,
  type FrozenNodeOutputsByGraph,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  canPreloadEditorRunFromPlan,
  getDependentDataForNodeForPreload,
  getEditorRunFromPlan,
  getEditorRunToPlan,
  getFrozenNodeOptionsForExecutorTarget,
  getFrozenNodeOutputsForExecutorRunPayload,
  selectTestSuitesToRun,
  shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent,
} from './remoteExecutorHelpers';
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

function makeConnection(outputNodeId: string, inputNodeId: string, inputId = 'input'): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    inputNodeId: inputNodeId as NodeId,
    outputId: 'output' as PortId,
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

test('selectTestSuitesToRun filters suites and cases narrowly', () => {
  const selected = selectTestSuitesToRun(
    [
      { id: 'suite-1', testCases: [{ id: 'case-1' }, { id: 'case-2' }] },
      { id: 'suite-2', testCases: [{ id: 'case-3' }] },
    ],
    { testSuiteIds: ['suite-1'], testCaseIds: ['case-2'] },
  );

  assert.deepEqual(selected, [{ id: 'suite-1', testCases: [{ id: 'case-2' }] }]);
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
