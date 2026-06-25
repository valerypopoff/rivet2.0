import { useMemo } from 'react';
import type { GraphId, NodeGraph, Project, ProjectComparisonChangeKind } from '@valerypopoff/rivet2-core';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';
import type { ActiveProjectComparison } from '../../state/projectComparison.js';
import type { PluginState } from '../../state/plugins.js';
import {
  buildGraphListReachabilityPresentation,
  type GraphListReachabilityPresentation,
} from '../../domain/graphEditing/graphListReachability.js';
import {
  getGraphIdsReferencingGraph,
  getGraphReachabilityReport,
  type GraphReachabilityBucket,
  type GraphReachabilityRegistry,
  resolveSupportedBuiltInPluginIds,
} from '../../utils/graphReachability.js';
import { mergeCurrentGraphIntoProject } from '../../utils/workspaceTransitions.js';
import {
  addComparisonRemovedGraphsToFolderTree,
  countGraphsInFolder,
  getFolderNames,
  isInFolder,
  type NodeGraphFolderItem,
} from './graphFolders.js';
import { getGraphListContextMenuTarget, type GraphListContextMenuTarget } from './graphListContextMenu.js';

type GraphListProject = Omit<Project, 'data'>;

export type GraphListPresentation = {
  contextMenu: {
    showFolderContextMenu: boolean;
    showGraphItemContextMenu: boolean;
    showGraphListContextMenu: boolean;
    target: GraphListContextMenuTarget | null;
  };
  graphCompareKindByGraphId: Record<GraphId, ProjectComparisonChangeKind | undefined>;
  reachability: GraphListReachabilityPresentation;
  referencingSelectedGraphIds: ReadonlySet<GraphId>;
  visible: {
    folderedGraphs: NodeGraphFolderItem[];
    folderPaths: string[];
    hasFolders: boolean;
  };
};

export function useGraphListPresentation(options: {
  activeComparison: ActiveProjectComparison | undefined;
  allFolderPaths: readonly string[];
  contextMenuData: ContextMenuData;
  currentGraph: NodeGraph | undefined;
  currentGraphId: GraphId | undefined;
  folderedGraphs: NodeGraphFolderItem[];
  plugins: PluginState[];
  project: GraphListProject;
  projectNodeRegistry: GraphReachabilityRegistry;
  savedGraphs: NodeGraph[];
  searchText: string;
  showContextMenu: boolean;
  showGraphReferenceIndicators: boolean;
  showUnreachableGraphTags: boolean;
}): GraphListPresentation {
  const liveProject = useMemo(
    () => mergeGraphListCurrentGraphIntoProject(options.project, options.currentGraph),
    [options.currentGraph, options.project],
  );
  const visible = useMemo(
    () =>
      getGraphListVisiblePresentation({
        activeComparison: options.activeComparison,
        allFolderPaths: options.allFolderPaths,
        folderedGraphs: options.folderedGraphs,
        searchText: options.searchText,
      }),
    [options.activeComparison, options.allFolderPaths, options.folderedGraphs, options.searchText],
  );

  const reachability = useMemo<GraphListReachabilityPresentation>(() => {
    if (!options.showUnreachableGraphTags) {
      return {
        bucketByGraphId: {},
        showUnreachableBadges: false,
      };
    }

    const builtInPluginIds = resolveSupportedBuiltInPluginIds(liveProject.plugins);
    const pluginStatesById = new Map(options.plugins.map((plugin) => [plugin.id, plugin]));
    const graphListPlugins = (liveProject.plugins ?? [])
      .map((spec) => pluginStatesById.get(spec.id))
      .filter((plugin) => plugin != null);

    const report = getGraphReachabilityReport(liveProject, {
      registry: options.projectNodeRegistry,
      builtInPluginIds,
    });

    return buildGraphListReachabilityPresentation({
      report,
      graphIds: Object.keys(liveProject.graphs) as GraphId[],
      plugins: graphListPlugins,
    });
  }, [liveProject, options.plugins, options.projectNodeRegistry, options.showUnreachableGraphTags]);

  const referencingSelectedGraphIds = useMemo(() => {
    if (!options.showGraphReferenceIndicators || !options.currentGraphId) {
      return new Set<GraphId>();
    }

    return getGraphIdsReferencingGraph(liveProject, options.currentGraphId);
  }, [liveProject, options.currentGraphId, options.showGraphReferenceIndicators]);
  const graphCompareKindByGraphId = getGraphCompareKindByGraphId(options.activeComparison);
  const contextMenu = getGraphListContextMenuPresentation({
    contextMenuData: options.contextMenuData,
    folderPaths: visible.folderPaths,
    mainGraphId: options.project.metadata.mainGraphId,
    savedGraphs: options.savedGraphs,
    showContextMenu: options.showContextMenu,
  });

  return {
    contextMenu,
    graphCompareKindByGraphId,
    reachability,
    referencingSelectedGraphIds,
    visible,
  };
}

