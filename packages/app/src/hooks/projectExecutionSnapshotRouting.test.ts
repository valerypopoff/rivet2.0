import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DataValue,
  type GraphId,
  type NodeId,
  type ProcessId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
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
