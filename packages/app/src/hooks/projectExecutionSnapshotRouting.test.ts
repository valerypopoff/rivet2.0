import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TextNodeImpl,
  type DataValue,
  type GraphId,
  type GraphRunId,
  type RootRunId,
  type NodeId,
  type PortId,
  type ProcessId,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { createEmptyProjectExecutionSnapshot } from '../state/dataFlow.js';
import { restoreStoredPortMap } from '../utils/executionDataReaders.js';
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
  const neighborId = 'project-b' as ProjectId;
  const neighbor = { ...createEmptyProjectExecutionSnapshot(), lastRecording: 'neighbor-recording' };
  const previousSnapshots: ProjectExecutionSnapshots = { [neighborId]: neighbor };
  const before = structuredClone(previousSnapshots);
  const node = TextNodeImpl.create();
  node.id = nodeId;

  const nextSnapshots = applyProcessEventToProjectExecutionSnapshots({
    data: {
      execution: {
        projectId,
        graphId,
        rootRunId: 'root' as RootRunId,
        graphRunId: 'graph-run' as GraphRunId,
      },
      inputs: {},
      node,
      processId,
    },
    message: 'nodeStart',
    projectId,
    refStore,
    snapshots: previousSnapshots,
  });

  assert.notEqual(nextSnapshots, previousSnapshots);
  assert.equal(nextSnapshots[projectId]?.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'running');
  assert.equal(nextSnapshots[neighborId], neighbor, 'updating one project preserves its neighbor');
  assert.deepEqual(previousSnapshots, before, 'the prior map and snapshots are immutable');
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
    },
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
  const node = TextNodeImpl.create();
  node.id = nodeId;
  node.data.text = '{{input}}';
  const execution = {
    projectId,
    graphId: 'graph-a' as GraphId,
    graphRunId: 'graph-run' as GraphRunId,
    rootRunId: 'root' as RootRunId,
  };
  for (const processId of ['first', 'second'] as ProcessId[]) {
    snapshots = applyProcessEventToProjectExecutionSnapshots({
      snapshots,
      projectId,
      refStore,
      previousDataPerNodeToKeep: 0,
      message: 'nodeStart',
      data: {
        execution,
        node,
        processId,
        inputs: { ['input' as PortId]: { type: 'string', value: processId.repeat(20_000) } },
      },
    });
    if (processId === 'first') {
      // Older persisted display snapshots predate round-page selection state.
      Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
    }
  }
  const runs = snapshots[projectId]!.lastRunDataByNode[nodeId]!;
  assert.equal(runs.length, 2, 'retention preserves invocation metadata');
  assert.deepEqual(runs[0]!.data.inputData, {});
  assert.deepEqual(
    restoreStoredPortMap(runs[1]!.data.inputData, refStore),
    {
      input: { type: 'string', value: 'second'.repeat(20_000) },
    },
    'the actual latest payload survives, not merely a truthy port map',
  );
  assert.equal(values.size, 1, 'the older invocation no longer owns a stored payload');
  assert.deepEqual(snapshots[projectId]!.selectedLLMChatOutputPageByInvocation, {});
  Reflect.deleteProperty(snapshots[projectId]!, 'selectedLLMChatOutputPageByInvocation');
  snapshots = applyProcessEventToProjectExecutionSnapshots({
    snapshots,
    projectId,
    refStore,
    message: 'nodeOutputsCleared',
    data: { node, execution },
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
  const nodeId = 'node' as NodeId;
  runningSnapshot.lastRunDataByNode[nodeId] = [
    { processId: 'target' as ProcessId, data: { status: { type: 'running' } } },
  ];
  const neighborId = 'project-b' as ProjectId;
  const neighbor = structuredClone(runningSnapshot);
  neighbor.lastRecording = 'keep-neighbor';
  const runningSnapshots: ProjectExecutionSnapshots = {
    [projectId]: runningSnapshot,
    [neighborId]: neighbor,
  };
  const before = structuredClone(runningSnapshots);
  const nextSnapshots = applyExecutorDisconnectToProjectExecutionSnapshots({
    errorMessage: 'Executor session disconnected',
    projectId,
    refStore: createDataRefStore(),
    snapshots: runningSnapshots,
  });

  assert.notEqual(nextSnapshots, runningSnapshots);
  assert.equal(nextSnapshots[projectId]?.graphRunning, false);
  assert.equal(nextSnapshots[projectId]?.lastRunDataByNode[nodeId]?.[0]?.data.status?.type, 'interrupted');
  assert.equal(nextSnapshots[neighborId], neighbor, 'disconnect cleanup preserves the other running project');
  assert.deepEqual(runningSnapshots, before, 'cleanup does not mutate the prior map');
});
