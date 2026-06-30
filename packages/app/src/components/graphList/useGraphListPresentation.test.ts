import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareProjects,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type Project,
  type ProjectId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';
import type { ActiveProjectComparison } from '../../state/projectComparison.js';
import {
  getGraphCompareKindByGraphId,
  getFolderItemPresentation,
  getGraphListContextMenuPresentation,
  getGraphListItemPath,
  getGraphListVisiblePresentation,
  graphMatchesFilter,
  mergeGraphListCurrentGraphIntoProject,
} from './useGraphListPresentation.js';
import { getGraphIdsReferencingGraph, getGraphReachabilityReport } from '../../utils/graphReachability.js';
import { createFoldersFromGraphs, type NodeGraphFolderItem } from './graphFolders.js';

const graph = (id: string, name: string): NodeGraph => ({
  metadata: { id: id as GraphId, name },
  nodes: [],
  connections: [],
});

const node = (id: string, type: string, data: Record<string, unknown> = {}): ChartNode => ({
  id: id as NodeId,
  type,
  title: type,
  visualData: { x: 0, y: 0 },
  data,
});

const project = (graphs: NodeGraph[], mainGraphId: string): Project =>
  ({
    metadata: {
      id: 'project-id' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: mainGraphId as GraphId,
    },
    graphs: Object.fromEntries(graphs.map((entry) => [entry.metadata!.id!, entry])),
    plugins: [],
  }) as Project;

function comparison(before: Project, after: Project): ActiveProjectComparison {
  return {
    projectId: after.metadata.id as ProjectId,
    referenceProject: before,
    comparison: compareProjects(before, after),
  };
}

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

function sortGraphIds(graphIds: Set<GraphId>): string[] {
  return [...graphIds].sort();
}

