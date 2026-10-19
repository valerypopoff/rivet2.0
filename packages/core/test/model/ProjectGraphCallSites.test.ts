import assert from 'node:assert/strict';
import test from 'node:test';
import { listProjectGraphCallSites } from '../../src/model/ProjectGraphCallSites.js';
import { SubGraphNodeImpl, ReferencedGraphAliasNodeImpl } from '../../src/index.js';
import type { Project, ProjectId, NodePrefabId } from '../../src/model/Project.js';
import type { GraphId } from '../../src/model/NodeGraph.js';

test('call sites retain graph and node identity, explicit version and prefab instance location', () => {
  const source = SubGraphNodeImpl.create();
  source.title = 'Current library caller';
  source.data.targetProjectId = 'other' as ProjectId;
  source.data.graphId = 'coincident-id' as GraphId;
  source.data.targetVersion = 'published';
  const local = SubGraphNodeImpl.create();
  local.data.graphId = source.data.graphId;
  const disabled = { ...source, disabled: true };
  const alias = ReferencedGraphAliasNodeImpl.create();
  alias.data.projectId = 'legacy' as ProjectId;
  alias.data.graphId = source.data.graphId;
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: 'Caller', description: '' },
    graphs: {
      ['source' as GraphId]: {
        metadata: { id: 'source' as GraphId, name: 'Folder/Caller' },
        connections: [],
        nodes: [
          source,
          local,
          disabled,
          alias,
          {
            ...source,
            id: 'instance' as typeof source.id,
            title: 'Outdated instance title',
            type: 'nodePrefabInstance',
            data: { prefabId: 'prefab' },
          },
        ],
      },
    },
    nodePrefabs: { ['prefab' as NodePrefabId]: { id: 'prefab' as NodePrefabId, sourceNode: source } },
  };
  const calls = listProjectGraphCallSites(project);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => [call.nodeId, call.targetProjectId, call.targetGraphId, call.targetVersion]),
    [
      [source.id, 'other', 'coincident-id', 'published'],
      [alias.id, 'legacy', 'coincident-id', 'project-reference'],
      ['instance', 'other', 'coincident-id', 'published'],
    ],
  );
  assert.ok(calls.every((call) => call.sourceGraphId === 'source' && call.sourceGraphName === 'Folder/Caller'));
  assert.equal(calls[2]!.nodeTitle, 'Current library caller');
  source.data.targetVersion = undefined;
  assert.equal(listProjectGraphCallSites(project)[0]!.targetVersion, 'latest');
});

test('missing library definitions are ignored without hiding calls before or after them', () => {
  const source = SubGraphNodeImpl.create();
  source.data.targetProjectId = 'target' as ProjectId;
  source.data.graphId = 'target-graph' as GraphId;
  const missing = { ...source, type: 'nodePrefabInstance', data: { prefabId: 'missing' } };
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: '', description: '' },
    graphs: {
      ['main' as GraphId]: {
        nodes: [missing, source, { ...missing, data: {} }, { ...source, id: 'after' as typeof source.id }],
        connections: [],
      },
    },
  };
  assert.deepEqual(
    listProjectGraphCallSites(project).map((call) => call.nodeId),
    [source.id, 'after'],
  );
  project.graphs['main' as GraphId]!.nodes = [missing];
  assert.deepEqual(listProjectGraphCallSites(project), []);
  assert.equal(missing.type, 'nodePrefabInstance', 'Discovery must not repair or mutate authored nodes');
});
