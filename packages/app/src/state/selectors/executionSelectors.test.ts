import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphId, GraphRunId, NodeId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import type { PageValue, ProcessDataForNode } from '../dataFlow.js';
import {
  canRunGraphFromEditor,
  filterProcessDataForSelection,
  getActionBarExecutionState,
  getExecutorProductState,
  getGraphRunsForView,
  getNodeExecutionClassFlags,
  getSelectedGraphRunId,
  getSelectedProcessData,
  getSelectedProcessPageIndex,
  getSelectedProcessRun,
  resolveCanvasExecutionProcessPage,
  shouldUseRemoteExecutor,
} from './executionSelectors.js';

const readyCapabilities = {
  canBridgeDatasets: false,
  canRecordSocket: true,
  canSendAbort: true,
  canSendPause: true,
  canSendResume: true,
  canSendRun: true,
  canUploadProject: false,
};

const inactiveCapabilities = {
  canBridgeDatasets: false,
  canRecordSocket: false,
  canSendAbort: false,
  canSendPause: false,
  canSendResume: false,
  canSendRun: false,
  canUploadProject: false,
};

describe('executionSelectors', () => {
  test('selected process helpers resolve latest and indexed pages', () => {
    const processData = [
      { processId: 'p-1', data: { status: { type: 'ok' } } },
      { processId: 'p-2', data: { status: { type: 'running' } } },
    ] as ProcessDataForNode[];

    assert.equal(getSelectedProcessData(processData, 'latest')?.processId, 'p-2');
    assert.equal(getSelectedProcessData(processData, 0)?.processId, 'p-1');
    assert.equal(getSelectedProcessData(processData, 50)?.processId, 'p-2');
    assert.equal(getSelectedProcessRun(processData, 'latest')?.status?.type, 'running');
    assert.equal(getSelectedProcessPageIndex(processData, 'latest'), 1);
    assert.equal(getSelectedProcessPageIndex(processData, 50), 1);
  });

  test('canvas execution chrome treats missing process pages as latest without overriding explicit pages', () => {
    const processData = [
      { processId: 'p-old', graphRunId: 'graph-run-a' as GraphRunId, data: { status: { type: 'ok' } } },
      { processId: 'p-running', graphRunId: 'graph-run-b' as GraphRunId, data: { status: { type: 'running' } } },
    ] as ProcessDataForNode[];
    const graphRuns = [
      { graphRunId: 'graph-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
      { graphRunId: 'graph-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
    ];
    const select = (selectedPage?: PageValue, options?: Parameters<typeof getSelectedProcessData>[2]) =>
      getSelectedProcessData(processData, resolveCanvasExecutionProcessPage(selectedPage), options)?.processId;

    assert.equal(select(undefined), 'p-running');
    assert.equal(select(0), 'p-old');
    assert.equal(select('latest'), 'p-running');
    assert.equal(
      select(undefined, {
        graphRuns,
        selectedGraphRun: 'graph-run-a' as GraphRunId,
      }),
      'p-old',
    );
  });

  test('graph-run-aware selection filters node history by selected graph run', () => {
    const processData = [
      { processId: 'p-root-a', graphRunId: 'graph-run-a' as GraphRunId, data: { status: { type: 'ok' } } },
      { processId: 'p-root-b', graphRunId: 'graph-run-b' as GraphRunId, data: { status: { type: 'running' } } },
      { processId: 'p-other', graphRunId: 'graph-run-c' as GraphRunId, data: { status: { type: 'error', error: 'boom' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'graph-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
      { graphRunId: 'graph-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
    ];

    const filtered = filterProcessDataForSelection({
      graphRuns,
      processData,
      selectedGraphRun: 'graph-run-a' as GraphRunId,
    });

    assert.deepEqual(filtered?.map((process) => process.processId), ['p-root-a']);
    assert.equal(
      getSelectedProcessData(processData, 'latest', {
        graphRuns,
        selectedGraphRun: 'graph-run-b' as GraphRunId,
      })?.processId,
      'p-root-b',
    );
  });

  test('graph-run-aware selection clamps stale node page indexes after filtering', () => {
    const processData = [
      { processId: 'p-sub-a', graphRunId: 'sub-run-a' as GraphRunId, data: { status: { type: 'ok' } } },
      { processId: 'p-sub-b', graphRunId: 'sub-run-b' as GraphRunId, data: { status: { type: 'ok' } } },
      { processId: 'p-sub-c', graphRunId: 'sub-run-c' as GraphRunId, data: { status: { type: 'ok' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-c' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
    ];

    assert.equal(
      getSelectedProcessData(processData, 50, {
        graphRuns,
        selectedGraphRun: 'sub-run-c' as GraphRunId,
      })?.processId,
      'p-sub-c',
    );
  });

  test('graph run selection falls back to latest run when selection is unset or latest', () => {
    const graphRuns = [
      { graphRunId: 'graph-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
      { graphRunId: 'graph-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
    ];

    assert.equal(getSelectedGraphRunId(graphRuns, undefined), 'graph-run-b');
    assert.equal(getSelectedGraphRunId(graphRuns, 'latest'), 'graph-run-b');
    assert.equal(getSelectedGraphRunId(graphRuns, 'graph-run-a' as GraphRunId), 'graph-run-a');
  });

  test('graph-run-aware selection falls back to the latest run when the selected graph run is stale', () => {
    const processData = [
      { processId: 'p-root-a', graphRunId: 'graph-run-a' as GraphRunId, data: { status: { type: 'ok' } } },
      { processId: 'p-root-b', graphRunId: 'graph-run-b' as GraphRunId, data: { status: { type: 'running' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'graph-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
      { graphRunId: 'graph-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'g-1' as GraphId },
    ];

    assert.deepEqual(
      filterProcessDataForSelection({
        graphRuns,
        processData,
        selectedGraphRun: 'missing-graph-run' as GraphRunId,
      })?.map((process) => process.processId),
      ['p-root-b'],
    );
  });

  test('node execution status helpers derive canonical class flags', () => {
    assert.deepEqual(getNodeExecutionClassFlags({ status: { type: 'error', error: 'boom' } }), {
      success: false,
      error: true,
      interrupted: false,
      running: false,
      'not-ran': false,
    });
    assert.deepEqual(getNodeExecutionClassFlags({ status: { type: 'notRan', reason: 'skip' } }), {
      success: false,
      error: false,
      interrupted: false,
      running: false,
      'not-ran': true,
    });
  });

  test('action bar execution state centralizes run/debugger visibility decisions', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'reconnecting',
      started: false,
      reconnecting: true,
      socket: null,
      url: 'ws://localhost:21888',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: { type: 'external-debugger', url: 'ws://localhost:21888' },
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        selectedExecutor: 'nodejs',
        session,
      }),
      {
        canRun: false,
        executorLoading: false,
        executorProductState: { type: 'external-debugger-connecting' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: true,
        remoteDebuggerBanner: {
          isPending: true,
          label: 'Remote Debugger (Connecting...)',
        },
        runButtonLoading: false,
        showRunButton: false,
        showRemoteDebuggerBanner: true,
      },
    );
  });

  test('action bar shows ready external debugger as a stop banner without run controls', () => {
    const session = {
      capabilities: readyCapabilities,
      status: 'ready',
      started: true,
      reconnecting: false,
      socket: null,
      url: 'ws://localhost:21888',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: { type: 'external-debugger', url: 'ws://localhost:21888' },
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        selectedExecutor: 'browser',
        session,
      }),
      {
        canRun: true,
        executorLoading: false,
        executorProductState: { type: 'external-debugger-ready' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: true,
        remoteDebuggerBanner: {
          isPending: false,
          label: 'Stop Remote Debugger',
        },
        runButtonLoading: false,
        showRunButton: false,
        showRemoteDebuggerBanner: true,
      },
    );
  });

  test('action bar keeps node executor run controls visible while internal sidecar reconnects', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'reconnecting',
      started: true,
      reconnecting: true,
      socket: null,
      url: 'ws://127.0.0.1:21889/internal',
      remoteUploadAllowed: true,
      isInternalExecutor: true,
      target: { type: 'internal-desktop', url: 'ws://127.0.0.1:21889/internal' },
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        selectedExecutor: 'nodejs',
        session,
      }),
      {
        canRun: false,
        executorLoading: true,
        executorProductState: { type: 'internal-node-reconnecting' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: false,
        remoteDebuggerBanner: null,
        runButtonLoading: true,
        showRunButton: true,
        showRemoteDebuggerBanner: false,
      },
    );
  });

  test('action bar shows node executor startup as loading before the internal socket connects', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'idle',
      started: false,
      reconnecting: false,
      socket: null,
      url: '',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: null,
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        selectedExecutor: 'nodejs',
        session,
      }),
      {
        canRun: false,
        executorLoading: true,
        executorProductState: { type: 'internal-node-starting' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: false,
        remoteDebuggerBanner: null,
        runButtonLoading: true,
        showRunButton: true,
        showRemoteDebuggerBanner: false,
      },
    );
  });

  test('action bar lets recording playback run without waiting for the node executor', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'idle',
      started: false,
      reconnecting: false,
      socket: null,
      url: '',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: null,
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        hasLoadedRecording: true,
        selectedExecutor: 'nodejs',
        session,
      }),
      {
        canRun: true,
        executorLoading: false,
        executorProductState: { type: 'recording-playback-ready' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: false,
        remoteDebuggerBanner: null,
        runButtonLoading: false,
        showRunButton: true,
        showRemoteDebuggerBanner: false,
      },
    );
  });

  test('action bar shows recording playback startup as a loading run button', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'idle',
      started: false,
      reconnecting: false,
      socket: null,
      url: '',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: null,
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: false,
        hasLoadedRecording: true,
        recordingPlaybackStarting: true,
        selectedExecutor: 'browser',
        session,
      }),
      {
        canRun: false,
        executorLoading: false,
        executorProductState: { type: 'recording-playback-ready' },
        graphPaused: false,
        graphRunning: false,
        isActuallyRemoteDebugging: false,
        remoteDebuggerBanner: null,
        runButtonLoading: true,
        showRunButton: true,
        showRemoteDebuggerBanner: false,
      },
    );
  });

  test('action bar ignores recording playback startup once the graph is running', () => {
    const session = {
      capabilities: inactiveCapabilities,
      status: 'idle',
      started: false,
      reconnecting: false,
      socket: null,
      url: '',
      remoteUploadAllowed: false,
      isInternalExecutor: false,
      target: null,
    } as const;

    assert.deepEqual(
      getActionBarExecutionState({
        graphPaused: false,
        graphRunning: true,
        hasLoadedRecording: true,
        recordingPlaybackStarting: true,
        selectedExecutor: 'browser',
        session,
      }),
      {
        canRun: true,
        executorLoading: false,
        executorProductState: { type: 'recording-playback-ready' },
        graphPaused: false,
        graphRunning: true,
        isActuallyRemoteDebugging: false,
        remoteDebuggerBanner: null,
        runButtonLoading: false,
        showRunButton: true,
        showRemoteDebuggerBanner: false,
      },
    );
  });

  test('getGraphRunsForView finds subgraph runs when navigating via root context', () => {
    const graphRunHistoryByView = {
      'root:main-graph': [
        { graphRunId: 'root-run' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'main-graph' as GraphId, startedAt: 1 },
      ],
      'subgraph:main-graph:node-1:sub-graph': [
        { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId, executor: { parentGraphId: 'main-graph' as GraphId, nodeId: 'node-1' as NodeId, processId: 'p-1' as ProcessId }, startedAt: 2 },
        { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId, executor: { parentGraphId: 'main-graph' as GraphId, nodeId: 'node-1' as NodeId, processId: 'p-1' as ProcessId }, startedAt: 3 },
      ],
    };

    // Navigating to the subgraph via sidebar creates a root context
    const rootViewOfSubgraph = { key: 'root:sub-graph', graphId: 'sub-graph' as GraphId };
    const runs = getGraphRunsForView({ currentGraphView: rootViewOfSubgraph, graphRunHistoryByView });

    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.graphRunId, 'sub-run-a');
    assert.equal(runs[1]!.graphRunId, 'sub-run-b');
  });

  test('getGraphRunsForView keeps nested subgraph caller contexts separate', () => {
    const graphRunHistoryByView = {
      'subgraph:main-graph:shared-node:sub-graph': [
        {
          executor: {
            nodeId: 'shared-node' as NodeId,
            parentGraphId: 'main-graph' as GraphId,
            processId: 'main-process' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'main-sub-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
      ],
      'subgraph:parent-subgraph:shared-node:sub-graph': [
        {
          executor: {
            nodeId: 'shared-node' as NodeId,
            parentGraphId: 'parent-subgraph' as GraphId,
            processId: 'nested-process' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'nested-sub-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 2,
        },
        {
          executor: {
            nodeId: 'shared-node' as NodeId,
            parentGraphId: 'parent-subgraph' as GraphId,
            processId: 'nested-process-2' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'nested-sub-run-2' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 3,
        },
      ],
    };

    const nestedView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:parent-subgraph:shared-node:sub-graph',
      parent: {
        parentGraphId: 'parent-subgraph' as GraphId,
        parentNodeId: 'shared-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: nestedView, graphRunHistoryByView });

    assert.deepEqual(runs.map((run) => run.graphRunId), ['nested-sub-run', 'nested-sub-run-2']);
  });

  test('getGraphRunsForView trusts direct subgraph view key matches before broader fallback', () => {
    const graphRunHistoryByView = {
      'subgraph:main-graph:subgraph-node:sub-graph': [
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'direct-key-run-a' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 2,
        },
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'direct-key-run-b' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 3,
        },
      ],
      'subgraph:other-graph:other-node:sub-graph': [
        {
          executor: {
            nodeId: 'other-node' as NodeId,
            parentGraphId: 'other-graph' as GraphId,
            processId: 'other-process' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'fallback-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
      ],
    };

    const subgraphView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:main-graph:subgraph-node:sub-graph',
      parent: {
        parentGraphId: 'main-graph' as GraphId,
        parentNodeId: 'subgraph-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: subgraphView, graphRunHistoryByView });

    assert.deepEqual(
      runs.map((run) => run.graphRunId),
      ['direct-key-run-a', 'direct-key-run-b'],
    );
  });

  test('getGraphRunsForView falls back to graph id matches for subgraph contexts without executor metadata', () => {
    const graphRunHistoryByView = {
      'root:sub-graph': [
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'sub-run-a' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'sub-run-b' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 2,
        },
      ],
    };

    const subgraphView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:main-graph:subgraph-node:sub-graph',
      parent: {
        parentGraphId: 'main-graph' as GraphId,
        parentNodeId: 'subgraph-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: subgraphView, graphRunHistoryByView });

    assert.deepEqual(
      runs.map((run) => run.graphRunId),
      ['sub-run-a', 'sub-run-b'],
    );
  });

  test('getGraphRunsForView prefers executor-matched subgraph runs over graph id fallback runs', () => {
    const graphRunHistoryByView = {
      'root:sub-graph': [
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'metadata-missing-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
      ],
      'subgraph:other-graph:other-node:sub-graph': [
        {
          executor: {
            nodeId: 'other-node' as NodeId,
            parentGraphId: 'other-graph' as GraphId,
            processId: 'process-other' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'other-caller-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 3,
        },
      ],
      'subgraph:main-graph:subgraph-node:sub-graph': [
        {
          executor: {
            nodeId: 'subgraph-node' as NodeId,
            parentGraphId: 'main-graph' as GraphId,
            processId: 'process-a' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'matched-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 2,
        },
        {
          executor: {
            nodeId: 'subgraph-node' as NodeId,
            parentGraphId: 'main-graph' as GraphId,
            processId: 'process-b' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'matched-run-b' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 4,
        },
      ],
    };

    const subgraphView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:main-graph:subgraph-node:sub-graph',
      parent: {
        parentGraphId: 'main-graph' as GraphId,
        parentNodeId: 'subgraph-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: subgraphView, graphRunHistoryByView });

    assert.deepEqual(runs.map((run) => run.graphRunId), ['matched-run', 'matched-run-b']);
  });

  test('getGraphRunsForView does not let a single exact subgraph match hide a broader graph history', () => {
    const graphRunHistoryByView = {
      'root:sub-graph': [
        {
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'metadata-missing-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
      ],
      'subgraph:main-graph:subgraph-node:sub-graph': [
        {
          executor: {
            nodeId: 'subgraph-node' as NodeId,
            parentGraphId: 'main-graph' as GraphId,
            processId: 'process-a' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'matched-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 2,
        },
      ],
      'subgraph:other-graph:other-node:sub-graph': [
        {
          executor: {
            nodeId: 'other-node' as NodeId,
            parentGraphId: 'other-graph' as GraphId,
            processId: 'process-other' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'other-caller-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 3,
        },
      ],
    };

    const subgraphView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:main-graph:subgraph-node:sub-graph',
      parent: {
        parentGraphId: 'main-graph' as GraphId,
        parentNodeId: 'subgraph-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: subgraphView, graphRunHistoryByView });

    assert.deepEqual(runs.map((run) => run.graphRunId), [
      'metadata-missing-run',
      'matched-run',
      'other-caller-run',
    ]);
  });

  test('getGraphRunsForView falls back to graph id matches when explicit subgraph metadata has no exact match', () => {
    const graphRunHistoryByView = {
      'subgraph:other-graph:other-node:sub-graph': [
        {
          executor: {
            nodeId: 'other-node' as NodeId,
            parentGraphId: 'other-graph' as GraphId,
            processId: 'process-a' as ProcessId,
          },
          graphId: 'sub-graph' as GraphId,
          graphRunId: 'other-caller-run' as GraphRunId,
          rootRunId: 'root-1' as RootRunId,
          startedAt: 1,
        },
      ],
    };

    const subgraphView = {
      graphId: 'sub-graph' as GraphId,
      key: 'subgraph:main-graph:subgraph-node:sub-graph',
      parent: {
        parentGraphId: 'main-graph' as GraphId,
        parentNodeId: 'subgraph-node' as NodeId,
      },
    };

    const runs = getGraphRunsForView({ currentGraphView: subgraphView, graphRunHistoryByView });

    assert.deepEqual(runs.map((run) => run.graphRunId), ['other-caller-run']);
  });

  test('getGraphRunsForView returns direct matches for root graphs with matching data', () => {
    const graphRunHistoryByView = {
      'root:main-graph': [
        { graphRunId: 'root-run' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'main-graph' as GraphId, startedAt: 1 },
      ],
    };

    const rootView = { key: 'root:main-graph', graphId: 'main-graph' as GraphId };
    const runs = getGraphRunsForView({ currentGraphView: rootView, graphRunHistoryByView });

    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.graphRunId, 'root-run');
  });

  test('filterProcessDataForSelection filters by graphRunId only', () => {
    const processData = [
      { processId: 'p-sub-a', graphRunId: 'sub-run-a' as GraphRunId, graphId: 'sub-graph' as GraphId, data: { status: { type: 'ok' } } },
      { processId: 'p-sub-b', graphRunId: 'sub-run-b' as GraphRunId, graphId: 'sub-graph' as GraphId, data: { status: { type: 'ok' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
    ];

    const filtered = filterProcessDataForSelection({
      graphRuns,
      processData,
      selectedGraphRun: 'sub-run-a' as GraphRunId,
    });

    assert.deepEqual(filtered?.map((p) => p.processId), ['p-sub-a']);
  });

  test('filterProcessDataForSelection does not mix untagged process data into graph-run-tagged selections', () => {
    const processData = [
      { processId: 'p-untagged-a', data: { status: { type: 'ok' } } },
      { processId: 'p-sub-a', graphRunId: 'sub-run-a' as GraphRunId, graphId: 'sub-graph' as GraphId, data: { status: { type: 'ok' } } },
      { processId: 'p-untagged-b', data: { status: { type: 'ok' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
    ];

    const filtered = filterProcessDataForSelection({
      graphRuns,
      processData,
      selectedGraphRun: 'sub-run-a' as GraphRunId,
    });

    assert.deepEqual(filtered?.map((p) => p.processId), ['p-sub-a']);
  });

  test('filterProcessDataForSelection returns no data when the selected graph run has no node process', () => {
    const processData = [
      { processId: 'p-sub-a', graphRunId: 'sub-run-a' as GraphRunId, graphId: 'sub-graph' as GraphId, data: { status: { type: 'ok' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
    ];

    const filtered = filterProcessDataForSelection({
      graphRuns,
      processData,
      selectedGraphRun: 'sub-run-b' as GraphRunId,
    });

    assert.equal(filtered, undefined);
  });

  test('filterProcessDataForSelection keeps legacy untagged process data when no tagged data exists', () => {
    const processData = [
      { processId: 'p-untagged-a', data: { status: { type: 'ok' } } },
      { processId: 'p-untagged-b', data: { status: { type: 'ok' } } },
    ] as ProcessDataForNode[];

    const graphRuns = [
      { graphRunId: 'sub-run-a' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
      { graphRunId: 'sub-run-b' as GraphRunId, rootRunId: 'root-1' as RootRunId, graphId: 'sub-graph' as GraphId },
    ];

    const filtered = filterProcessDataForSelection({
      graphRuns,
      processData,
      selectedGraphRun: 'sub-run-a' as GraphRunId,
    });

    assert.deepEqual(filtered?.map((p) => p.processId), ['p-untagged-a', 'p-untagged-b']);
  });

  test('remote executor routing only uses remote transport when usable or required', () => {
    assert.equal(
      shouldUseRemoteExecutor({
        selectedExecutor: 'browser',
        session: { capabilities: inactiveCapabilities, status: 'connecting', target: null },
      }),
      false,
    );

    assert.equal(
      shouldUseRemoteExecutor({
        selectedExecutor: 'browser',
        session: {
          capabilities: inactiveCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      false,
    );

    assert.equal(
      shouldUseRemoteExecutor({
        selectedExecutor: 'browser',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      true,
    );

    assert.equal(
      shouldUseRemoteExecutor({
        selectedExecutor: 'browser',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
        },
      }),
      false,
    );

    assert.equal(
      shouldUseRemoteExecutor({
        selectedExecutor: 'nodejs',
        session: { capabilities: inactiveCapabilities, status: 'reconnecting', target: null },
      }),
      true,
    );

    assert.equal(
      shouldUseRemoteExecutor({
        hasLoadedRecording: true,
        selectedExecutor: 'nodejs',
        session: { capabilities: readyCapabilities, status: 'ready', target: null },
      }),
      false,
    );
  });

  test('editor graph runs are disabled while an external remote debugger is active', () => {
    assert.equal(
      canRunGraphFromEditor({
        selectedExecutor: 'browser',
        session: { capabilities: readyCapabilities, status: 'ready', target: null },
      }),
      true,
    );

    assert.equal(
      canRunGraphFromEditor({
        selectedExecutor: 'browser',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      false,
    );

    assert.equal(
      canRunGraphFromEditor({
        hasLoadedRecording: true,
        selectedExecutor: 'nodejs',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      false,
    );

    assert.equal(
      canRunGraphFromEditor({
        selectedExecutor: 'nodejs',
        session: {
          capabilities: inactiveCapabilities,
          status: 'idle',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      true,
    );
  });

  test('executor product states separate browser, internal node, and external debugger sessions', () => {
    assert.deepEqual(
      getExecutorProductState({
        selectedExecutor: 'browser',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      { type: 'external-debugger-ready' },
    );

    assert.deepEqual(
      getExecutorProductState({
        selectedExecutor: 'browser',
        session: {
          capabilities: inactiveCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      { type: 'external-debugger-connecting' },
    );

    assert.deepEqual(
      getExecutorProductState({
        selectedExecutor: 'browser',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
        },
      }),
      { type: 'browser-ready' },
    );

    assert.deepEqual(
      getExecutorProductState({
        hasLoadedRecording: true,
        selectedExecutor: 'nodejs',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'external-debugger', url: 'ws://debugger.example/latest' },
        },
      }),
      { type: 'external-debugger-ready' },
    );

    assert.deepEqual(
      getExecutorProductState({
        selectedExecutor: 'nodejs',
        session: {
          capabilities: readyCapabilities,
          status: 'ready',
          target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
        },
      }),
      { type: 'internal-node-ready' },
    );

    assert.deepEqual(
      getExecutorProductState({
        selectedExecutor: 'nodejs',
        session: {
          capabilities: inactiveCapabilities,
          status: 'ready',
          target: { type: 'internal-hosted', url: 'ws://executor.example/internal' },
        },
      }),
      { type: 'internal-node-starting' },
    );
  });
});
