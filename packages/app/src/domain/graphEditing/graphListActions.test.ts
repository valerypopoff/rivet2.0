import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';
import {
  buildNewFolderPath,
  buildUniqueNewFolderPath,
  buildUntitledGraph,
  deleteFolderGraphs,
  getAncestorFolderPaths,
  renameFolderItemInGraphs,
} from './graphListActions';

function makeGraph(id: string, name: string): NodeGraph {
  return {
    metadata: { id: id as GraphId, name, description: '' },
    nodes: [],
    connections: [],
  };
}

test('buildUntitledGraph increments names within a folder', () => {
  const graphs = [makeGraph('g-1', 'folder/Untitled graph')];
  const graph = buildUntitledGraph(graphs, 'folder');

  assert.equal(graph.metadata?.name, 'folder/Untitled graph 2');
});

test('buildNewFolderPath creates nested folder names', () => {
  assert.equal(buildNewFolderPath('parent'), 'parent/New Folder');
  assert.equal(buildNewFolderPath(), 'New Folder');
});

test('buildUniqueNewFolderPath increments folder names within the same parent', () => {
  assert.equal(buildUniqueNewFolderPath(undefined, ['New Folder'], []), 'New Folder 2');
  assert.equal(buildUniqueNewFolderPath('parent', ['parent/New Folder'], []), 'parent/New Folder 2');
  assert.equal(buildUniqueNewFolderPath('parent', ['parent/New Folder', 'parent/New Folder 2'], []), 'parent/New Folder 3');
});

test('getAncestorFolderPaths returns parent folders from outermost to innermost', () => {
  assert.deepEqual(getAncestorFolderPaths('Graph'), []);
  assert.deepEqual(getAncestorFolderPaths('Folder/Graph'), ['Folder']);
  assert.deepEqual(getAncestorFolderPaths('Folder/Nested/Graph'), ['Folder', 'Folder/Nested']);
});

test('deleteFolderGraphs removes graphs within the folder subtree', () => {
  const graphs = [makeGraph('g-1', 'folder/One'), makeGraph('g-2', 'other/Two')];
  const remaining = deleteFolderGraphs(graphs, 'folder');

  assert.deepEqual(remaining.map((graph) => graph.metadata?.id), ['g-2']);
});

test('deleteFolderGraphs also removes nested folder descendants', () => {
  const graphs = [makeGraph('g-1', 'folder/nested/One'), makeGraph('g-2', 'folderTwo/Two')];
  const remaining = deleteFolderGraphs(graphs, 'folder');

  assert.deepEqual(remaining.map((graph) => graph.metadata?.id), ['g-2']);
});

test('renameFolderItemInGraphs renames matching graph paths and folder names', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder',
    newFullPath: 'renamed',
    savedGraphs: [makeGraph('g-1', 'folder/One')],
    currentGraph: makeGraph('g-1', 'folder/One'),
    folderNames: ['folder'],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'renamed/One');
  assert.equal(result.currentGraph.metadata?.name, 'renamed/One');
  assert.deepEqual(result.folderNames, ['renamed']);
});

test('renameFolderItemInGraphs leaves unrelated current graph names unchanged', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder',
    newFullPath: 'renamed',
    savedGraphs: [makeGraph('g-1', 'folder/One')],
    currentGraph: makeGraph('g-2', 'other/folderish/Two'),
    folderNames: ['folder'],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'renamed/One');
  assert.equal(result.currentGraph.metadata?.name, 'other/folderish/Two');
  assert.deepEqual(result.folderNames, ['renamed']);
});

test('renameFolderItemInGraphs preserves the source folder when moving a graph out of it', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder/One',
    newFullPath: 'One',
    savedGraphs: [makeGraph('g-1', 'folder/One')],
    currentGraph: makeGraph('g-1', 'folder/One'),
    folderNames: [],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'One');
  assert.equal(result.currentGraph.metadata?.name, 'One');
  assert.deepEqual(result.folderNames, ['folder']);
});

test('renameFolderItemInGraphs does not preserve the source folder while it still has graphs', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder/One',
    newFullPath: 'One',
    savedGraphs: [makeGraph('g-1', 'folder/One'), makeGraph('g-2', 'folder/Two')],
    currentGraph: makeGraph('g-1', 'folder/One'),
    folderNames: [],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'One');
  assert.equal(result.savedGraphs[1]?.metadata?.name, 'folder/Two');
  assert.deepEqual(result.folderNames, []);
});

test('renameFolderItemInGraphs does not preserve the source folder when a renamed graph stays inside it', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder/One',
    newFullPath: 'folder/Renamed',
    savedGraphs: [makeGraph('g-1', 'folder/One')],
    currentGraph: makeGraph('g-1', 'folder/One'),
    folderNames: [],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'folder/Renamed');
  assert.equal(result.currentGraph.metadata?.name, 'folder/Renamed');
  assert.deepEqual(result.folderNames, []);
});

test('renameFolderItemInGraphs does not preserve old parent folders when renaming folders', () => {
  const result = renameFolderItemInGraphs({
    fullPath: 'folder/nested',
    newFullPath: 'folder/renamed',
    savedGraphs: [makeGraph('g-1', 'folder/nested/One')],
    currentGraph: makeGraph('g-1', 'folder/nested/One'),
    folderNames: [],
  });

  assert.ok(!('error' in result));
  if ('error' in result) {
    return;
  }

  assert.equal(result.savedGraphs[0]?.metadata?.name, 'folder/renamed/One');
  assert.equal(result.currentGraph.metadata?.name, 'folder/renamed/One');
  assert.deepEqual(result.folderNames, []);
});
