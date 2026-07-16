import {
  type CSSProperties,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type {
  GraphProgress,
  UiComponentId,
  UiGraph,
  UiGraphComponent,
  UiGraphInteractionController,
} from '@valerypopoff/rivet2-core';
import {
  RivetWebAppRenderer,
  type RivetWebAppActionResult,
  type RivetWebAppComponentFrameProps,
} from '../rivetWebApps/RivetWebAppRenderer.js';
import { getUiGraphComponentLabel } from './componentDescriptors.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import {
  addUiGraphComponentsToSelection,
  getUiGraphComponentIdsInSelectionRectangle,
  type UiGraphComponentSelectionRectangle,
} from './componentSelection.js';

export const UI_GRAPH_PREVIEW_DROP_ZONE_ID = 'ui-graph-preview-drop-zone';

type ActiveSelectionRectangle = UiGraphComponentSelectionRectangle & {
  baseSelectedComponentIds: readonly UiComponentId[];
  pointerId: number;
};

export const UiGraphPreviewEditor: FC<{
  interactionController?: UiGraphInteractionController;
  onComponentSelectionChange(componentId: UiComponentId, mode: 'replace' | 'toggle'): void;
  onComponentSelectionSetChange(componentIds: readonly UiComponentId[]): void;
  onRunAction(
    componentId: UiComponentId,
    state: Record<string, unknown>,
    abortSignal: AbortSignal,
    onProgress: (progress: GraphProgress) => void,
  ): Promise<RivetWebAppActionResult>;
  paletteComponent?: UiGraphComponent;
  paletteInsertionIndex?: number;
  scrollContainerRef: RefObject<HTMLDivElement>;
  selectedComponentIds: ReadonlySet<UiComponentId>;
  uiGraph: UiGraph;
}> = ({
  interactionController,
  onComponentSelectionChange,
  onComponentSelectionSetChange,
  onRunAction,
  paletteComponent,
  paletteInsertionIndex,
  scrollContainerRef,
  selectedComponentIds,
  uiGraph,
}) => {
  const { setNodeRef: setDropZoneRef } = useDroppable({ id: UI_GRAPH_PREVIEW_DROP_ZONE_ID });
  const pointerSelectedComponentIdRef = useRef<UiComponentId | undefined>();
  const activeSelectionRectangleRef = useRef<ActiveSelectionRectangle>();
  const [selectionRectangle, setSelectionRectangle] = useState<UiGraphComponentSelectionRectangle>();
  const previewUiGraph = useMemo(() => {
    if (!paletteComponent || paletteInsertionIndex === undefined) {
      return uiGraph;
    }

    const components = [...uiGraph.components];
    components.splice(Math.min(paletteInsertionIndex, components.length), 0, paletteComponent);
    return { ...uiGraph, components };
  }, [paletteComponent, paletteInsertionIndex, uiGraph]);

  const selectComponentFromPointer = (componentId: UiComponentId, mode: 'replace' | 'toggle') => {
    pointerSelectedComponentIdRef.current = componentId;
    onComponentSelectionChange(componentId, mode);
  };

  const selectComponentFromFocus = (componentId: UiComponentId) => {
    if (pointerSelectedComponentIdRef.current === componentId) {
      pointerSelectedComponentIdRef.current = undefined;
    } else if (!selectedComponentIds.has(componentId)) {
      onComponentSelectionChange(componentId, 'replace');
    }
  };

  const updateSelectionRectangle = useStableCallback((currentX: number, currentY: number) => {
    const activeSelectionRectangle = activeSelectionRectangleRef.current;
    const preview = scrollContainerRef.current;
    if (!activeSelectionRectangle || !preview) {
      return;
    }

    const nextRectangle = { ...activeSelectionRectangle, currentX, currentY };
    activeSelectionRectangleRef.current = nextRectangle;
    setSelectionRectangle(nextRectangle);
    const componentIds = getUiGraphComponentIdsInSelectionRectangle(
      nextRectangle,
      [...preview.querySelectorAll<HTMLElement>('[data-ui-graph-component-id]')].map((element) => ({
        id: element.dataset.uiGraphComponentId as UiComponentId,
        rect: element.getBoundingClientRect(),
      })),
    );
    onComponentSelectionSetChange(
      addUiGraphComponentsToSelection(activeSelectionRectangle.baseSelectedComponentIds, componentIds),
    );
  });

  useEffect(() => {
    const endSelectionRectangle = (event: PointerEvent) => {
      if (activeSelectionRectangleRef.current?.pointerId !== event.pointerId) {
        return;
      }

      updateSelectionRectangle(event.clientX, event.clientY);
      activeSelectionRectangleRef.current = undefined;
      setSelectionRectangle(undefined);
    };
    const moveSelectionRectangle = (event: PointerEvent) => {
      if (activeSelectionRectangleRef.current?.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      updateSelectionRectangle(event.clientX, event.clientY);
    };

    window.addEventListener('pointermove', moveSelectionRectangle, { passive: false });
    window.addEventListener('pointerup', endSelectionRectangle);
    window.addEventListener('pointercancel', endSelectionRectangle);
    return () => {
      window.removeEventListener('pointermove', moveSelectionRectangle);
      window.removeEventListener('pointerup', endSelectionRectangle);
      window.removeEventListener('pointercancel', endSelectionRectangle);
    };
  }, [updateSelectionRectangle]);

  const startSelectionRectangle = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      !event.shiftKey ||
      target.closest('[data-ui-graph-component-id], .rivet-web-app-toolbar')
    ) {
      return;
    }

    event.preventDefault();
    const nextRectangle = {
      baseSelectedComponentIds: [...selectedComponentIds],
      currentX: event.clientX,
      currentY: event.clientY,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    activeSelectionRectangleRef.current = nextRectangle;
    setSelectionRectangle(nextRectangle);
  };

  return (
    <>
      <div ref={setDropZoneRef} className="ui-graph-preview-drop-surface">
        <SortableContext items={uiGraph.components.map(({ id }) => id)} strategy={verticalListSortingStrategy}>
          <RivetWebAppRenderer
            interactionController={interactionController}
            onComponentSelectionChange={selectComponentFromPointer}
            onRootPointerDownCapture={startSelectionRectangle}
            renderComponentFrame={(frameProps) => (
              frameProps.component.id === paletteComponent?.id ? (
                <PalettePreviewComponentFrame {...frameProps} />
              ) : (
                <SortablePreviewComponentFrame
                  {...frameProps}
                  onFocusCapture={() => selectComponentFromFocus(frameProps.component.id)}
                />
              )
            )}
            rootRef={scrollContainerRef}
            selectedComponentIds={selectedComponentIds}
            interactionUiGraph={uiGraph}
            uiGraph={previewUiGraph}
            onRunAction={onRunAction}
          />
        </SortableContext>
      </div>
      {selectionRectangle ? (
        <SelectionRectangle
          rectangle={selectionRectangle}
          bounds={scrollContainerRef.current?.getBoundingClientRect()}
        />
      ) : null}
    </>
  );
};

