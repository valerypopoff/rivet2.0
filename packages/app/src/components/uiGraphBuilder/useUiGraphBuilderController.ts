import {
  closestCenter,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  getGraphBoundary,
  initializeUiGraphChatActionBindings,
  type Project,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
} from '@valerypopoff/rivet2-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalHotkey } from '../../hooks/useGlobalHotkey.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { isMacOSPlatform } from '../../utils/platform/os.js';
import { initializeButtonActionToGraphBoundary } from './buttonBindings.js';
import { selectUiGraphComponent, type UiGraphComponentSelectionMode } from './componentSelection.js';
import { createUiGraphComponent } from './componentDescriptors.js';
import { getCurrentUiGraphComponentDeletionIds, type PendingUiGraphComponentDeletion } from './componentDeletion.js';
import { getUiGraphComponentInsertionIndex } from './componentInsertion.js';
import { isUiGraphComponentEventTarget, revealUiGraphComponent } from './revealUiGraphComponent.js';
import { UI_GRAPH_PREVIEW_DROP_ZONE_ID } from './UiGraphPreviewEditor.js';

export const UI_GRAPH_PALETTE_DRAG_PREFIX = 'ui-graph-palette:';

export const uiGraphBuilderCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const componentCollisions = pointerCollisions.filter(({ id }) => id !== UI_GRAPH_PREVIEW_DROP_ZONE_ID);
  if (componentCollisions.length > 0) {
    return componentCollisions;
  }

  const closestComponents = closestCenter(args).filter(({ id }) => id !== UI_GRAPH_PREVIEW_DROP_ZONE_ID);
  return closestComponents.length > 0 ? closestComponents : pointerCollisions;
};

type UpdateUiGraph = (updater: (uiGraph: UiGraph) => void) => void;

