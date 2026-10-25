import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import {
  createBuiltInRegistry,
  type GraphId,
  type GraphRunId,
  type ProcessId,
  type Project,
  type ProjectId,
  type RootRunId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { createRootGraphViewContext } from '../../domain/graphEditing/navigationActions.js';
import {
  lastRunDataByNodeState,
  selectedGraphRunByViewState,
  selectedProcessPageNodesState,
  type ProcessDataForNode,
} from '../../state/dataFlow.js';
import { graphState } from '../../state/graph.js';
import { fullscreenOutputNodeState, graphNavigationStackState } from '../../state/graphBuilder.js';
import { renewProjectBindingState, retireWorkspaceExecutionState } from '../../state/projectBindings.js';
import { projectState, projectsState } from '../../state/savedGraphs.js';
import { runActivityDrawerOpenState } from '../../state/ui.js';
import { createRunActivityOutputNavigation } from './runActivityOutputNavigation.js';
import type { RunActivityInvocationIdentity } from './types.js';

function fixture(bound = true) {
  const store = createStore();
  const node = createBuiltInRegistry().create('text');
  const graph = { metadata: { id: 'output-graph' as GraphId }, nodes: [node], connections: [] };
  const project: Project = {
    metadata: { id: 'output-project' as ProjectId, title: '', description: '' },
    graphs: { [graph.metadata.id]: graph },
  };
  const target: RunActivityInvocationIdentity = {
    nodeId: node.id,
    graphId: graph.metadata.id,
    rootRunId: 'root' as RootRunId,
    graphRunId: 'graph-run' as GraphRunId,
    processId: 'process' as ProcessId,
  };
  const process: ProcessDataForNode = {
    ...target,
    data: {
      status: { type: 'ok' },
      outputData: { ['output' as PortId]: { type: 'string', storage: 'inline', value: 'result' } },
    },
  };
  const view = createRootGraphViewContext(target.graphId);
  store.set(projectState, project);
  store.set(projectsState, {
    openedProjects: bound
      ? { [project.metadata.id]: { projectId: project.metadata.id, title: '', fsPath: '/fixture.rivet-project' } }
      : {},
    openedProjectsSortedIds: bound ? [project.metadata.id] : [],
  });
  store.set(graphState, graph);
  store.set(graphNavigationStackState, { stack: [view], index: 0 });
  store.set(selectedGraphRunByViewState, { [view.key]: target.graphRunId });
  store.set(selectedProcessPageNodesState, { [node.id]: 0 });
  store.set(lastRunDataByNodeState, { [node.id]: [process] });
  store.set(fullscreenOutputNodeState, null);
  const callbacks: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  const navigation = createRunActivityOutputNavigation(store, {
    request: (callback) => callbacks.push(callback),
    cancel: (id) => {
      cancelled.push(id);
    },
  });
  return { store, project, graph, view, target, process, navigation, callbacks, cancelled };
}

type Fixture = ReturnType<typeof fixture>;
const invalidations: Record<string, (f: Fixture) => void> = {
  'different project with cloned graph/node IDs': ({ store, project }) =>
    store.set(projectState, { ...project, metadata: { ...project.metadata, id: 'clone' as ProjectId } }),
  'same-ID binding renewal': ({ store, project }) => store.set(renewProjectBindingState, project.metadata.id),
  'workspace release': ({ store }) => store.set(retireWorkspaceExecutionState),
  'close and reopen same path': ({ store }) => {
    const before = store.get(projectsState);
    store.set(projectsState, { openedProjects: {}, openedProjectsSortedIds: [] });
    store.set(projectsState, before);
  },
  'different graph': ({ store, graph }) => store.set(graphState, { ...graph, metadata: { id: 'other' as GraphId } }),
  'different caller view of same graph': ({ store, view }) =>
    store.set(graphNavigationStackState, { stack: [{ ...view, key: 'another-caller' }], index: 0 }),
  'different selected graph execution': ({ store, view }) =>
    store.set(selectedGraphRunByViewState, { [view.key]: 'other' as GraphRunId }),
  'node deleted': ({ store, graph }) => store.set(graphState, { ...graph, nodes: [] }),
  'evidence removed': ({ store }) => store.set(lastRunDataByNodeState, {}),
  'outputs cleared': ({ store, target, process }) =>
    store.set(lastRunDataByNodeState, { [target.nodeId]: [{ ...process, data: { status: { type: 'ok' } } }] }),
  'selected page changed': ({ store, target }) => store.set(selectedProcessPageNodesState, { [target.nodeId]: 1 }),
  'retention shifts exact page': ({ store, target, process }) =>
    store.set(lastRunDataByNodeState, {
      [target.nodeId]: [{ ...process, processId: 'earlier' as ProcessId }, process],
    }),
  'presentation owner disposed': ({ navigation }) => navigation.dispose(),
};

for (const [name, invalidate] of Object.entries(invalidations)) {
  test(`deferred output refuses ${name}`, () => {
    const f = fixture();
    f.navigation.schedule(f.target);
    invalidate(f);
    // Even an already queued/cancelled browser callback cannot revive an intent.
    f.callbacks[0]!(0);
    assert.equal(f.store.get(fullscreenOutputNodeState), null);
  });
}

test('valid output survives drawer closure and ordinary immutable data updates, including standalone projects', () => {
  for (const bound of [true, false]) {
    const f = fixture(bound);
    f.navigation.schedule(f.target);
    f.store.set(runActivityDrawerOpenState, false);
    f.store.set(lastRunDataByNodeState, { [f.target.nodeId]: [{ ...f.process, data: { ...f.process.data } }] });
    f.callbacks[0]!(0);
    assert.equal(f.store.get(fullscreenOutputNodeState), f.target.nodeId);
  }
  const f = fixture(false);
  f.navigation.schedule(f.target);
  f.store.set(projectState, { ...f.project }); // No binding exists to distinguish this replacement.
  f.callbacks[0]!(0);
  assert.equal(f.store.get(fullscreenOutputNodeState), null);
});

test('latest output intent wins and exact tool port is rechecked on the live process', () => {
  const f = fixture();
  f.navigation.schedule(f.target);
  f.navigation.schedule({ ...f.target, outputPortId: 'output' as PortId });
  assert.deepEqual(f.cancelled, [1]);
  f.callbacks[0]!(0);
  assert.equal(f.store.get(fullscreenOutputNodeState), null);
  f.store.set(lastRunDataByNodeState, {
    [f.target.nodeId]: [
      {
        ...f.process,
        data: {
          status: { type: 'ok' },
          outputData: { ['other' as PortId]: { type: 'string', storage: 'inline', value: 'not the tool result' } },
        },
      },
    ],
  });
  f.callbacks[1]!(0);
  assert.equal(f.store.get(fullscreenOutputNodeState), null);
  f.store.set(lastRunDataByNodeState, {
    [f.target.nodeId]: [
      {
        ...f.process,
        data: {
          status: { type: 'ok' },
          splitOutputData: {
            0: { ['output' as PortId]: { type: 'string', storage: 'inline', value: 'split result' } },
          },
        },
      },
    ],
  });
  f.navigation.schedule({ ...f.target, outputPortId: 'output' as PortId });
  f.callbacks[2]!(0);
  assert.equal(f.store.get(fullscreenOutputNodeState), f.target.nodeId);
});