const PalettePreviewComponentFrame: FC<RivetWebAppComponentFrameProps> = ({ children, className, component }) => (
  <div
    className="ui-graph-preview-sortable-row palette-placeholder"
    data-rivet-web-app-component-type={component.type}
  >
    <div className="ui-graph-preview-sortable-body">
      <div className={`${className} active`} data-rivet-web-app-component-type={component.type}>
        <div className="ui-graph-preview-palette-placeholder-content">{children}</div>
      </div>
    </div>
  </div>
);

const SelectionRectangle: FC<{ bounds: DOMRect | undefined; rectangle: UiGraphComponentSelectionRectangle }> = ({
  bounds,
  rectangle,
}) => {
  const clampToBounds = (value: number, start: number, end: number) => Math.min(Math.max(value, start), end);
  const startX = bounds ? clampToBounds(rectangle.startX, bounds.left, bounds.right) : rectangle.startX;
  const currentX = bounds ? clampToBounds(rectangle.currentX, bounds.left, bounds.right) : rectangle.currentX;
  const startY = bounds ? clampToBounds(rectangle.startY, bounds.top, bounds.bottom) : rectangle.startY;
  const currentY = bounds ? clampToBounds(rectangle.currentY, bounds.top, bounds.bottom) : rectangle.currentY;
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);

  return (
    <div
      className="ui-graph-preview-selection-rectangle"
      style={{
        height: Math.abs(currentY - startY),
        left,
        top,
        width: Math.abs(currentX - startX),
      }}
    />
  );
};

const SortablePreviewComponentFrame: FC<RivetWebAppComponentFrameProps> = ({
  children,
  className,
  component,
  onFocusCapture,
  onPointerDownCapture,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: component.id });
  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`ui-graph-preview-sortable-row${isDragging ? ' dragging' : ''}`}
      data-rivet-web-app-component-type={component.type}
      data-ui-graph-component-id={component.id}
      style={style}
      onFocusCapture={onFocusCapture}
      onPointerDownCapture={onPointerDownCapture}
    >
      <button
        type="button"
        className="ui-graph-preview-drag-handle"
        title="Drag to reorder"
        aria-label={`Drag ${getUiGraphComponentLabel(component.type)} component to reorder`}
        {...attributes}
        {...listeners}
      >
        ::
      </button>
      <div className="ui-graph-preview-sortable-body">
        <div className={className} data-rivet-web-app-component-type={component.type}>
          {children}
        </div>
      </div>
    </div>
  );
};
