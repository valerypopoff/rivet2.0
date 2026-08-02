import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WarningsPort,
  type DataValue,
  type GraphId,
  type GraphRunId,
  type NodeId,
  type PortId,
  type ProcessId,
  type ProjectId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { createEmptyProjectExecutionSnapshot, type ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { MISSING_DEBUGGER_TERMINAL_EVENT_WARNING } from './graphExecutionEventHelpers.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';

function createDataRefStore(): DataRefStore {
  const values = new Map<string, DataValue>();

  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
  };
}

test('inactive project snapshot reducer finishes a hidden successful run', () => {
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const graphRunId = 'graph-run-a' as GraphRunId;
  const rootRunId = 'root-run-a' as RootRunId;
  const nodeId = 'node-a' as NodeId;
  const processId = 'process-a' as ProcessId;
  const refStore = createDataRefStore();
  let snapshot: ProjectExecutionSnapshot | undefined;

  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      startGraph: {
        metadata: {
          id: graphId,
        },
      },
    } as never,
    message: 'start',
    projectId,
    refStore,
    snapshot,
  }).snapshot;
  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      execution: {
        executor: 'nodejs',
        graphId,
        graphRunId,
        rootRunId,
      },
      graph: {
        metadata: {
          id: graphId,
        },
      },
    } as never,
    message: 'graphStart',
    projectId,
    refStore,
    snapshot,
  }).snapshot;
  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      execution: {
        graphId,
        graphRunId,
        rootRunId,
      },
      inputs: {},
      node: {
        id: nodeId,
      },
      processId,
    } as never,
    message: 'nodeStart',
    projectId,
    refStore,
    snapshot,
  }).snapshot;
  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      durationMs: 12,
      execution: {
        graphId,
        graphRunId,
        rootRunId,
      },
      node: {
        id: nodeId,
      },
      outputs: {
        output: {
          type: 'string',
          value: 'done',
        },
      },
      processId,
    } as never,
    message: 'nodeFinish',
    projectId,
    refStore,
    snapshot,
  }).snapshot;
  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      execution: {
        graphId,
        graphRunId,
        rootRunId,
      },
      graph: {
        metadata: {
          id: graphId,
        },
      },
    } as never,
    message: 'graphFinish',
    projectId,
    refStore,
    snapshot,
  }).snapshot;
  snapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      results: {},
    } as never,
    message: 'done',
    projectId,
    refStore,
    snapshot,
  }).snapshot;

  assert.equal(snapshot.graphRunning, false);
  assert.deepEqual(snapshot.runningGraphs, []);
  assert.equal(snapshot.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'ok');
  assert.equal(snapshot.lastRunDataByNode[nodeId]?.[0]?.data.durationMs, 12);
  assert.deepEqual(snapshot.lastRunDataByNode[nodeId]?.[0]?.data.outputData?.['output' as PortId], {
    type: 'string',
    storage: 'inline',
    value: 'done',
  });
});

test('inactive project snapshot reducer clears stale running nodes on successful done', () => {
  const nodeId = 'node-a' as NodeId;
  const processId = 'process-a' as ProcessId;
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const graphRunId = 'graph-run-a' as GraphRunId;
  const rootRunId = 'root-run-a' as RootRunId;
  const refStore = createDataRefStore();
  const snapshot = createEmptyProjectExecutionSnapshot();
  snapshot.graphRunning = true;
  snapshot.runningGraphs = [graphId];
  snapshot.lastRunDataByNode[nodeId] = [
    {
      graphId,
      graphRunId,
      processId,
      rootRunId,
      data: {
        status: {
          type: 'running',
        },
      },
    },
  ];

  const result = applyProcessEventToProjectExecutionSnapshot({
    data: {
      results: {},
    } as never,
    message: 'done',
    projectId,
    refStore,
    snapshot,
  }).snapshot;

  const process = result.lastRunDataByNode[nodeId]?.[0];
  assert.equal(result.graphRunning, false);
  assert.deepEqual(result.runningGraphs, []);
  assert.equal(process?.data.status?.type, 'ok');
  assert.deepEqual(process?.data.outputData?.[WarningsPort as PortId], {
    type: 'string[]',
    storage: 'inline',
    value: [MISSING_DEBUGGER_TERMINAL_EVENT_WARNING],
  });
});

