import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import { TextNodeImpl, type GraphId, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from './atoms/graph.js';
import { projectState, projectsState } from './savedGraphs.js';
import {
  clearInvalidFullscreenOutputSelectionState,
  closeFullscreenOutputSelectionState,
  fullscreenOutputNodeState,
  fullscreenOutputSelectionState,
  reconcileProjectFullscreenOutputState,
} from './fullscreenOutput.js';

function fixture() {
  const store = createStore();
  const first = TextNodeImpl.create();
  const second = TextNodeImpl.create();
  const graph = {
    metadata: { id: 'shared-graph' as GraphId, name: 'Same graph' },
    nodes: [first, second],
    connections: [],
  };
  const project = (id: string): Project => ({
    metadata: { id: id as ProjectId, title: id, description: '' },
    graphs: { [graph.metadata.id]: graph },
    plugins: [],
  });
  const a = project('constructor');
  const b = project('b');
  store.set(projectsState, {
    openedProjects: {
      [a.metadata.id]: { projectId: a.metadata.id, title: 'A', fsPath: '/a' },
      [b.metadata.id]: { projectId: b.metadata.id, title: 'B', fsPath: '/b' },
    },
    openedProjectsSortedIds: [a.metadata.id, b.metadata.id],
  });
  const activate = (target: Project) => {
    store.set(projectState, target);
    store.set(graphState, graph);
  };
  activate(a);
  return { store, first, second, graph, a, b, activate };
}

test('identical graph and node IDs keep independent full-output selections per tab and per store', () => {
  const { store, first, second, a, b, activate } = fixture();
  assert.equal(store.get(fullscreenOutputSelectionState), null);
  store.set(fullscreenOutputNodeState, first.id);
  const original = store.get(fullscreenOutputSelectionState);
  activate(b);
  assert.equal(store.get(fullscreenOutputNodeState), null);
  store.set(fullscreenOutputNodeState, second.id);
  activate(a);
  assert.equal(store.get(fullscreenOutputSelectionState), original);
  assert.equal(store.get(fullscreenOutputNodeState), first.id);
  store.set(fullscreenOutputNodeState, (previous) => (previous === first.id ? second.id : first.id));
  assert.equal(store.get(fullscreenOutputNodeState), second.id);
  store.set(fullscreenOutputNodeState, null);
  activate(b);
  assert.equal(store.get(fullscreenOutputNodeState), second.id);
  assert.equal(createStore().get(fullscreenOutputSelectionState), null);
});

for (const [name, action] of [
  ['cleanup', clearInvalidFullscreenOutputSelectionState],
  ['dismissal', closeFullscreenOutputSelectionState],
] as const) {
  test(`late ${name} preserves another tab and a newer same-ID selection in its original tab`, () => {
    const { store, first, graph, a, b, activate } = fixture();
    store.set(fullscreenOutputNodeState, first.id);
    const stale = store.get(fullscreenOutputSelectionState)!;
    activate(b);
    store.set(fullscreenOutputNodeState, first.id);
    const neighbor = store.get(fullscreenOutputSelectionState);
    assert.equal(store.set(action, stale), false);
    assert.equal(store.get(fullscreenOutputSelectionState), neighbor);
    activate(a);
    store.set(fullscreenOutputNodeState, null);
    store.set(fullscreenOutputNodeState, first.id);
    const newer = store.get(fullscreenOutputSelectionState)!;
    // Make cleanup eligible except for its stale selection identity.
    if (action === clearInvalidFullscreenOutputSelectionState) store.set(graphState, { ...graph, nodes: [] });
    assert.equal(store.set(action, stale), false);
    assert.equal(store.get(fullscreenOutputSelectionState), newer);
    assert.equal(store.set(action, newer), true);
    assert.equal(store.get(fullscreenOutputNodeState), null);
    activate(b);
    assert.equal(store.get(fullscreenOutputSelectionState), neighbor);
  });
}

test('delayed invalid-node cleanup rechecks restored nodes and never discards an inactive tab modal', () => {
  const { store, first, graph, a, b, activate } = fixture();
  store.set(fullscreenOutputNodeState, first.id);
  const selection = store.get(fullscreenOutputSelectionState)!;
  store.set(graphState, { ...graph, nodes: [] });
  // An effect observed the missing node, but Undo restored it before cleanup ran.
  store.set(graphState, graph);
  assert.equal(store.set(clearInvalidFullscreenOutputSelectionState, selection), false);
  assert.equal(store.get(fullscreenOutputSelectionState), selection);
  store.set(graphState, { ...graph, nodes: [] });
  activate(b);
  store.set(fullscreenOutputNodeState, first.id);
  const neighbor = store.get(fullscreenOutputSelectionState);
  assert.equal(store.set(clearInvalidFullscreenOutputSelectionState, selection), false);
  assert.equal(store.get(fullscreenOutputSelectionState), neighbor);
  activate(a);
  assert.equal(store.get(fullscreenOutputSelectionState), selection);
  store.set(graphState, { ...graph, nodes: [] });
  assert.equal(store.set(clearInvalidFullscreenOutputSelectionState, selection), true);
  assert.equal(store.get(fullscreenOutputNodeState), null);
});

test('graph reconciliation preserves the same graph and retires only the changed tab selection', () => {
  const { store, first, graph, a, b, activate } = fixture();
  store.set(fullscreenOutputNodeState, first.id);
  const original = store.get(fullscreenOutputSelectionState);
  activate(b);
  store.set(fullscreenOutputNodeState, first.id);
  const neighbor = store.get(fullscreenOutputSelectionState);
  store.set(reconcileProjectFullscreenOutputState, { projectId: a.metadata.id, graphId: graph.metadata.id });
  activate(a);
  assert.equal(store.get(fullscreenOutputSelectionState), original, 'same graph restores its selection');
  store.set(reconcileProjectFullscreenOutputState, { projectId: a.metadata.id, graphId: 'other-graph' as GraphId });
  assert.equal(store.get(fullscreenOutputNodeState), null);
  store.set(graphState, { ...graph, metadata: { id: 'other-graph' as GraphId } });
  store.set(graphState, graph);
  assert.equal(store.get(fullscreenOutputNodeState), null, 'graph history cannot resurrect the selection');
  activate(b);
  assert.equal(store.get(fullscreenOutputSelectionState), neighbor);
});

test('an incompatible graph hides the modal immediately, before renderer cleanup', () => {
  const { store, first, graph } = fixture();
  store.set(fullscreenOutputNodeState, first.id);
  const stale = store.get(fullscreenOutputSelectionState)!;
  store.set(graphState, { ...graph, metadata: undefined });
  assert.equal(store.get(fullscreenOutputNodeState), null);
  assert.equal(store.set(clearInvalidFullscreenOutputSelectionState, stale), true);
  assert.equal(store.get(fullscreenOutputSelectionState), null);
  assert.equal(store.get(fullscreenOutputNodeState), null, 'a cleared selection also tolerates an absent graph');
});
