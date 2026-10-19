import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterSubgraphProjectTree,
  findSubgraphProjectBundle,
  subgraphSourceScope,
  type SubgraphProjectTree,
} from './subgraphBundleScope.js';
import type { SubGraphNode, ProjectId } from '@valerypopoff/rivet2-core';

const project = (id: string) => ({ id, projectMetadataId: id, name: id, relativePath: `${id}.rivet-project` });
const tree: SubgraphProjectTree = {
  projects: [project('ordinary')],
  folders: [
    {
      id: 'one',
      name: 'One',
      bundleId: 'one',
      projects: [project('a')],
      folders: [{ id: 'nested', name: 'Nested', projects: [project('b')], folders: [] }],
    },
    { id: 'two', name: 'Two', bundleId: 'two', projects: [project('c')], folders: [] },
    { id: 'ordinary-folder', name: 'Ordinary folder', projects: [project('ordinary-two')], folders: [] },
  ],
};
const ids = (tree: SubgraphProjectTree): string[] => [...tree.projects.map((p) => p.id), ...tree.folders.flatMap(ids)];

test('Same bundle starts at its contents, dropping ordinary ancestors and the bundle wrapper', () => {
  const wrapped: SubgraphProjectTree = {
    projects: [],
    folders: [{ id: 'trash', name: 'Trash', projects: [], folders: tree.folders }],
  };
  const before = structuredClone(wrapped);
  for (const caller of ['a', 'b']) {
    const filtered = filterSubgraphProjectTree(wrapped, caller, 'same-bundle');
    assert.deepEqual(
      filtered.projects.map((p) => p.id),
      ['a'],
    );
    assert.deepEqual(
      filtered.folders.map((f) => f.name),
      ['Nested'],
    );
    assert.deepEqual(ids(filtered), ['a', 'b']);
  }
  assert.deepEqual(wrapped, before, 'projection does not alter the shared catalog');
  assert.equal(filterSubgraphProjectTree(wrapped, 'a', 'other-projects').folders[0]?.name, 'Trash');
  assert.deepEqual(filterSubgraphProjectTree(wrapped, 'missing', 'same-bundle'), { projects: [], folders: [] });
});
test('Same bundle includes nested siblings, while Other projects excludes every bundle', () => {
  assert.equal(findSubgraphProjectBundle(tree, 'b'), 'one');
  assert.equal(findSubgraphProjectBundle(tree, 'ordinary-two'), null);
  assert.deepEqual(ids(filterSubgraphProjectTree(tree, 'a', 'same-bundle')), ['a', 'b']);
  for (const caller of ['a', 'ordinary', 'missing']) {
    assert.deepEqual(ids(filterSubgraphProjectTree(tree, caller, 'other-projects')), ['ordinary', 'ordinary-two']);
  }
  assert.deepEqual(ids(filterSubgraphProjectTree(tree, 'ordinary', 'same-bundle')), []);
  const data = { graphId: 'graph', targetProjectId: 'b' as ProjectId } as SubGraphNode['data'];
  assert.equal(
    subgraphSourceScope(data, tree, 'a'),
    'same-bundle',
    'older saved internal references get the correct picker mode',
  );
  assert.equal(subgraphSourceScope({ ...data, targetProjectId: 'ordinary' as ProjectId }, tree, 'a'), 'other-projects');
  assert.equal(subgraphSourceScope({ graphId: 'graph' } as SubGraphNode['data'], tree, 'a'), 'this-project');
  const converted = structuredClone(tree);
  converted.folders[0]!.bundleId = null;
  assert.equal(
    subgraphSourceScope({ ...data, targetScope: 'same-bundle' }, converted, 'a'),
    'other-projects',
    'converting to an ordinary folder retains usable calls rather than leaving an unavailable source selected',
  );
});

test('current target membership overrides a saved Same bundle hint without changing the target', () => {
  const data = {
    graphId: 'graph',
    targetProjectId: 'b' as ProjectId,
    targetScope: 'same-bundle',
  } as SubGraphNode['data'];
  assert.equal(subgraphSourceScope(data, null, 'a'), 'same-bundle', 'keep the hint while loading membership');
  assert.equal(subgraphSourceScope(data, tree, 'a'), 'same-bundle');
  const moved = structuredClone(tree);
  moved.folders[0]!.folders[0]!.projects = [];
  moved.projects.push(project('b'));
  assert.equal(subgraphSourceScope(data, moved, 'a'), 'other-projects', 'moved target remains callable as ordinary');
  assert.equal(
    subgraphSourceScope({ ...data, targetProjectId: 'c' as ProjectId }, tree, 'a'),
    'other-projects',
    'a stale hint must not present a foreign bundle target as a sibling',
  );
  assert.equal(subgraphSourceScope({ ...data, targetProjectId: undefined }, tree, 'a'), 'same-bundle');
  assert.equal(data.targetProjectId, 'b', 'source projection never edits authored references');
});
