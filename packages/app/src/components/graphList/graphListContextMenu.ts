import type { ComponentType, SVGProps } from 'react';
import type { GraphId, NodeGraph, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import type { ContextMenuData } from '../../hooks/useContextMenu.js';

type GraphListContextMenuIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type GraphListContextMenuItem = {
  id: string;
  label: string;
  icon?: GraphListContextMenuIcon;
  tone?: 'default' | 'danger';
  separatorBefore?: boolean;
};

export type GraphListContextMenuIcons = {
  collapseAllFolders: GraphListContextMenuIcon;
  renameGraph: GraphListContextMenuIcon;
  duplicateGraph: GraphListContextMenuIcon;
  expandAllFolders: GraphListContextMenuIcon;
  graphInfo: GraphListContextMenuIcon;
  makeMainGraph: GraphListContextMenuIcon;
  deleteGraph: GraphListContextMenuIcon;
  newGraph: GraphListContextMenuIcon;
  newFolder: GraphListContextMenuIcon;
  importGraph: GraphListContextMenuIcon;
};

export type GraphListContextMenuTarget =
  | {
      type: 'graph-item';
      graph: NodeGraph;
      folderPath: string;
      isMainGraph: boolean;
    }
  | {
      type: 'graph-folder';
      folderPath: string;
    }
  | {
      type: 'graph-list';
    }
  | {
      type: 'ui-graph-item';
      uiGraph: UiGraph;
    };

type GraphListContextMenuOptions = {
  contextMenuData: ContextMenuData;
  folderPaths?: ReadonlySet<string>;
  mainGraphId: GraphId | undefined;
  savedGraphs: NodeGraph[];
  uiGraphs?: Record<UiGraphId, UiGraph>;
};

export function getGraphListContextMenuTarget({
  contextMenuData,
  folderPaths,
  mainGraphId,
  savedGraphs,
  uiGraphs,
}: GraphListContextMenuOptions): GraphListContextMenuTarget | null {
  const data = contextMenuData.data;

  if (data?.type === 'ui-graph-item') {
    const uiGraphId = data.element.dataset.uigraphid as UiGraphId | undefined;
    const uiGraph = uiGraphId ? uiGraphs?.[uiGraphId] : undefined;
    return uiGraph ? { type: 'ui-graph-item', uiGraph } : null;
  }

  if (data?.type === 'graph-list') {
    return { type: 'graph-list' };
  }

  if (data?.type === 'graph-folder') {
    const folderPath = data.element.dataset.folderpath;
    if (folderPath == null || (folderPaths && !folderPaths.has(folderPath))) {
      return null;
    }

    return { type: 'graph-folder', folderPath };
  }

  if (data?.type !== 'graph-item') {
    return null;
  }

  const graphId = data.element.dataset.graphid;
  const folderPath = data.element.dataset.folderpath;

  if (graphId == null || folderPath == null) {
    return null;
  }

  const graph = savedGraphs.find((savedGraph) => savedGraph.metadata?.id === graphId);
  if (!graph) {
    return null;
  }

  const currentGraphPath = graph.metadata?.name ?? folderPath;

  return {
    type: 'graph-item',
    graph,
    folderPath: currentGraphPath,
    isMainGraph: graph.metadata?.id === mainGraphId,
  };
}

export function buildUiGraphItemContextMenuItems(icons: GraphListContextMenuIcons): GraphListContextMenuItem[] {
  return [
    {
      id: 'duplicate-ui-graph',
      label: 'Duplicate',
      icon: icons.duplicateGraph,
    },
    {
      id: 'delete-ui-graph',
      label: 'Delete',
      icon: icons.deleteGraph,
      separatorBefore: true,
      tone: 'danger',
    },
  ];
}

export function buildGraphItemContextMenuItems(options: {
  icons: GraphListContextMenuIcons;
  isMainGraph: boolean;
}): GraphListContextMenuItem[] {
  const { icons, isMainGraph } = options;

  return [
    {
      id: 'rename-graph',
      label: 'Rename',
      icon: icons.renameGraph,
    },
    {
      id: 'duplicate-graph',
      label: 'Duplicate',
      icon: icons.duplicateGraph,
    },
    {
      id: 'graph-info',
      label: 'Graph info',
      icon: icons.graphInfo,
    },
    ...(!isMainGraph
      ? [
          {
            id: 'make-main-graph',
            label: 'Make main graph',
            icon: icons.makeMainGraph,
            separatorBefore: true,
          },
        ]
      : []),
    {
      id: 'delete-graph',
      label: 'Delete',
      icon: icons.deleteGraph,
      tone: 'danger',
      separatorBefore: true,
    },
  ];
}

export function buildFolderContextMenuItems(icons: GraphListContextMenuIcons): GraphListContextMenuItem[] {
  return [
    {
      id: 'rename-folder',
      label: 'Rename',
      icon: icons.renameGraph,
    },
    {
      id: 'new-graph-in-folder',
      label: 'New Graph',
      icon: icons.newGraph,
    },
    {
      id: 'new-folder-in-folder',
      label: 'New Folder',
      icon: icons.newFolder,
    },
    {
      id: 'collapse-all-folders',
      label: 'Collapse all folders',
      icon: icons.collapseAllFolders,
      separatorBefore: true,
    },
    {
      id: 'expand-all-folders',
      label: 'Expand all folders',
      icon: icons.expandAllFolders,
    },
    {
      id: 'delete-folder',
      label: 'Delete',
      icon: icons.deleteGraph,
      tone: 'danger',
      separatorBefore: true,
    },
  ];
}

export function buildGraphListContextMenuItems(options: {
  hasFolders: boolean;
  icons: GraphListContextMenuIcons;
}): GraphListContextMenuItem[] {
  const { hasFolders, icons } = options;

  return [
    {
      id: 'new-graph',
      label: 'New Graph',
      icon: icons.newGraph,
    },
    {
      id: 'new-folder',
      label: 'New Folder',
      icon: icons.newFolder,
    },
    {
      id: 'import-graph',
      label: 'Import Graph...',
      icon: icons.importGraph,
    },
    ...(hasFolders
      ? [
          {
            id: 'collapse-all-folders',
            label: 'Collapse all folders',
            icon: icons.collapseAllFolders,
            separatorBefore: true,
          },
          {
            id: 'expand-all-folders',
            label: 'Expand all folders',
            icon: icons.expandAllFolders,
          },
        ]
      : []),
  ];
}
