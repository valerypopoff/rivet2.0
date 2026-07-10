import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, NodePrefabId, UiGraphId } from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext } from '../graphEditing/navigationActions.js';
import {
  getProjectWorkspaceLeavePolicy,
  getProjectWorkspaceTargetCapabilities,
  resolveProjectWorkspaceTarget,
} from './projectWorkspaceTarget.js';

const graphView = createRootGraphViewContext('graph' as GraphId);

test('resource targets restore only while their project resource remains valid', () => {
  const uiGraphId = 'ui' as UiGraphId;
  const prefabId = 'prefab' as NodePrefabId;
  const project = {
    nodePrefabs: { [prefabId]: { id: prefabId } },
    uiGraphs: { [uiGraphId]: { id: uiGraphId } },
  } as never;

  assert.deepEqual(
    resolveProjectWorkspaceTarget({
      fallbackGraphView: graphView,
      project,
      restoreResourceTarget: true,
      storedTarget: { editingPrefabId: prefabId, type: 'nodeLibrary' },
    }),
    { editingPrefabId: prefabId, type: 'nodeLibrary' },
  );
  assert.deepEqual(
    resolveProjectWorkspaceTarget({
      fallbackGraphView: graphView,
      project,
      restoreResourceTarget: true,
      storedTarget: { type: 'uiGraph', uiGraphId },
    }),
    { type: 'uiGraph', uiGraphId },
  );
  assert.deepEqual(
    resolveProjectWorkspaceTarget({
      fallbackGraphView: graphView,
      project: {},
      restoreResourceTarget: true,
      storedTarget: { type: 'uiGraph', uiGraphId },
    }),
    { graphView, type: 'graph' },
  );
});

test('explicit graph loads do not restore a stored resource target', () => {
  assert.deepEqual(
    resolveProjectWorkspaceTarget({
      fallbackGraphView: graphView,
      project: {},
      restoreResourceTarget: false,
      storedTarget: { type: 'nodeLibrary' },
    }),
    { graphView, type: 'graph' },
  );
});

test('only graph targets expose execution', () => {
  assert.equal(getProjectWorkspaceTargetCapabilities({ graphView, type: 'graph' }).canRun, true);
  assert.equal(getProjectWorkspaceTargetCapabilities({ type: 'nodeLibrary' }).canRun, false);
  assert.equal(getProjectWorkspaceTargetCapabilities({ type: 'uiGraph', uiGraphId: 'ui' as UiGraphId }).canRun, false);
});

test('resource targets never persist their canvas as the underlying graph viewport', () => {
  assert.deepEqual(getProjectWorkspaceLeavePolicy({ graphView, type: 'graph' }), {
    commitLiveGraph: true,
    persistGraphViewport: true,
  });
  assert.deepEqual(getProjectWorkspaceLeavePolicy({ type: 'nodeLibrary' }), {
    commitLiveGraph: false,
    persistGraphViewport: false,
  });
  assert.deepEqual(getProjectWorkspaceLeavePolicy({ type: 'uiGraph', uiGraphId: 'ui' as UiGraphId }), {
    commitLiveGraph: false,
    persistGraphViewport: false,
  });
});
