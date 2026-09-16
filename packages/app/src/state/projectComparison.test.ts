import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai/vanilla';
import type { ChartNode, GraphId, NodeId, Project } from '@valerypopoff/rivet2-core';
import { graphState } from './graph.js';
import { projectState } from './savedGraphs.js';
import { projectCompareReferenceState, viewingProjectComparisonNodeState } from './projectComparison.js';

test('inspection belongs to the reference identity and active project, not reused node IDs', () => {
  const store = createStore();
  const graphId = 'graph' as GraphId;
  const nodeId = 'node' as NodeId;
  const currentNode: ChartNode = {
    id: nodeId,
    type: 'text',
    title: 'Text',
    data: { text: 'current' },
    visualData: { x: 0, y: 0 },
  };
  const referenceNode: ChartNode = { ...currentNode, data: { text: 'reference' } };
  const project = {
    metadata: { id: 'current' as Project['metadata']['id'], title: '', description: '' },
    graphs: { [graphId]: { metadata: { id: graphId, name: 'Graph' }, nodes: [currentNode], connections: [] } },
  } as Project;
  const referenceProject = {
    ...project,
    graphs: { [graphId]: { ...project.graphs[graphId]!, nodes: [referenceNode] } },
  } as Project;
  const first = { projectId: project.metadata.id, referenceProject };
  const second = { ...first };
  const target = { graphId, nodeId };
  store.set(projectState, project);
  store.set(graphState, project.graphs[graphId]!);
  store.set(projectCompareReferenceState, first);
  store.set(viewingProjectComparisonNodeState, { ...target, reference: first });
  assert.equal(store.get(viewingProjectComparisonNodeState)?.reference, first);
  store.set(projectCompareReferenceState, second);
  assert.equal(store.get(viewingProjectComparisonNodeState), undefined);
  store.set(viewingProjectComparisonNodeState, { ...target, reference: first });
  assert.equal(
    store.get(viewingProjectComparisonNodeState),
    undefined,
    'late callback cannot target replacement reference',
  );
  store.set(viewingProjectComparisonNodeState, target);
  assert.equal(
    store.get(viewingProjectComparisonNodeState)?.reference,
    second,
    'existing changed-node caller still works',
  );
  store.set(projectState, { ...project, metadata: { ...project.metadata, id: 'other' as Project['metadata']['id'] } });
  assert.equal(store.get(viewingProjectComparisonNodeState), undefined);
  store.set(viewingProjectComparisonNodeState, undefined);
  store.set(projectState, project);
  store.set(graphState, project.graphs[graphId]!);
  assert.equal(store.get(viewingProjectComparisonNodeState), undefined);
  store.set(projectCompareReferenceState, undefined);
  store.set(viewingProjectComparisonNodeState, { ...target, reference: second });
  assert.equal(store.get(viewingProjectComparisonNodeState), undefined);
});

test('inspection closes when its node no longer differs during the same compare session', () => {
  const store = createStore();
  const graphId = 'graph' as GraphId;
  const nodeId = 'node' as NodeId;
  const referenceNode: ChartNode = {
    id: nodeId,
    type: 'text',
    title: 'Text',
    data: { text: 'reference' },
    visualData: { x: 0, y: 0 },
  };
  const project = {
    metadata: { id: 'current' as Project['metadata']['id'], title: '', description: '' },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph' },
        nodes: [{ ...referenceNode, data: { text: 'current' } }],
        connections: [],
      },
    },
  } as Project;
  const reference = {
    projectId: project.metadata.id,
    referenceProject: { ...project, graphs: { [graphId]: { ...project.graphs[graphId]!, nodes: [referenceNode] } } },
  };
  store.set(projectState, project);
  store.set(graphState, project.graphs[graphId]!);
  store.set(projectCompareReferenceState, reference);
  store.set(viewingProjectComparisonNodeState, { graphId, nodeId, reference });
  assert.notEqual(store.get(viewingProjectComparisonNodeState), undefined);

  store.set(graphState, reference.referenceProject.graphs[graphId]!);
  assert.equal(store.get(viewingProjectComparisonNodeState), undefined);
});
