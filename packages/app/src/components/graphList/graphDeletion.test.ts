import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, NodeGraph, ProjectId } from '@valerypopoff/rivet2-core';
import { getFolderDeletionGraphIds, isGraphDeletionRequestCurrent } from './graphDeletion.js';

const graph = (id: string, name: string): NodeGraph => ({
  metadata: { id: id as GraphId, name },
  nodes: [],
  connections: [],
});
test('folder review includes only exact descendants and rejects changed ownership/membership', () => {
  const graphs = [graph('a', 'Group/A'), graph('b', 'Group/Nested/B'), graph('c', 'Groupish/C')];
  const request = {
    projectId: 'project' as ProjectId,
    folderPath: 'Group',
    name: 'Group',
    graphIds: getFolderDeletionGraphIds(graphs, 'Group'),
  };
  assert.deepEqual(request.graphIds, ['a', 'b']);
  assert.equal(isGraphDeletionRequestCurrent(request, request.projectId, [...graphs].reverse()), true);
  assert.equal(isGraphDeletionRequestCurrent(request, 'other' as ProjectId, graphs), false);
  assert.equal(
    isGraphDeletionRequestCurrent(request, request.projectId, [...graphs, graph('new', 'Group/New')]),
    false,
  );
  assert.equal(isGraphDeletionRequestCurrent(request, request.projectId, [graphs[0]!, graphs[2]!]), false);
  assert.equal(
    isGraphDeletionRequestCurrent(
      { ...request, folderPath: undefined, graphIds: ['a' as GraphId] },
      request.projectId,
      graphs,
    ),
    true,
  );
  assert.equal(
    isGraphDeletionRequestCurrent(
      { ...request, folderPath: undefined, graphIds: ['gone' as GraphId] },
      request.projectId,
      graphs,
    ),
    false,
  );
});