export function useUiGraphBuilderController(options: {
  project: Project;
  uiGraph: UiGraph | undefined;
  updateUiGraph: UpdateUiGraph;
}) {
  const { project, uiGraph, updateUiGraph } = options;
  const [selectedComponentIds, setSelectedComponentIds] = useState<UiComponentId[]>([]);
  const [activePaletteComponent, setActivePaletteComponent] = useState<UiGraphComponent>();
  const [paletteInsertionIndex, setPaletteInsertionIndex] = useState<number>();
  const [pendingComponentDeletion, setPendingComponentDeletion] = useState<PendingUiGraphComponentDeletion>();
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const selectedComponentIdSet = useMemo(() => new Set(selectedComponentIds), [selectedComponentIds]);
  const componentIdSet = useMemo(
    () => new Set(uiGraph?.components.map(({ id }) => id) ?? []),
    [uiGraph?.components],
  );
  const pendingDeleteComponentIds = getCurrentUiGraphComponentDeletionIds(
    pendingComponentDeletion,
    project.metadata.id,
    uiGraph,
  );

  useEffect(() => {
    setSelectedComponentIds([]);
    setPendingComponentDeletion(undefined);
    setActivePaletteComponent(undefined);
    setPaletteInsertionIndex(undefined);
  }, [project.metadata.id, uiGraph?.id]);

  useEffect(() => {
    setSelectedComponentIds((selectedIds) => {
      const existingIds = selectedIds.filter((componentId) => componentIdSet.has(componentId));
      return existingIds.length === selectedIds.length ? selectedIds : existingIds;
    });
    setPendingComponentDeletion((pending) => {
      if (!pending) return pending;
      if (pending.projectId !== project.metadata.id || pending.uiGraphId !== uiGraph?.id) return undefined;
      return pending.componentIds.some((componentId) => componentIdSet.has(componentId)) ? pending : undefined;
    });
  }, [componentIdSet, project.metadata.id, uiGraph?.id]);

  const createComponent = useStableCallback((type: UiGraphComponent['type']) => {
    const boundary = getGraphBoundary(project, project.metadata.mainGraphId);
    const component = createUiGraphComponent(type, boundary ? project.metadata.mainGraphId : undefined);
    if (component.type === 'button') {
      initializeButtonActionToGraphBoundary(component, boundary);
    } else if (component.type === 'chat') {
      component.action = initializeUiGraphChatActionBindings(component.action, boundary);
    }
    return component;
  });

  const insertComponent = useStableCallback((component: UiGraphComponent, index?: number) => {
    updateUiGraph((draft) => {
      draft.components.splice(index ?? draft.components.length, 0, component);
    });
    setSelectedComponentIds([component.id]);
  });

  const addComponent = useStableCallback((type: UiGraphComponent['type'], index?: number) => {
    insertComponent(createComponent(type), index);
  });

  const requestDeleteComponents = useStableCallback((componentIds: readonly UiComponentId[]) => {
    if (!uiGraph) return;
    const existingIds = new Set(uiGraph.components.map(({ id }) => id));
    const idsToDelete = [...new Set(componentIds)].filter((componentId) => existingIds.has(componentId));
    if (idsToDelete.length > 0) {
      setPendingComponentDeletion({ componentIds: idsToDelete, projectId: project.metadata.id, uiGraphId: uiGraph.id });
    }
  });

  const confirmDeleteComponents = useStableCallback(() => {
    const componentIds = getCurrentUiGraphComponentDeletionIds(pendingComponentDeletion, project.metadata.id, uiGraph);
    setPendingComponentDeletion(undefined);
    if (componentIds.length === 0) return;

    const deletedIds = new Set(componentIds);
    setSelectedComponentIds((selectedIds) => selectedIds.filter((componentId) => !deletedIds.has(componentId)));
    updateUiGraph((draft) => {
      draft.components = draft.components.filter(({ id }) => !deletedIds.has(id));
    });
  });

  const reorderComponents = useStableCallback((draggedComponentId: UiComponentId, targetComponentId: UiComponentId) => {
    updateUiGraph((draft) => {
      const fromIndex = draft.components.findIndex(({ id }) => id === draggedComponentId);
      const toIndex = draft.components.findIndex(({ id }) => id === targetComponentId);
      if (fromIndex >= 0 && toIndex >= 0) {
        draft.components = arrayMove(draft.components, fromIndex, toIndex);
      }
    });
  });

  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const clearPaletteDrag = useStableCallback(() => {
    setActivePaletteComponent(undefined);
    setPaletteInsertionIndex(undefined);
  });
  const handleComponentDragStart = useStableCallback((event: DragStartEvent) => {
    const componentType = getPaletteComponentType(event);
    if (componentType) {
      setActivePaletteComponent(createComponent(componentType));
      setPaletteInsertionIndex(uiGraph?.components.length ?? 0);
    }
  });
  const handleComponentDragOver = useStableCallback((event: DragOverEvent) => {
    if (!getPaletteComponentType(event) || !uiGraph) return;
    if (event.over?.id === UI_GRAPH_PREVIEW_DROP_ZONE_ID) {
      setPaletteInsertionIndex(uiGraph.components.length);
      return;
    }

    const targetIndex = uiGraph.components.findIndex(({ id }) => id === event.over?.id);
    const activeRect = event.active.rect.current.translated;
    if (targetIndex < 0 || !activeRect || !event.over) return;
    setPaletteInsertionIndex(
      getUiGraphComponentInsertionIndex(targetIndex, activeRect.top + activeRect.height / 2, event.over.rect),
    );
  });
  const handleComponentDragEnd = useStableCallback((event: DragEndEvent) => {
    const paletteComponentType = getPaletteComponentType(event);
    if (paletteComponentType) {
      if (event.over && activePaletteComponent?.type === paletteComponentType) {
        insertComponent(activePaletteComponent, paletteInsertionIndex ?? uiGraph?.components.length);
      }
    } else {
      const draggedId = event.active.id as UiComponentId;
      const targetId = event.over?.id as UiComponentId | undefined;
      if (targetId && targetId !== UI_GRAPH_PREVIEW_DROP_ZONE_ID && draggedId !== targetId) {
        reorderComponents(draggedId, targetId);
      }
    }
    clearPaletteDrag();
  });

  const selectComponent = useStableCallback(
    (componentId: UiComponentId, mode: UiGraphComponentSelectionMode, counterpart: HTMLElement | null) => {
      const wasSelected = selectedComponentIdSet.has(componentId);
      setSelectedComponentIds((selectedIds) => selectUiGraphComponent(selectedIds, componentId, mode));
      if (mode === 'replace' || !wasSelected) {
        revealUiGraphComponent(counterpart, componentId);
      }
    },
  );
  const activateSettingsComponent = useStableCallback((componentId: UiComponentId) =>
    selectComponent(componentId, 'replace', previewScrollRef.current),
  );
  const selectPreviewComponent = useStableCallback((componentId: UiComponentId, mode: UiGraphComponentSelectionMode) =>
    selectComponent(componentId, mode, settingsScrollRef.current),
  );
  const setPreviewComponentSelection = useStableCallback((componentIds: readonly UiComponentId[]) => {
    setSelectedComponentIds((selectedIds) =>
      selectedIds.length === componentIds.length && selectedIds.every((id) => componentIds.includes(id))
        ? selectedIds
        : [...componentIds],
    );
  });

  const requestDeleteSelectedComponents = useStableCallback(() => requestDeleteComponents(selectedComponentIds));
  const clearSelectionFromPointer = useStableCallback((event: { shiftKey: boolean; target: EventTarget | null }) => {
    if (!event.shiftKey && !isUiGraphComponentEventTarget(event.target)) setSelectedComponentIds([]);
  });
  const closeDeleteConfirmation = useStableCallback(() => setPendingComponentDeletion(undefined));
  const deleteFromHotkey = useStableCallback((event: KeyboardEvent) => {
    if (event.repeat || pendingComponentDeletion || selectedComponentIds.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    requestDeleteSelectedComponents();
  });
  useGlobalHotkey('Delete', deleteFromHotkey, { notWhenInputFocused: true });
  useGlobalHotkey(
    'Backspace',
    (event) => {
      if (isMacOSPlatform()) deleteFromHotkey(event);
    },
    { notWhenInputFocused: true },
  );

  return {
    activePaletteComponent,
    activateSettingsComponent,
    addComponent,
    clearPaletteDrag,
    clearSelectionFromPointer,
    closeDeleteConfirmation,
    confirmDeleteComponents,
    dragSensors,
    handleComponentDragEnd,
    handleComponentDragOver,
    handleComponentDragStart,
    paletteInsertionIndex,
    pendingDeleteComponentIds,
    previewScrollRef,
    requestDeleteComponents,
    selectPreviewComponent,
    selectedComponentIdSet,
    setPreviewComponentSelection,
    settingsScrollRef,
  };
}

function getPaletteComponentType(
  event: DragStartEvent | DragOverEvent | DragEndEvent,
): UiGraphComponent['type'] | undefined {
  const componentType = event.active.data.current?.componentType;
  return typeof componentType === 'string' ? (componentType as UiGraphComponent['type']) : undefined;
}
