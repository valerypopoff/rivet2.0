import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyNodeGraph, type GraphId, type NodeGraph, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { buildOpenedProjectSnapshot } from './openedProjectSnapshots.js';

function makeGraph(id: string, name: string, nodes: NodeGraph['nodes'] = []): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name,
      description: '',
    },
    nodes,
    connections: [],
  };
}

function makeProject(graphs: NodeGraph[]): Omit<Project, 'data'> {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    plugins: [],
  };
}

describe('openedProjectSnapshots', () => {
  test('buildOpenedProjectSnapshot replaces the matching graph with the provided current graph', () => {
    const originalGraph = makeGraph('g-1', 'Original');
    const updatedGraph = makeGraph('g-1', 'Original', [{ id: 'node-1' } as any]);
    const project = makeProject([originalGraph]);

    const snapshot = buildOpenedProjectSnapshot({
      project,
      graph: updatedGraph,
    });

    assert.equal(snapshot.project.graphs['g-1' as GraphId], updatedGraph);
    assert.notEqual(snapshot.project, project);
  });

  test('buildOpenedProjectSnapshot preserves other graphs unchanged', () => {
    const updatedGraph = makeGraph('g-1', 'Alpha', [{ id: 'node-1' } as any]);
    const untouchedGraph = makeGraph('g-2', 'Beta');
    const project = makeProject([makeGraph('g-1', 'Alpha'), untouchedGraph]);

    const snapshot = buildOpenedProjectSnapshot({
      project,
      graph: updatedGraph,
    });

    assert.equal(snapshot.project.graphs['g-1' as GraphId], updatedGraph);
    assert.equal(snapshot.project.graphs['g-2' as GraphId], untouchedGraph);
  });

  test('buildOpenedProjectSnapshot preserves project data', () => {
    const graph = makeGraph('g-1', 'Alpha');
    const data = {
      'data-1': JSON.stringify({ value: 1 }),
    };

    const snapshot = buildOpenedProjectSnapshot({
      project: makeProject([graph]),
      graph,
      data,
    });

    assert.deepEqual(snapshot.data, data);
  });

  test('buildOpenedProjectSnapshot does not persist a temporary empty graph after all project graphs were deleted', () => {
    const project = makeProject([]);

    const snapshot = buildOpenedProjectSnapshot({
      project,
      graph: emptyNodeGraph(),
    });

    assert.deepEqual(snapshot.project.graphs, {});
  });
});
