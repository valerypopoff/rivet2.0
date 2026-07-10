import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  type CanvasPosition,
  canvasPositionState,
  openOrFocusGraphSearchState,
  searchingGraphState,
  editingNodeState,
  hoveringNodeState,
  goToSearchState,
  selectedNodesState,
  sidebarOpenState,
} from '../state/graphBuilder';
import { useLatest } from 'ahooks';
import { useViewportBounds } from './useViewportBounds';
import { useCanvasPositioning } from './useCanvasPositioning';
import { useRedo, useUndo } from '../commands/Command';
import { graphMetadataState, nodesState } from '../state/graph';
import { showAiGraphCreatorInputState } from '../components/AiGraphCreatorInput';
import { overlayOpenState } from '../state/ui';
import { blurCanvasNavigationShortcutFocus, getCanvasNavigationShortcut } from './canvasNavigationShortcuts.js';
import { useGraphHistoryNavigation } from './useGraphHistoryNavigation.js';
import { projectState } from '../state/savedGraphs.js';
import { useLoadGraph } from './useLoadGraph.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useProjectWorkspaceTarget } from './useProjectWorkspaceTarget.js';

type CanvasHotkeyOptions =
  | boolean
  | {
      enabled?: boolean;
      graphCommandsEnabled?: boolean;
    };

function resolveCanvasHotkeyOptions(options: CanvasHotkeyOptions) {
  if (typeof options === 'boolean') {
    return {
      enabled: options,
      graphCommandsEnabled: options,
    };
  }

  return {
    enabled: options.enabled ?? true,
    graphCommandsEnabled: options.graphCommandsEnabled ?? true,
  };
}