export function getGraphListVisiblePresentation(options: {
  activeComparison: ActiveProjectComparison | undefined;
  allFolderPaths: readonly string[];
  folderedGraphs: NodeGraphFolderItem[];
  searchText: string;
}): GraphListPresentation['visible'] {
  const { activeComparison, allFolderPaths, folderedGraphs, searchText } = options;
  const removedGraphs = activeComparison
    ? Object.values(activeComparison.comparison.graphs)
        .filter((comparison) => comparison.kind === 'removed' && comparison.before)
        .map((comparison) => comparison.before!)
        .filter((removedGraph) => graphMatchesFilter(removedGraph, searchText))
    : [];
  const visibleFolderedGraphs = addComparisonRemovedGraphsToFolderTree(folderedGraphs, removedGraphs);
  const visibleFolderPaths = [...new Set([...allFolderPaths, ...getFolderNames(visibleFolderedGraphs)])];

  return {
    folderedGraphs: visibleFolderedGraphs,
    folderPaths: visibleFolderPaths,
    hasFolders: visibleFolderPaths.length > 0,
  };
}

export function getGraphCompareKindByGraphId(
  activeComparison: ActiveProjectComparison | undefined,
): Record<GraphId, ProjectComparisonChangeKind | undefined> {
  if (!activeComparison) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(activeComparison.comparison.graphs)
      .filter(([, comparison]) => comparison.kind !== 'unchanged')
      .map(([graphId, comparison]) => [graphId, comparison.kind]),
  ) as Record<GraphId, ProjectComparisonChangeKind | undefined>;
}

export function getGraphListContextMenuPresentation(options: {
  contextMenuData: ContextMenuData;
  folderPaths: readonly string[];
  mainGraphId: GraphId | undefined;
  savedGraphs: NodeGraph[];
  showContextMenu: boolean;
}): GraphListPresentation['contextMenu'] {
  const { contextMenuData, folderPaths, mainGraphId, savedGraphs, showContextMenu } = options;
  const target = getGraphListContextMenuTarget({
    contextMenuData,
    folderPaths: new Set(folderPaths),
    mainGraphId,
    savedGraphs,
  });

  return {
    showFolderContextMenu: showContextMenu && target?.type === 'graph-folder',
    showGraphItemContextMenu: showContextMenu && target?.type === 'graph-item',
    showGraphListContextMenu: showContextMenu && target?.type === 'graph-list',
    target,
  };
}

export function graphMatchesFilter(graph: NodeGraph, searchText: string): boolean {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  const name = graph.metadata?.name?.toLocaleLowerCase() ?? '';
  const description = graph.metadata?.description?.toLocaleLowerCase() ?? '';
  return (
    normalizedSearchText.length === 0 || name.includes(normalizedSearchText) || description.includes(normalizedSearchText)
  );
}

export function mergeGraphListCurrentGraphIntoProject(
  project: GraphListProject,
  currentGraph: NodeGraph | undefined,
): GraphListProject {
  const currentGraphId = currentGraph?.metadata?.id;
  if (currentGraphId == null || project.graphs[currentGraphId] == null) {
    return project;
  }

  return mergeCurrentGraphIntoProject(project, currentGraph);
}