describe('graph list presentation helpers', () => {
  it('uses the live current graph when computing graph reachability', () => {
    const savedMain = graph('main', 'Main');
    const target = graph('target', 'Target');
    const currentMain = {
      ...savedMain,
      nodes: [node('subgraph', 'subGraph', { graphId: 'target' as GraphId })],
    };
    const staleReport = getGraphReachabilityReport(project([savedMain, target], 'main'));
    const liveReport = getGraphReachabilityReport(
      mergeGraphListCurrentGraphIntoProject(project([savedMain, target], 'main'), currentMain),
    );

    assert.deepEqual(sortGraphIds(staleReport.unreachable), ['target']);
    assert.deepEqual(sortGraphIds(liveReport.unreachable), []);
  });

  it('uses the live current graph when computing graph reference indicators', () => {
    const savedMain = graph('main', 'Main');
    const target = graph('target', 'Target');
    const currentMain = {
      ...savedMain,
      nodes: [node('subgraph', 'subGraph', { graphId: 'target' as GraphId })],
    };
    const baseProject = project([savedMain, target], 'main');
    const liveProject = mergeGraphListCurrentGraphIntoProject(baseProject, currentMain);

    assert.deepEqual(sortGraphIds(getGraphIdsReferencingGraph(baseProject, 'target' as GraphId)), []);
    assert.deepEqual(sortGraphIds(getGraphIdsReferencingGraph(liveProject, 'target' as GraphId)), ['main']);
  });

  it('does not add an unsaved current graph to graph-list reachability analysis', () => {
    const savedMain = graph('main', 'Main');
    const draftGraph = graph('draft', 'Draft');
    const baseProject = project([savedMain], 'main');

    assert.equal(mergeGraphListCurrentGraphIntoProject(baseProject, draftGraph), baseProject);
  });

  it('derives visible folders with comparison-removed graphs and folder paths', () => {
    const savedMain = graph('main', 'Main');
    const removedGraph = graph('removed', 'Archive/Removed');
    const beforeProject = project([savedMain, removedGraph], 'main');
    const afterProject = project([savedMain], 'main');
    const visible = getGraphListVisiblePresentation({
      activeComparison: comparison(beforeProject, afterProject),
      allFolderPaths: [],
      folderedGraphs: createFoldersFromGraphs([savedMain], []),
      searchText: '',
    });

    assert.equal(visible.hasFolders, true);
    assert.deepEqual(visible.folderPaths, ['Archive']);
    assert.deepEqual(
      visible.folderedGraphs.map((item) => (item.type === 'folder' ? item.fullPath : item.name)),
      ['Archive', 'Main'],
    );

    const archiveFolder = visible.folderedGraphs.find((item) => item.type === 'folder' && item.fullPath === 'Archive');
    assert.equal(archiveFolder?.type, 'folder');
    assert.equal(archiveFolder?.children[0]?.type, 'graph');
    assert.equal(archiveFolder?.children[0]?.isComparisonGhost, true);
    assert.equal(archiveFolder?.children[0]?.compareChangeKind, 'removed');
  });

  it('filters comparison-removed graphs with the same graph-list search policy', () => {
    const removedGraph = {
      ...graph('removed', 'Archive/Removed'),
      metadata: {
        ...graph('removed', 'Archive/Removed').metadata,
        description: 'Kept by description',
      },
    };
    const beforeProject = project([graph('main', 'Main'), removedGraph], 'main');
    const afterProject = project([graph('main', 'Main')], 'main');

    assert.equal(graphMatchesFilter(removedGraph, 'description'), true);
    assert.equal(graphMatchesFilter(removedGraph, 'does-not-match'), false);

    const visible = getGraphListVisiblePresentation({
      activeComparison: comparison(beforeProject, afterProject),
      allFolderPaths: [],
      folderedGraphs: createFoldersFromGraphs([graph('main', 'Main')], []),
      searchText: 'does-not-match',
    });

    assert.equal(visible.hasFolders, false);
    assert.deepEqual(
      visible.folderedGraphs.map((item) => (item.type === 'folder' ? item.fullPath : item.name)),
      ['Main'],
    );
  });

  it('derives graph compare kinds without including unchanged graphs', () => {
    const mainBefore = graph('main', 'Main');
    const mainAfter = {
      ...mainBefore,
      metadata: {
        ...mainBefore.metadata,
        description: 'Changed',
      },
    };
    const beforeProject = project([mainBefore, graph('removed', 'Removed')], 'main');
    const afterProject = project([mainAfter, graph('added', 'Added')], 'main');
    const compareKinds = getGraphCompareKindByGraphId(comparison(beforeProject, afterProject));

    assert.equal(compareKinds['main' as GraphId], 'changed');
    assert.equal(compareKinds['removed' as GraphId], 'removed');
    assert.equal(compareKinds['added' as GraphId], 'added');
    assert.equal(Object.keys(compareKinds).length, 3);
  });

  it('derives context-menu presentation flags and ignores stale folder targets', () => {
    const savedGraphs = [graph('main', 'Main'), graph('child', 'Folder/Child')];
    const graphItemPresentation = getGraphListContextMenuPresentation({
      contextMenuData: contextMenuData('graph-item', { graphid: 'child', folderpath: 'Folder/Child' }),
      folderPaths: ['Folder'],
      mainGraphId: 'main' as GraphId,
      savedGraphs,
      showContextMenu: true,
    });

    assert.equal(graphItemPresentation.showGraphItemContextMenu, true);
    assert.equal(graphItemPresentation.showFolderContextMenu, false);
    assert.equal(graphItemPresentation.showGraphListContextMenu, false);
    assert.deepEqual(graphItemPresentation.target, {
      type: 'graph-item',
      graph: savedGraphs[1],
      folderPath: 'Folder/Child',
      isMainGraph: false,
    });

    const staleFolderPresentation = getGraphListContextMenuPresentation({
      contextMenuData: contextMenuData('graph-folder', { folderpath: 'Missing' }),
      folderPaths: ['Folder'],
      mainGraphId: 'main' as GraphId,
      savedGraphs,
      showContextMenu: true,
    });

    assert.equal(staleFolderPresentation.target, null);
    assert.equal(staleFolderPresentation.showFolderContextMenu, false);

    const folderPresentation = getGraphListContextMenuPresentation({
      contextMenuData: contextMenuData('graph-folder', { folderpath: 'Folder' }),
      folderPaths: ['Folder'],
      mainGraphId: 'main' as GraphId,
      savedGraphs,
      showContextMenu: true,
    });

    assert.deepEqual(folderPresentation.target, {
      type: 'graph-folder',
      folderPath: 'Folder',
    });
    assert.equal(folderPresentation.showFolderContextMenu, true);
  });

  it('derives web app context-menu presentation for real UI graph targets', () => {
    const uiGraph: UiGraph = {
      id: 'ui-graph' as UiGraphId,
      name: 'Support app',
      components: [],
    };
    const presentation = getGraphListContextMenuPresentation({
      contextMenuData: contextMenuData('ui-graph-item', { uigraphid: 'ui-graph' }),
      folderPaths: [],
      mainGraphId: 'main' as GraphId,
      savedGraphs: [graph('main', 'Main')],
      showContextMenu: true,
      uiGraphs: { [uiGraph.id]: uiGraph },
    });

    assert.equal(presentation.showUiGraphItemContextMenu, true);
    assert.equal(presentation.showGraphListContextMenu, false);
    assert.deepEqual(presentation.target, {
      type: 'ui-graph-item',
      uiGraph,
    });
  });

  it('detects collapsed folders that contain the open graph', () => {
    const item: NodeGraphFolderItem = {
      type: 'folder',
      name: 'Folder',
      fullPath: 'Folder',
      children: [{ type: 'graph', name: 'Child', graph: graph('child', 'Folder/Child') }],
    };

    const presentation = getFolderItemPresentation({
      currentGraph: graph('child', 'Folder/Child'),
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: {},
      isExpanded: false,
      item,
      mainGraphId: 'main' as GraphId,
      referencingSelectedGraphIds: new Set(),
      renamingItemFullPath: undefined,
      runningGraphs: [],
      showUnreachableIndicators: true,
    });

    assert.equal(presentation.isCollapsedOpenGraphFolder, true);
    assert.equal(presentation.folderGraphCount, 1);
    assert.equal(presentation.graphIsRunning, false);
    assert.equal(presentation.containsReferencingSelectedGraph, false);
  });

  it('does not select folder rows when no graph is selected', () => {
    const item: NodeGraphFolderItem = {
      type: 'folder',
      name: 'Folder',
      fullPath: 'Folder',
      children: [{ type: 'graph', name: 'Child', graph: graph('child', 'Folder/Child') }],
    };

    const presentation = getFolderItemPresentation({
      currentGraph: { nodes: [], connections: [] },
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: {},
      isExpanded: true,
      item,
      mainGraphId: 'main' as GraphId,
      referencingSelectedGraphIds: new Set(),
      renamingItemFullPath: undefined,
      runningGraphs: [],
      showUnreachableIndicators: true,
    });

    assert.equal(presentation.isSelected, false);
    assert.equal(presentation.isCollapsedOpenGraphFolder, false);
  });

  it('detects collapsed folders that contain graphs referencing the open graph', () => {
    const item: NodeGraphFolderItem = {
      type: 'folder',
      name: 'Folder',
      fullPath: 'Folder',
      children: [
        {
          type: 'folder',
          name: 'Nested',
          fullPath: 'Folder/Nested',
          children: [{ type: 'graph', name: 'Caller', graph: graph('caller', 'Folder/Nested/Caller') }],
        },
      ],
    };
    const baseOptions = {
      currentGraph: graph('target', 'Target'),
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: {},
      item,
      mainGraphId: 'main' as GraphId,
      referencingSelectedGraphIds: new Set(['caller' as GraphId]),
      renamingItemFullPath: undefined,
      runningGraphs: [],
      showUnreachableIndicators: true,
    };

    const collapsedPresentation = getFolderItemPresentation({
      ...baseOptions,
      isExpanded: false,
    });

    assert.equal(collapsedPresentation.containsReferencingSelectedGraph, true);

    const expandedPresentation = getFolderItemPresentation({
      ...baseOptions,
      isExpanded: true,
    });

    assert.equal(expandedPresentation.containsReferencingSelectedGraph, false);
  });

  it('skips collapsed folder reference markers when there are no referencing graphs', () => {
    const item: NodeGraphFolderItem = {
      type: 'folder',
      name: 'Folder',
      fullPath: 'Folder',
      children: [{ type: 'graph', name: 'Caller', graph: graph('caller', 'Folder/Caller') }],
    };

    const presentation = getFolderItemPresentation({
      currentGraph: graph('target', 'Target'),
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: {},
      isExpanded: false,
      item,
      mainGraphId: 'main' as GraphId,
      referencingSelectedGraphIds: new Set(),
      renamingItemFullPath: undefined,
      runningGraphs: [],
      showUnreachableIndicators: true,
    });

    assert.equal(presentation.containsReferencingSelectedGraph, false);
  });

  it('derives graph row status without reading React state', () => {
    const item: NodeGraphFolderItem = {
      type: 'graph',
      name: 'Target',
      graph: graph('target', 'Folder/Target'),
    };

    const presentation = getFolderItemPresentation({
      currentGraph: graph('target', 'Folder/Target'),
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: { target: 'unreachable' } as Record<GraphId, 'unreachable'>,
      isExpanded: true,
      item,
      mainGraphId: 'target' as GraphId,
      referencingSelectedGraphIds: new Set(['target' as GraphId]),
      renamingItemFullPath: undefined,
      runningGraphs: ['target' as GraphId],
      showUnreachableIndicators: true,
    });

    assert.equal(presentation.fullPath, 'Folder/Target');
    assert.equal(presentation.isSelected, true);
    assert.equal(presentation.isMainGraph, true);
    assert.equal(presentation.referencesSelectedGraph, true);
    assert.equal(presentation.containsReferencingSelectedGraph, false);
    assert.equal(presentation.graphIsRunning, true);
    assert.equal(presentation.shouldShowUnreachableIndicator, true);
  });

  it('suppresses unreachable indicators while renaming or when hidden by settings', () => {
    const item: NodeGraphFolderItem = {
      type: 'graph',
      name: 'Target',
      graph: graph('target', 'Folder/Target'),
    };
    const fullPath = getGraphListItemPath(item);
    const baseOptions = {
      currentGraph: graph('other', 'Other'),
      dragOverFolderName: undefined,
      draggingItemFolder: undefined,
      fullPath,
      graphReachabilityByGraphId: { target: 'unreachable' } as Record<GraphId, 'unreachable'>,
      isExpanded: true,
      item,
      mainGraphId: 'main' as GraphId,
      referencingSelectedGraphIds: new Set<GraphId>(),
      runningGraphs: [],
    };

    assert.equal(
      getFolderItemPresentation({
        ...baseOptions,
        renamingItemFullPath: fullPath,
        showUnreachableIndicators: true,
      }).shouldShowUnreachableIndicator,
      false,
    );
    assert.equal(
      getFolderItemPresentation({
        ...baseOptions,
        renamingItemFullPath: undefined,
        showUnreachableIndicators: false,
      }).shouldShowUnreachableIndicator,
      false,
    );
  });

  it('flags folders as active drop targets only when dragging from another folder', () => {
    const item: NodeGraphFolderItem = {
      type: 'folder',
      name: 'Target',
      fullPath: 'Target',
      children: [],
    };
    const baseOptions = {
      currentGraph: graph('other', 'Other'),
      dragOverFolderName: 'Target',
      fullPath: getGraphListItemPath(item),
      graphReachabilityByGraphId: {},
      isExpanded: true,
      item,
      mainGraphId: undefined,
      referencingSelectedGraphIds: new Set<GraphId>(),
      renamingItemFullPath: undefined,
      runningGraphs: [],
      showUnreachableIndicators: true,
    };

    assert.equal(
      getFolderItemPresentation({
        ...baseOptions,
        draggingItemFolder: 'Source',
      }).isDraggingOver,
      true,
    );
    assert.equal(
      getFolderItemPresentation({
        ...baseOptions,
        draggingItemFolder: 'Target',
      }).isDraggingOver,
      false,
    );
  });
});
