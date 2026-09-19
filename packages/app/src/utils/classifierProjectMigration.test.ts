import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, NodeGraph, NodeId, Project } from '@valerypopoff/rivet2-core';
import {
  normalizeClassifierGraphForAppState,
  normalizeClassifierProjectForAppState,
} from './classifierProjectMigration.js';

test('app-state classifier migration copies only legacy project and graph snapshots', () => {
  const graphId = 'main' as GraphId;
  const legacyGraph = makeLegacyGraph();
  const legacyProject = {
    graphs: { [graphId]: legacyGraph },
    metadata: { description: '', id: 'legacy-project' as never, mainGraphId: graphId, title: 'Legacy' },
    plugins: [{ type: 'built-in' as const, id: 'typesafe', name: 'TypeSafe AI (Jev)' }],
  } as Project;

  const normalizedProject = normalizeClassifierProjectForAppState(legacyProject);
  const normalizedGraph = normalizeClassifierGraphForAppState(legacyGraph);

  assert.notEqual(normalizedProject, legacyProject);
  assert.equal(normalizedProject.graphs[graphId]?.nodes[0]?.type, 'classifierQuestion');
  assert.deepEqual(normalizedProject.plugins, []);
  assert.equal(legacyProject.graphs[graphId]?.nodes[0]?.type, 'jevNoulQuestion');
  assert.equal(legacyProject.plugins?.[0]?.id, 'typesafe');
  assert.notEqual(normalizedGraph, legacyGraph);
  assert.equal(normalizedGraph.nodes[0]?.type, 'classifierQuestion');
  assert.equal(legacyGraph.nodes[0]?.type, 'jevNoulQuestion');

  const currentProject = { ...normalizedProject, graphs: { ...normalizedProject.graphs } };
  const currentGraph = { ...normalizedGraph, nodes: [...normalizedGraph.nodes] };
  assert.equal(normalizeClassifierProjectForAppState(currentProject), currentProject);
  assert.equal(normalizeClassifierGraphForAppState(currentGraph), currentGraph);
});

function makeLegacyGraph(): NodeGraph {
  return {
    connections: [],
    metadata: { id: 'main' as never, name: 'Main' },
    nodes: [
      {
        data: { instructions: 'Route?', questionId: 'route' },
        id: 'legacy-question' as NodeId,
        title: 'Jev Noul Question',
        type: 'jevNoulQuestion',
        visualData: { x: 0, y: 0 },
      },
    ],
  };
}
