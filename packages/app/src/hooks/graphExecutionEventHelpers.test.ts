import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WarningsPort,
  type GraphId,
  type GraphRunId,
  type NodeId,
  type PortId,
  type ProcessId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../state/dataFlow.js';
import {
  appendRootRunIdOnce,
  finishGraphRunHistory,
  MISSING_DEBUGGER_TERMINAL_EVENT_WARNING,
  reconcileRunningProcessesAfterSuccessfulDone,
  removeRunningGraphEntry,
} from './graphExecutionEventHelpers.js';
import { buildGraphViewKeyFromExecution } from '../utils/executionIdentity.js';

test('removeRunningGraphEntry removes one matching graph entry', () => {
  assert.deepEqual(removeRunningGraphEntry(['a' as GraphId, 'b' as GraphId, 'a' as GraphId], 'a' as GraphId), [
    'b',
    'a',
  ]);
});

test('appendRootRunIdOnce keeps one reconciliation entry per root run', () => {
  const rootRuns = ['root-1' as RootRunId];

  assert.equal(appendRootRunIdOnce(rootRuns, 'root-1' as RootRunId), rootRuns);
  assert.deepEqual(appendRootRunIdOnce(rootRuns, 'root-2' as RootRunId), [
    'root-1' as RootRunId,
    'root-2' as RootRunId,
  ]);
});

test('repeated graph terminals preserve the original finish clock', (t) => {
  let clock = 10;
  t.mock.method(Date, 'now', () => clock++);
  const execution = {
    graphId: 'graph' as GraphId,
    graphRunId: 'invocation' as GraphRunId,
    rootRunId: 'root' as RootRunId,
  };
  const view = buildGraphViewKeyFromExecution({ execution, graphIdFallback: execution.graphId });
  const history = {
    [view]: [{ ...execution, status: 'running' as const, startedAt: 1 }],
  };
  const terminal = finishGraphRunHistory(history, view, execution.graphRunId, 'error');
  assert.equal(terminal[view]![0]!.finishedAt, 10);
  assert.equal(finishGraphRunHistory(terminal, view, execution.graphRunId, 'error'), terminal);
  assert.equal(clock, 11);
});

test('reconcileRunningProcessesAfterSuccessfulDone clears orphaned running processes with a warning', () => {
  const nodeId = 'node-1' as NodeId;
  const warningPort = WarningsPort as PortId;
  const missingTerminalEvents: unknown[] = [];
  const lastRunData: RunDataByNodeId = {
    [nodeId]: [
      {
        graphRunId: 'graph-run-1' as GraphRunId,
        processId: 'process-1' as ProcessId,
        data: {
          inputData: {},
          status: { type: 'running' },
        },
      },
      {
        graphRunId: 'graph-run-1' as GraphRunId,
        processId: 'process-2' as ProcessId,
        data: {
          status: { type: 'ok' },
        },
      },
    ],
  };

  const reconciled = reconcileRunningProcessesAfterSuccessfulDone(lastRunData, {
    onMissingTerminalEvent: (event) => missingTerminalEvents.push(event),
  });

  assert.notEqual(reconciled, lastRunData);
  assert.equal(reconciled[nodeId]![0]!.data.status?.type, 'ok');
  assert.equal(reconciled[nodeId]![1]!.data.status?.type, 'ok');
  assert.deepEqual(reconciled[nodeId]![0]!.data.outputData?.[warningPort], {
    type: 'string[]',
    storage: 'inline',
    value: [MISSING_DEBUGGER_TERMINAL_EVENT_WARNING],
  });
  assert.deepEqual(missingTerminalEvents, [
    {
      graphId: undefined,
      graphRunId: 'graph-run-1',
      nodeId: 'node-1',
      processId: 'process-1',
      rootRunId: undefined,
    },
  ]);
});

test('reconcileRunningProcessesAfterSuccessfulDone can scope cleanup to one root run', () => {
  const firstNodeId = 'node-1' as NodeId;
  const secondNodeId = 'node-2' as NodeId;
  const lastRunData: RunDataByNodeId = {
    [firstNodeId]: [
      {
        rootRunId: 'root-1' as RootRunId,
        processId: 'process-1' as ProcessId,
        data: {
          status: { type: 'running' },
        },
      },
    ],
    [secondNodeId]: [
      {
        rootRunId: 'root-2' as RootRunId,
        processId: 'process-2' as ProcessId,
        data: {
          status: { type: 'running' },
        },
      },
    ],
  };

  const reconciled = reconcileRunningProcessesAfterSuccessfulDone(lastRunData, { rootRunId: 'root-1' as RootRunId });

  assert.equal(reconciled[firstNodeId]![0]!.data.status?.type, 'ok');
  assert.equal(reconciled[secondNodeId]![0]!.data.status?.type, 'running');
});

test('reconcileRunningProcessesAfterSuccessfulDone keeps state identity when no processes are running', () => {
  const lastRunData: RunDataByNodeId = {
    ['node-1' as NodeId]: [
      {
        processId: 'process-1' as ProcessId,
        data: {
          status: { type: 'ok' },
        },
      },
    ],
  };

  assert.equal(reconcileRunningProcessesAfterSuccessfulDone(lastRunData), lastRunData);
});
