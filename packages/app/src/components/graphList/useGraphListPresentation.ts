import { useMemo } from 'react';
import type { GraphId, NodeGraph, Project } from '@valerypopoff/rivet2-core';
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
import { countGraphsInFolder, isInFolder, type NodeGraphFolderItem } from './graphFolders.js';

type GraphListProject = Omit<Project, 'data'>;

export type GraphListPresentation = {
  reachability: GraphListReachabilityPresentation;
  referencingSelectedGraphIds: ReadonlySet<GraphId>;
};

export function useGraphListPresentation(options: {
  currentGraph: NodeGraph | undefined;
  currentGraphId: GraphId | undefined;
  plugins: PluginState[];
  project: GraphListProject;
  projectNodeRegistry: GraphReachabilityRegistry;
  showGraphReferenceIndicators: boolean;
  showUnreachableGraphTags: boolean;
}): GraphListPresentation {
  const {
    currentGraph,
    currentGraphId,
    plugins,
    project,
    projectNodeRegistry,
    showGraphReferenceIndicators,
    showUnreachableGraphTags,
  } = options;
  const liveProject = useMemo(
    () => mergeGraphListCurrentGraphIntoProject(project, currentGraph),
    [currentGraph, project],
  );

  const reachability = useMemo<GraphListReachabilityPresentation>(() => {
    if (!showUnreachableGraphTags) {
      return {
        bucketByGraphId: {},
        showUnreachableBadges: false,
      };
    }

    const builtInPluginIds = resolveSupportedBuiltInPluginIds(liveProject.plugins);
    const pluginStatesById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const graphListPlugins = (liveProject.plugins ?? [])
      .map((spec) => pluginStatesById.get(spec.id))
      .filter((plugin) => plugin != null);

    const report = getGraphReachabilityReport(liveProject, {
      registry: projectNodeRegistry,
      builtInPluginIds,
    });

    return buildGraphListReachabilityPresentation({
      report,
      graphIds: Object.keys(liveProject.graphs) as GraphId[],
      plugins: graphListPlugins,
    });
  }, [liveProject, plugins, projectNodeRegistry, showUnreachableGraphTags]);

  const referencingSelectedGraphIds = useMemo(() => {
    if (!showGraphReferenceIndicators || !currentGraphId) {
      return new Set<GraphId>();
    }

    return getGraphIdsReferencingGraph(liveProject, currentGraphId);
  }, [currentGraphId, liveProject, showGraphReferenceIndicators]);

  return {
    reachability,
    referencingSelectedGraphIds,
  };
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
