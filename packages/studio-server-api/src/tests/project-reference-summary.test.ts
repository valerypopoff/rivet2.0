import assert from 'node:assert/strict';
import test from 'node:test';
import { SubGraphNodeImpl, type Project, type ProjectId, type GraphId } from '@valerypopoff/rivet2-core';
import { summarizeProjectReferences } from '../routes/workflows/project-reference-summary.js';

function callerProject() {
  const call = SubGraphNodeImpl.create();
  call.data.targetProjectId = 'target' as ProjectId;
  call.data.graphId = 'shared' as GraphId;
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: 'Caller', description: '' },
    graphs: {
      ['main' as GraphId]: { metadata: { id: 'main' as GraphId, name: 'Caller' }, connections: [], nodes: [call] },
    },
  };
  return { project, call };
}

test('graph-only extraction failures preserve whole-project dependencies', () => {
  const { project } = callerProject();
  const local = SubGraphNodeImpl.create();
  local.data.targetVersion = 'invalid' as never;
  project.graphs['main' as GraphId]!.nodes.push(local);
  const summary = summarizeProjectReferences(project);
  assert.equal(summary.state, 'complete');
  if (summary.state !== 'complete') throw new Error('Expected project summary');
  assert.equal(summary.graphCalls, null);
  assert.deepEqual(summary.projectTargets, [{ projectId: 'target', version: 'latest' }]);
});

test('unsupported PostgreSQL text cannot make advisory indexing reject a save', () => {
  for (const title of ['bad\0title', 'bad\ud800title', 'bad\udc00title']) {
    const { project, call } = callerProject();
    call.title = title;
    const summary = summarizeProjectReferences(project);
    assert.equal(summary.state, 'complete');
    if (summary.state !== 'complete') throw new Error('Expected project summary');
    assert.equal(summary.graphCalls, null);
    assert.deepEqual(summary.projectTargets, [{ projectId: 'target', version: 'latest' }]);
  }
  for (const title of ['A valid emoji 😀', 'literal \\u0000']) {
    const { project, call } = callerProject();
    call.title = title;
    const summary = summarizeProjectReferences(project);
    assert.equal(summary.state, 'complete');
    if (summary.state !== 'complete') throw new Error('Expected graph summary');
    assert.equal(summary.graphCalls![0]!.nodeTitle, call.title);
  }
});

test('bundle-only errors do not erase graph callers or mark graph coverage incomplete', () => {
  const call = SubGraphNodeImpl.create();
  call.data.targetProjectId = 'target' as ProjectId;
  call.data.graphId = 'shared' as GraphId;
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: 'Caller', description: '' },
    graphs: {
      ['main' as GraphId]: {
        metadata: { id: 'main' as GraphId, name: 'Caller' },
        connections: [],
        nodes: [
          call,
          { ...call, id: 'missing' as typeof call.id, type: 'nodePrefabInstance', data: { prefabId: 'absent' } },
        ],
      },
    },
  };
  const summary = summarizeProjectReferences(project);
  assert.equal(summary.state, 'complete');
  if (summary.state !== 'complete') throw new Error('Expected graph summary');
  assert.equal(summary.graphCalls?.length, 1);
  assert.equal(summary.graphCalls![0]!.targetProjectId, 'target');
  assert.equal(summary.projectTargets, null);
  call.data.targetVersion = 'invalid' as never;
  assert.deepEqual(summarizeProjectReferences(project), {
    version: 1,
    state: 'invalid',
    reason: 'invalid-project',
    projectId: 'caller',
  });
});

test('oversized summaries are explicit failures and never silently truncated', () => {
  const call = SubGraphNodeImpl.create();
  call.title = 'x'.repeat(4 * 1024 * 1024);
  call.data.targetProjectId = 'target' as ProjectId;
  call.data.graphId = 'shared' as GraphId;
  const project: Project = {
    metadata: { id: 'caller' as ProjectId, title: 'Caller', description: '' },
    graphs: {
      ['main' as GraphId]: { metadata: { id: 'main' as GraphId, name: 'Caller' }, connections: [], nodes: [call] },
    },
  };
  assert.deepEqual(summarizeProjectReferences(project), {
    version: 1,
    state: 'invalid',
    reason: 'summary-too-large',
    projectId: 'caller',
  });
});