test('inactive project snapshot reducer stores hidden user input prompts and clears them on terminal events', () => {
  const nodeId = 'node-a' as NodeId;
  const processId = 'process-a' as ProcessId;
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const graphRunId = 'graph-run-a' as GraphRunId;
  const rootRunId = 'root-run-a' as RootRunId;
  const refStore = createDataRefStore();

  const snapshotWithQuestion = applyProcessEventToProjectExecutionSnapshot({
    data: {
      execution: {
        graphId,
        graphRunId,
        rootRunId,
      },
      inputStrings: ['Question?'],
      node: {
        id: nodeId,
      },
      processId,
    } as never,
    message: 'userInput',
    projectId,
    refStore,
    snapshot: createEmptyProjectExecutionSnapshot(),
  }).snapshot;

  assert.deepEqual(snapshotWithQuestion.userInputQuestions[nodeId], [
    {
      nodeId,
      processId,
      questions: ['Question?'],
    },
  ]);
  assert.equal(snapshotWithQuestion.selectedProcessPageNodes[nodeId], 'latest');

  const finishedSnapshot = applyProcessEventToProjectExecutionSnapshot({
    data: {
      results: {},
    } as never,
    message: 'done',
    projectId,
    refStore,
    snapshot: snapshotWithQuestion,
  }).snapshot;

  assert.deepEqual(finishedSnapshot.userInputQuestions, {});
});

test('inactive project snapshot reducer upserts identified model and tool trace events', () => {
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const graphRunId = 'graph-run-a' as GraphRunId;
  const rootRunId = 'root-run-a' as RootRunId;
  const nodeId = 'llm-node' as NodeId;
  const processId = 'llm-process' as ProcessId;
  const refStore = createDataRefStore();
  const execution = { graphId, graphRunId, rootRunId };
  let snapshot = createEmptyProjectExecutionSnapshot();

  for (const durationMs of [10, 12]) {
    snapshot = applyProcessEventToProjectExecutionSnapshot({
      data: {
        attemptIndex: 0,
        callId: 'model-call',
        durationMs,
        execution,
        model: 'gpt-test',
        nodeId,
        outcome: 'success',
        pricing: { status: 'unknown' },
        processId,
        provider: 'openai',
      } as never,
      message: 'llmCallFinished',
      projectId,
      refStore,
      snapshot,
    }).snapshot;
  }

  for (const durationMs of [4, 6]) {
    snapshot = applyProcessEventToProjectExecutionSnapshot({
      data: {
        durationMs,
        execution,
        handlerKind: 'graph',
        outcome: 'success',
        sourceNodeId: nodeId,
        sourceProcessId: processId,
        toolCallId: 'tool-call',
        toolName: 'lookup',
      } as never,
      message: 'toolCallFinished',
      projectId,
      refStore,
      snapshot,
    }).snapshot;
  }

  const events = snapshot.lastRunDataByNode[nodeId]?.[0]?.data.agentTraceEvents;
  assert.equal(events?.length, 2);
  assert.equal(events?.[0]?.type, 'llm-call-finished');
  assert.equal(events?.[0]?.durationMs, 12);
  assert.equal(events?.[1]?.type, 'tool-call-finished');
  assert.equal(events?.[1]?.durationMs, 6);
});

test('inactive project snapshot reducer keeps anonymous tool trace events distinct', () => {
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const graphRunId = 'graph-run-a' as GraphRunId;
  const rootRunId = 'root-run-a' as RootRunId;
  const nodeId = 'llm-node' as NodeId;
  const processId = 'llm-process' as ProcessId;
  const refStore = createDataRefStore();
  const execution = { graphId, graphRunId, rootRunId };
  let snapshot = createEmptyProjectExecutionSnapshot();

  for (const durationMs of [4, 6]) {
    snapshot = applyProcessEventToProjectExecutionSnapshot({
      data: {
        durationMs,
        execution,
        handlerKind: 'external',
        outcome: 'success',
        sourceNodeId: nodeId,
        sourceProcessId: processId,
        toolName: 'anonymous',
      } as never,
      message: 'toolCallFinished',
      projectId,
      refStore,
      snapshot,
    }).snapshot;
  }

  const events = snapshot.lastRunDataByNode[nodeId]?.[0]?.data.agentTraceEvents;
  assert.equal(events?.length, 2);
  assert.deepEqual(
    events?.map((event) => event.durationMs),
    [4, 6],
  );
});
