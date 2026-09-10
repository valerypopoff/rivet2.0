import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadProjectReferenceTree,
  type GraphId,
  type Project,
  type ProjectId,
  type ProjectReference,
} from '../../src/index.js';

function project(id: string, references: ProjectReference[] = []): Project {
  const graphId = `${id}-graph` as GraphId;
  return {
    metadata: { id: id as ProjectId, title: id, description: '', mainGraphId: graphId },
    graphs: { [graphId]: { metadata: { id: graphId, name: id, description: '' }, nodes: [], connections: [] } },
    plugins: [],
    references,
  };
}

test('loads a reference closure depth-first and deduplicates shared references', async () => {
  const shared = project('shared');
  const first = project('first', [{ id: 'shared' as ProjectId }]);
  const second = project('second', [{ id: 'shared' as ProjectId }]);
  const root = project('root', [{ id: 'first' as ProjectId }, { id: 'second' as ProjectId }]);
  const projects = { first, second, shared };
  const requests: string[] = [];

  const loaded = await loadProjectReferenceTree(root, '/workflows/root.rivet-project', {
    async loadProject(path, reference) {
      assert.equal(path, '/workflows/root.rivet-project');
      requests.push(reference.id);
      return projects[reference.id as keyof typeof projects]!;
    },
  });

  assert.deepEqual(requests, ['first', 'shared', 'second']);
  assert.deepEqual(Object.keys(loaded), ['first', 'shared', 'second']);
});

test('keeps legacy root back-edges in memory and rejects mismatched identities before publishing', async () => {
  const root = project('root', [{ id: 'child' as ProjectId }]);
  const cyclicChild = project('child', [{ id: 'root' as ProjectId }]);

  const cycleRequests: string[] = [];
  const loadedCycle = await loadProjectReferenceTree(root, '/workflows/root.rivet-project', {
    async loadProject(_path, reference) {
      cycleRequests.push(reference.id);
      assert.equal(reference.id, 'child');
      return cyclicChild;
    },
  });
  assert.deepEqual(cycleRequests, ['child']);
  assert.deepEqual(Object.keys(loadedCycle), ['child']);

  await assert.rejects(
    () =>
      loadProjectReferenceTree(root, '/workflows/root.rivet-project', {
        async loadProject() {
          return project('different');
        },
      }),
    /loaded a project with ID "different"/,
  );
});

test('keeps prototype-like project IDs as loaded references', async () => {
  const referenced = project('__proto__');
  const root = project('root', [{ id: '__proto__' as ProjectId }]);

  const loaded = await loadProjectReferenceTree(root, undefined, {
    async loadProject() {
      return referenced;
    },
  });

  assert.equal(Object.hasOwn(loaded, '__proto__'), true);
  assert.equal(loaded['__proto__' as ProjectId]!.metadata.id, '__proto__');
});
