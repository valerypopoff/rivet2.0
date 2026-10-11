import assert from 'node:assert/strict';
import test from 'node:test';
import { type DataValue, type GraphId, type NodeId, type ProcessId, type ProjectId } from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { createEmptyProjectExecutionSnapshot } from '../state/dataFlow.js';
import {
  applyExecutorDisconnectToProjectExecutionSnapshots,
  applyProcessEventToProjectExecutionSnapshots,
  shouldRouteProjectEventToSnapshot,
  type ProjectExecutionSnapshots,
} from './projectExecutionSnapshotRouting.js';

function createDataRefStore(): DataRefStore {
  const values = new Map<string, DataValue>();

  return {
    delete: (key) => {
      values.delete(key);
    },
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

test('project execution event routing accepts only inactive open projects', () => {
  const projectId = 'project-a' as ProjectId;

  assert.equal(
    shouldRouteProjectEventToSnapshot({
      activeProjectId: projectId,
      isProjectOpen: true,
      projectId,
    }),
    false,
  );
  assert.equal(
    shouldRouteProjectEventToSnapshot({
      activeProjectId: 'project-b' as ProjectId,
      isProjectOpen: false,
      projectId,
    }),
    false,
  );
  assert.equal(
    shouldRouteProjectEventToSnapshot({
      activeProjectId: 'project-b' as ProjectId,
      isProjectOpen: true,
      projectId,
    }),
    true,
  );
});

test('project execution snapshot map update writes changed process events to the owner project', () => {
  const projectId = 'project-a' as ProjectId;
  const graphId = 'graph-a' as GraphId;
  const nodeId = 'node-a' as NodeId;
  const processId = 'process-a' as ProcessId;
  const refStore = createDataRefStore();
  const previousSnapshots: ProjectExecutionSnapshots = {};

  const nextSnapshots = applyProcessEventToProjectExecutionSnapshots({
    data: {
      execution: {
        graphId,
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
    snapshots: previousSnapshots,
  });

  assert.notEqual(nextSnapshots, previousSnapshots);
  assert.equal(nextSnapshots[projectId]?.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'running');
});

test('project execution snapshot map update can map reducer-ignored snapshots for session-side cleanup', () => {
  const projectId = 'project-a' as ProjectId;
  const snapshot = createEmptyProjectExecutionSnapshot();
  snapshot.frozenNodeOutputs = {
    ['graph-a' as GraphId]: {
      ['node-a' as NodeId]: [],
    },
  };
  const previousSnapshots: ProjectExecutionSnapshots = {
    [projectId]: snapshot,
  };

  const nextSnapshots = applyProcessEventToProjectExecutionSnapshots({
    data: {
      args: [],
      level: 'log',
    } as never,
    mapSnapshot: (nextSnapshot) => ({ ...nextSnapshot, frozenNodeOutputs: {} }),
    message: 'codeConsole',
    projectId,
    refStore: createDataRefStore(),
    snapshots: previousSnapshots,
  });

  assert.notEqual(nextSnapshots, previousSnapshots);
  assert.deepEqual(nextSnapshots[projectId]?.frozenNodeOutputs, {});
});

test('project routing applies the captured payload retention limit and releases evicted evidence', () => {
  const projectId = 'project-a' as ProjectId;
  const nodeId = 'node-a' as NodeId;
  const values = new Map<string, DataValue>();
  const refStore: DataRefStore = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => {
      values.delete(key);
    },
  };
  let snapshots: ProjectExecutionSnapshots = {};
  for (const processId of ['first', 'second'] as ProcessId[]) {
    snapshots = applyProcessEventToProjectExecutionSnapshots({
      snapshots,
      projectId,
      refStore,
      previousDataPerNodeToKeep: 0,
      message: 'nodeStart',
      data: {
        execution: { graphId: 'graph-a' as GraphId },
        node: { id: nodeId },
        processId,
        inputs: { input: { type: 'string', value: processId.repeat(20_000) } },
      } as never,
    });
    if (processId === 'first') {
      // Older persisted display snapshots predate round-page selection state.
      Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
    }
  }
  const runs = snapshots[projectId]!.lastRunDataByNode[nodeId]!;
  assert.equal(runs.length, 2, 'retention preserves invocation metadata');
  assert.deepEqual(runs[0]!.data.inputData, {});
  assert.ok(runs[1]!.data.inputData);
  assert.equal(values.size, 1, 'the older invocation no longer owns a stored payload');
  assert.deepEqual(snapshots[projectId]!.selectedLLMChatOutputPageByInvocation, {});
  Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
  snapshots = applyProcessEventToProjectExecutionSnapshots({
    snapshots,
    projectId,
    refStore,
    message: 'nodeOutputsCleared',
    data: { node: { id: nodeId } } as never,
  });
  assert.equal(values.size, 0, 'clearing an older snapshot also releases its remaining payload');
  assert.deepEqual(snapshots[projectId]!.selectedLLMChatOutputPageByInvocation, {});
});

test('executor disconnect snapshot update interrupts only running hidden snapshots', () => {
  const projectId = 'project-a' as ProjectId;
  const stoppedSnapshot = createEmptyProjectExecutionSnapshot();
  const stoppedSnapshots: ProjectExecutionSnapshots = {
    [projectId]: stoppedSnapshot,
  };

  assert.equal(
    applyExecutorDisconnectToProjectExecutionSnapshots({
      errorMessage: 'Executor session disconnected',
      projectId,
      refStore: createDataRefStore(),
      snapshots: stoppedSnapshots,
    }),
    stoppedSnapshots,
  );

  const runningSnapshot = createEmptyProjectExecutionSnapshot();
  runningSnapshot.graphRunning = true;
  const runningSnapshots: ProjectExecutionSnapshots = {
    [projectId]: runningSnapshot,
  };
  const nextSnapshots = applyExecutorDisconnectToProjectExecutionSnapshots({
    errorMessage: 'Executor session disconnected',
    projectId,
    refStore: createDataRefStore(),
    snapshots: runningSnapshots,
  });

  assert.notEqual(nextSnapshots, runningSnapshots);
  assert.equal(nextSnapshots[projectId]?.graphRunning, false);
});