export function useCanvasHotkeys(options: CanvasHotkeyOptions = true) {
  const { enabled, graphCommandsEnabled } = resolveCanvasHotkeyOptions(options);
  const [canvasPosition, setCanvasPosition] = useAtom(canvasPositionState);
  const viewportBounds = useViewportBounds();
  const { canvasToClientPosition } = useCanvasPositioning();
  const setSearching = useSetAtom(searchingGraphState);
  const graphSearch = useAtomValue(searchingGraphState);
  const setEditingNode = useSetAtom(editingNodeState);
  const hoveringNode = useAtomValue(hoveringNodeState);
  const setGoToSearch = useSetAtom(goToSearchState);
  const setShowAiGraphCreatorInput = useSetAtom(showAiGraphCreatorInputState);
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const openOverlay = useAtomValue(overlayOpenState);
  const setSidebarOpen = useSetAtom(sidebarOpenState);
  const graphHistoryNavigation = useGraphHistoryNavigation();
  const loadGraph = useLoadGraph();
  const graphMetadata = useAtomValue(graphMetadataState);
  const project = useAtomValue(projectState);
  const nodeLibraryOpen = useProjectWorkspaceTarget()?.type === 'nodeLibrary';

  const nodes = useAtomValue(nodesState);
  const [selectedNodeIds, setSelectedNodes] = useAtom(selectedNodesState);

  const undo = useUndo();
  const redo = useRedo();

  const latestHandler = useLatest((e: KeyboardEvent) => {
    if (!enabled) {
      return;
    }

    if (openOverlay !== undefined) {
      return;
    }

    if (graphCommandsEnabled && e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey && graphSearch.searching) {
      e.preventDefault();
      e.stopPropagation();

      setSearching(openOrFocusGraphSearchState);
      setOpenOverlay(undefined);
      return;
    }

    // If we're in an input, don't do anything
    if (['input', 'textarea'].includes(document.activeElement?.tagName.toLowerCase()!)) {
      return;
    }

    const navigationShortcut = getCanvasNavigationShortcut(e);
    if (navigationShortcut) {
      e.preventDefault();
      e.stopPropagation();

      if (e.repeat) {
        return;
      }

      blurCanvasNavigationShortcutFocus(document.activeElement as HTMLElement | null);

      if (navigationShortcut === 'previousGraph') {
        graphHistoryNavigation.navigateBack();
      } else if (navigationShortcut === 'nextGraph') {
        graphHistoryNavigation.navigateForward();
      } else if (navigationShortcut === 'openMainGraph') {
        const mainGraphId = project.metadata.mainGraphId;
        const mainGraph = mainGraphId == null ? undefined : project.graphs[mainGraphId];

        if (mainGraphId != null && mainGraph && (nodeLibraryOpen || graphMetadata?.id !== mainGraphId)) {
          loadGraph(mainGraph, { graphView: createRootGraphViewContext(mainGraphId) });
        }
      } else {
        setSidebarOpen((open) => !open);
      }

      return;
    }

    if (!graphCommandsEnabled) {
      return;
    }

    if ((e.key === '-' || e.key === '=') && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const zoomSpeed = 0.25;
      const zoomFactor = e.key === '=' ? 1 + zoomSpeed : 1 - zoomSpeed;

      const newZoom = canvasPosition.zoom * zoomFactor;

      const centerOfScreenCanvasCoords = {
        x: viewportBounds.left + (viewportBounds.right - viewportBounds.left) / 2,
        y: viewportBounds.top + (viewportBounds.bottom - viewportBounds.top) / 2,
      };

      const { x: clientX, y: clientY } = canvasToClientPosition(
        centerOfScreenCanvasCoords.x,
        centerOfScreenCanvasCoords.y,
      );

      const newX = clientX / newZoom - canvasPosition.x;
      const newY = clientY / newZoom - canvasPosition.y;

      const diff = {
        x: newX - centerOfScreenCanvasCoords.x,
        y: newY - centerOfScreenCanvasCoords.y,
      };

      const position: CanvasPosition = {
        x: canvasPosition.x + diff.x,
        y: canvasPosition.y + diff.y,
        zoom: newZoom,
      };

      setCanvasPosition(position);
    }

    const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
    if (isArrowKey) {
      const arrowSpeed = 100;
      const arrowFactor = e.shiftKey ? 10 : 1;
      const arrowDirection = {
        ArrowUp: { x: 0, y: 1 },
        ArrowDown: { x: 0, y: -1 },
        ArrowLeft: { x: 1, y: 0 },
        ArrowRight: { x: -1, y: 0 },
      };

      const direction = arrowDirection[e.key as keyof typeof arrowDirection];
      const diff = {
        x: direction.x * arrowSpeed * arrowFactor,
        y: direction.y * arrowSpeed * arrowFactor,
      };

      const position: CanvasPosition = {
        x: canvasPosition.x + diff.x,
        y: canvasPosition.y + diff.y,
        zoom: canvasPosition.zoom,
      };
      setCanvasPosition(position);
    }

    if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      setSearching(openOrFocusGraphSearchState);
      setOpenOverlay(undefined);
    }

    if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName!)) {
        return;
      }

      if (hoveringNode) {
        setEditingNode(hoveringNode);
      }
    }

    if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      undo();
    }

    if (e.key === 'y' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      redo();
    }

    if (e.key === 'z' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      redo();
    }

    if (e.key === 'p' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      setGoToSearch({ searching: true, query: '', selectedIndex: 0, entries: [] });
    }

    if (e.key === 'a' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      if (
        selectedNodeIds.length === nodes.length &&
        selectedNodeIds.length > 0 &&
        selectedNodeIds.every((id) => nodes.find((n) => n.id === id))
      ) {
        setSelectedNodes([]);
      } else {
        setSelectedNodes(nodes.map((n) => n.id));
      }
    }

    if (e.key === 'i' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      setShowAiGraphCreatorInput(true);
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      latestHandler.current?.(e);
    };

    window.addEventListener('keydown', listener);

    return () => {
      window.removeEventListener('keydown', listener);
    };
  }, [latestHandler]);
}