export function getGraphListItemPath(item: NodeGraphFolderItem): string {
  return item.type === 'folder' ? item.fullPath : item.graph.metadata?.name ?? 'Untitled graph';
}

export type FolderItemPresentation = {
  containsReferencingSelectedGraph: boolean;
  folderGraphCount: number | undefined;
  fullPath: string;
  graphIsRunning: boolean;
  graphReachability: GraphReachabilityBucket | undefined;
  isCollapsedOpenGraphFolder: boolean;
  isDraggingOver: boolean;
  isMainGraph: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  referencesSelectedGraph: boolean;
  savedGraph: NodeGraph | undefined;
  shouldShowUnreachableBadge: boolean;
};

export function getFolderItemPresentation(options: {
  currentGraph: NodeGraph;
  dragOverFolderName: string | undefined;
  draggingItemFolder: string | undefined;
  fullPath: string;
  graphReachabilityByGraphId: Record<GraphId, GraphReachabilityBucket>;
  isExpanded: boolean;
  item: NodeGraphFolderItem;
  mainGraphId: GraphId | undefined;
  referencingSelectedGraphIds: ReadonlySet<GraphId>;
  renamingItemFullPath: string | undefined;
  runningGraphs: GraphId[];
  showUnreachableBadges: boolean;
}): FolderItemPresentation {
  const {
    currentGraph,
    dragOverFolderName,
    draggingItemFolder,
    fullPath,
    graphReachabilityByGraphId,
    isExpanded,
    item,
    mainGraphId,
    referencingSelectedGraphIds,
    renamingItemFullPath,
    runningGraphs,
    showUnreachableBadges,
  } = options;

  const savedGraph = item.type === 'graph' ? item.graph : undefined;
  const graphId = savedGraph?.metadata?.id;
  const isRenaming = renamingItemFullPath === fullPath;
  const isSelected = currentGraph.metadata?.id === graphId;
  const openGraphName = currentGraph.metadata?.name;
  const isCollapsedOpenGraphFolder =
    item.type === 'folder' && !isExpanded && openGraphName != null && isInFolder(fullPath, openGraphName);
  const isMainGraph = item.type === 'graph' && graphId === mainGraphId;
  const referencesSelectedGraph = item.type === 'graph' && graphId ? referencingSelectedGraphIds.has(graphId) : false;
  const containsReferencingSelectedGraph =
    item.type === 'folder' &&
    !isExpanded &&
    referencingSelectedGraphIds.size > 0 &&
    folderContainsReferencingSelectedGraph(item, referencingSelectedGraphIds);
  const isDraggingOver =
    item.type === 'folder' && dragOverFolderName === fullPath && draggingItemFolder !== dragOverFolderName;
  const graphReachability = item.type === 'graph' && graphId ? graphReachabilityByGraphId[graphId] : undefined;
  const folderGraphCount = item.type === 'folder' ? countGraphsInFolder(item) : undefined;
  const shouldShowUnreachableBadge =
    item.type === 'graph' && !isRenaming && showUnreachableBadges && graphReachability === 'unreachable';
  const graphIsRunning = graphId != null && runningGraphs.includes(graphId);
  return {
    containsReferencingSelectedGraph,
    folderGraphCount,
    fullPath,
    graphIsRunning,
    graphReachability,
    isCollapsedOpenGraphFolder,
    isDraggingOver,
    isMainGraph,
    isRenaming,
    isSelected,
    referencesSelectedGraph,
    savedGraph,
    shouldShowUnreachableBadge,
  };
}

function folderContainsReferencingSelectedGraph(
  item: NodeGraphFolderItem,
  referencingSelectedGraphIds: ReadonlySet<GraphId>,
): boolean {
  if (item.type === 'graph') {
    const graphId = item.graph.metadata?.id;
    return graphId != null && referencingSelectedGraphIds.has(graphId);
  }

  return item.children.some((child) => folderContainsReferencingSelectedGraph(child, referencingSelectedGraphIds));
}
