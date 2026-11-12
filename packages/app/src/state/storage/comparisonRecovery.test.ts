import assert from 'node:assert/strict';
import test from 'node:test';
import { excludeComparisonInspection } from './comparisonRecovery.js';
import { shouldPersistCurrentGraph } from '../../utils/currentGraphSave.js';
import type { GraphId, NodeGraph } from '@valerypopoff/rivet2-core';

const graph: NodeGraph = { metadata: { id: 'real' as GraphId, name: 'Real graph' }, nodes: [], connections: [] };
const placeholder = {
  ...graph,
  metadata: { id: 'deleted' as GraphId, name: 'Deleted graph' },
  comparisonReferenceView: true,
};
void test('removed-graph inspection cannot become saved content or replace real recovery content', () => {
  assert.equal(shouldPersistCurrentGraph(placeholder, [graph]), false);
  const groups = {
    project: { projectState: { metadata: { id: 'real' }, graphs: { real: graph } } },
    graph: { graphState: placeholder },
  };
  const original = structuredClone(groups);
  assert.deepEqual(excludeComparisonInspection(groups).graph?.graphState, graph);
  assert.deepEqual(groups, original);
});
void test('virtual inspections are excluded while dirty real tabs, snapshots and baselines survive', () => {
  const virtual = 'bundle-comparison:session:1';
  const real = { metadata: { id: 'real', title: 'Real' }, graphs: { real: graph } };
  const groups = {
    project: {
      projectState: { metadata: { id: virtual, title: 'Inspection' }, graphs: {} },
      projectDataState: {},
      loadedProjectState: { path: virtual, loaded: true },
      projectsState: {
        openedProjects: {
          real: { projectId: 'real', fsPath: '/real', title: 'Real', openedGraph: 'real' },
          [virtual]: { projectId: virtual, fsPath: virtual, title: 'Inspection' },
        },
        openedProjectsSortedIds: ['real', virtual],
      },
      openedProjectSnapshotsState: {
        real: { project: real, data: { payload: 'unsaved' } },
        [virtual]: { project: { metadata: { id: virtual }, graphs: {} } },
      },
      projectUnsavedChangesState: { real: true, [virtual]: true },
      savedProjectContentDigestsState: { real: 'baseline', [virtual]: 'temporary' },
    },
    graph: { graphState: placeholder },
    graphBuilder: { graphNavigationStackState: { index: 0, stack: [] } },
  };
  const before = structuredClone(groups);
  const result = excludeComparisonInspection(groups);
  assert.deepEqual(result.project?.projectState, real);
  assert.deepEqual(result.project?.projectDataState, { payload: 'unsaved' });
  assert.deepEqual(result.project?.projectUnsavedChangesState, { real: true });
  assert.deepEqual(result.project?.savedProjectContentDigestsState, { real: 'baseline' });
  assert.deepEqual(result.graph?.graphState, graph);
  assert.doesNotMatch(JSON.stringify(result), /bundle-comparison:|Deleted graph/);
  assert.deepEqual(groups, before);
});
void test('filtering virtual workspace metadata preserves authored payload and context keys', () => {
  const virtual = 'bundle-comparison:session:1';
  const payload = { 'bundle-comparison:asset': 'authored static data' };
  const context = { [virtual]: { value: { type: 'string', value: 'authored context' } } };
  const groups = {
    project: {
      projectState: { metadata: { id: 'real', title: 'Real' }, graphs: { real: graph } },
      projectDataState: payload,
      projectsState: {
        openedProjects: { real: { projectId: 'real' }, [virtual]: { projectId: virtual } },
        openedProjectsSortedIds: ['real', virtual],
      },
      projectEditorStateByProjectId: { real: { view: 'kept' }, [virtual]: { view: 'excluded' } },
      'projectContext__"real"': context,
      [`projectContext__"${virtual}"`]: { temporary: { value: { type: 'string', value: 'excluded' } } },
    },
  };
  const before = structuredClone(groups);
  const result = excludeComparisonInspection(groups);
  assert.deepEqual(result.project?.projectDataState, payload);
  assert.deepEqual(result.project?.['projectContext__"real"'], context);
  assert.deepEqual(result.project?.projectEditorStateByProjectId, { real: { view: 'kept' } });
  assert.equal(Object.hasOwn(result.project!, `projectContext__"${virtual}"`), false);
  assert.deepEqual(groups, before);
});
