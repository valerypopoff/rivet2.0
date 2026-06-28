import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChartNode, GraphId, NodeId, NodePrefabId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { canUseNodeAsPrefabSource, getNodePrefabUsage, getNodePrefabUsageLabel } from './nodePrefabs.js';

function node(id: string, type = 'text'): ChartNode {
  return {
    id: id as NodeId,
    type,
    title: id,
    visualData: { x: 0, y: 0 },
    data: {},
  };
}

test('Node Library rules block non-runnable and linked nodes', () => {
  assert.equal(canUseNodeAsPrefabSource(node('text')), true);
  assert.equal(canUseNodeAsPrefabSource(node('comment', 'comment')), false);
  assert.equal(canUseNodeAsPrefabSource(node('input', 'graphInput')), false);
  assert.equal(canUseNodeAsPrefabSource(node('output', 'graphOutput')), false);
  assert.equal(canUseNodeAsPrefabSource(node('instance', 'nodePrefabInstance')), false);
});

test('Node Library usage detection finds linked nodes across graphs', () => {
  const prefabId = 'prefab-text' as NodePrefabId;
  const graphAId = 'graphA' as GraphId;
  const graphBId = 'graphB' as GraphId;
  const project: Project = {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: {
      [graphAId]: {
        metadata: { id: graphAId, name: 'Folder/Graph A', description: '' },
        nodes: [
          {
            ...node('instance-a', 'nodePrefabInstance'),
            data: { prefabId },
          },
        ],
        connections: [],
      },
      [graphBId]: {
        metadata: { id: graphBId, name: 'Graph B', description: '' },
        nodes: [
          {
            ...node('instance-b', 'nodePrefabInstance'),
            data: { prefabId: 'other-prefab' },
          },
          {
            ...node('malformed-instance', 'nodePrefabInstance'),
            data: { prefabId: '' },
          },
        ],
        connections: [],
      },
    },
    nodePrefabs: {},
    plugins: [],
  };

  const usages = getNodePrefabUsage(project, prefabId);

  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.nodeId, 'instance-a');
  assert.equal(getNodePrefabUsageLabel(usages[0]!), 'Folder/Graph A (instance-a)');
});

test('Node Library usage detection prefers a live graph over a stale project graph', () => {
  const prefabId = 'prefab-text' as NodePrefabId;
  const graphId = 'graphA' as GraphId;
  const project: Project = {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Graph A', description: '' },
        nodes: [],
        connections: [],
      },
    },
    nodePrefabs: {},
    plugins: [],
  };
  const liveGraph = {
    metadata: { id: graphId, name: 'Graph A', description: '' },
    nodes: [
      {
        ...node('live-instance', 'nodePrefabInstance'),
        data: { prefabId },
      },
    ],
    connections: [],
  };

  const usages = getNodePrefabUsage(project, prefabId, [liveGraph]);

  assert.deepEqual(usages.map((usage) => usage.nodeId), ['live-instance']);
});
