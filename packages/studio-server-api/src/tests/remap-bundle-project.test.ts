import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectId } from '@valerypopoff/rivet2-node';
import { remapBundleProject } from '../routes/workflows/remap-bundle-project.js';

test('bundle copy remaps members, prefab sources and variants without changing external references or authoring IDs', () => {
  const call = {
    id: 'node',
    type: 'subGraph',
    data: { targetProjectId: 'b', targetVersion: 'published' },
    variants: [
      { data: { targetProjectId: 'external', targetVersion: 'published' } },
      { data: null },
      { data: 'unfinished' },
    ],
  };
  const project = {
    metadata: { id: 'a', path: '/old' },
    graphs: { main: { nodes: [call] } },
    nodePrefabs: { p: { sourceNode: { type: 'referencedGraphAlias', data: { projectId: 'b' } } } },
    references: [
      { id: 'b', hintPaths: ['old'] },
      { id: 'external', hintPaths: ['external-path'] },
    ],
  } as unknown as Project;
  const external = remapBundleProject(
    project,
    new Map([
      ['a', 'copy-a' as ProjectId],
      ['b', 'copy-b' as ProjectId],
    ]),
  );
  assert.equal(project.metadata.id, 'copy-a');
  assert.equal(project.metadata.path, undefined);
  assert.deepEqual(project.references, [{ id: 'copy-b' }, { id: 'external', hintPaths: ['external-path'] }]);
  assert.deepEqual(call.data, { targetProjectId: 'copy-b', targetVersion: 'latest' });
  assert.equal(call.id, 'node');
  assert.deepEqual(call.variants[0]!.data, { targetProjectId: 'external', targetVersion: 'published' });
  assert.equal((Object.values(project.nodePrefabs!)[0]!.sourceNode.data as { projectId: string }).projectId, 'copy-b');
  assert.deepEqual([...external], ['external']);
});
