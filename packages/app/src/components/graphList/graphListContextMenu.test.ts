import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentType } from 'react';
import type { GraphId, NodeGraph } from '@valerypopoff/rivet2-core';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';
import {
  buildFolderContextMenuItems,
  buildGraphItemContextMenuItems,
  buildGraphListContextMenuItems,
  getGraphListContextMenuTarget,
  type GraphListContextMenuIcons,
} from './graphListContextMenu.js';

const TestIcon = (() => null) as ComponentType;

const icons: GraphListContextMenuIcons = {
  collapseAllFolders: TestIcon,
  renameGraph: TestIcon,
  duplicateGraph: TestIcon,
  copyGraph: TestIcon,
  pasteGraphs: TestIcon,
  expandAllFolders: TestIcon,
  graphInfo: TestIcon,
  makeMainGraph: TestIcon,
  deleteGraph: TestIcon,
  newGraph: TestIcon,
  newFolder: TestIcon,
  importGraph: TestIcon,
};

const graph = (id: string, name: string): NodeGraph => ({
  metadata: { id: id as GraphId, name },
  nodes: [],
  connections: [],
});

function contextMenuData(type: string, dataset: Record<string, string | undefined> = {}): ContextMenuData {
  return {
    x: 1,
    y: 2,
    data: {
      type,
      element: {
        dataset,
      } as HTMLElement,
    },
  };
}

describe('graphListContextMenu', () => {
  it('builds graph item menu items in the existing visible order', () => {
    const items = buildGraphItemContextMenuItems({ icons, isMainGraph: false });

    assert.deepEqual(
      items.map((item) => item.id),
      ['rename-graph', 'duplicate-graph', 'copy-graph', 'graph-info', 'make-main-graph', 'delete-graph'],
    );
    assert.equal(items[4]?.separatorBefore, true);
    assert.equal(items[5]?.tone, 'danger');
    assert.equal(items[5]?.separatorBefore, true);
  });

  it('omits make-main for the current main graph without reordering the rest', () => {
    const items = buildGraphItemContextMenuItems({ icons, isMainGraph: true });

    assert.deepEqual(
      items.map((item) => item.id),
      ['rename-graph', 'duplicate-graph', 'copy-graph', 'graph-info', 'delete-graph'],
    );
    assert.equal(items[4]?.tone, 'danger');
    assert.equal(items[4]?.separatorBefore, true);
  });

  it('builds folder and list root menus in the existing visible order', () => {
    assert.deepEqual(
      buildFolderContextMenuItems({ icons, canCopyFolder: true, canPasteGraphs: true }).map((item) => item.id),
      [
        'rename-folder',
        'new-graph-in-folder',
        'new-folder-in-folder',
        'copy-folder',
        'paste-graphs-in-folder',
        'collapse-all-folders',
        'expand-all-folders',
        'delete-folder',
      ],
    );
    assert.deepEqual(
      buildGraphListContextMenuItems({ hasFolders: true, canPasteGraphs: true, icons }).map((item) => item.id),
      ['new-graph', 'new-folder', 'import-graph', 'paste-graphs-at-root', 'collapse-all-folders', 'expand-all-folders'],
    );
    assert.deepEqual(
      buildGraphListContextMenuItems({ hasFolders: false, canPasteGraphs: false, icons }).map((item) => item.id),
      ['new-graph', 'new-folder', 'import-graph'],
    );
    assert.equal(buildFolderContextMenuItems({ icons, canCopyFolder: false, canPasteGraphs: false }).some((item) => item.id === 'copy-folder'), false);
  });

  it('resolves context-menu targets from captured DOM datasets and saved graphs', () => {
    const savedGraphs = [graph('main', 'Main'), graph('child', 'Folder/Child')];

    assert.deepEqual(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-item', { graphid: 'child', folderpath: 'Folder/Child' }),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      {
        type: 'graph-item',
        graph: savedGraphs[1],
        folderPath: 'Folder/Child',
        isMainGraph: false,
      },
    );
    assert.deepEqual(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-folder', { folderpath: 'Folder' }),
        folderPaths: new Set(['Folder']),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      {
        type: 'graph-folder',
        folderPath: 'Folder',
      },
    );
    assert.deepEqual(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-list'),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      { type: 'graph-list' },
    );
  });

  it('returns null for stale or malformed graph item targets', () => {
    const savedGraphs = [graph('main', 'Main')];

    assert.equal(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-item', { graphid: 'missing', folderpath: 'Missing' }),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      null,
    );
    assert.equal(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-item', { graphid: 'main' }),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      null,
    );
    assert.equal(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-folder', { folderpath: 'Missing' }),
        folderPaths: new Set(['Existing']),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      null,
    );
  });

  it('uses the current saved graph path when a captured graph target path is stale', () => {
    const savedGraphs = [graph('renamed', 'Current/Name')];

    assert.deepEqual(
      getGraphListContextMenuTarget({
        contextMenuData: contextMenuData('graph-item', { graphid: 'renamed', folderpath: 'Old/Name' }),
        mainGraphId: 'main' as GraphId,
        savedGraphs,
      }),
      {
        type: 'graph-item',
        graph: savedGraphs[0],
        folderPath: 'Current/Name',
        isMainGraph: false,
      },
    );
  });
});
