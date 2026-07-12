import type { CSSProperties, FC, RefObject } from 'react';
import { DndContext, PointerSensor, closestCenter, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { UiComponentId, UiGraph } from '@valerypopoff/rivet2-core';
import {
  RivetWebAppRenderer,
  type RivetWebAppActionResult,
  type RivetWebAppComponentFrameProps,
} from '../rivetWebApps/RivetWebAppRenderer.js';
import { getUiGraphComponentLabel } from './componentDescriptors.js';

export const UiGraphPreviewEditor: FC<{
  activeComponentId: UiComponentId | undefined;
  onActiveComponentChange(componentId: UiComponentId): void;
  onReorder(draggedComponentId: UiComponentId, targetComponentId: UiComponentId): void;
  onRunAction(componentId: UiComponentId, state: Record<string, unknown>): Promise<RivetWebAppActionResult>;
  scrollContainerRef: RefObject<HTMLDivElement>;
  uiGraph: UiGraph;
}> = ({ activeComponentId, onActiveComponentChange, onReorder, onRunAction, scrollContainerRef, uiGraph }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const draggedComponentId = event.active.id as UiComponentId;
    const targetComponentId = event.over?.id as UiComponentId | undefined;

    if (targetComponentId && draggedComponentId !== targetComponentId) {
      onReorder(draggedComponentId, targetComponentId);
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={uiGraph.components.map(({ id }) => id)} strategy={verticalListSortingStrategy}>
        <RivetWebAppRenderer
          activeComponentId={activeComponentId}
          onActiveComponentChange={onActiveComponentChange}
          renderComponentFrame={(frameProps) => <SortablePreviewComponentFrame {...frameProps} />}
          rootRef={scrollContainerRef}
          uiGraph={uiGraph}
          onRunAction={onRunAction}
        />
      </SortableContext>
    </DndContext>
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
        <div className={className}>{children}</div>
      </div>
    </div>
  );
};
