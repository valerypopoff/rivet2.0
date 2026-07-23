import { CSSTransition } from 'react-transition-group';
import { type FC, type RefObject, type CSSProperties, type Ref } from 'react';
import { ContextMenu, type ContextMenuContext } from '../ContextMenu.js';
import { PortInfo } from '../PortInfo.js';
import type { HoveringPort } from '../../hooks/usePortHoverTooltip.js';
import type { CanvasClientOffset } from '../../hooks/useCanvasPositioning.js';

export interface SelectionBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeCanvasOverlaysProps {
  canvasClientOffset: CanvasClientOffset;
  context: ContextMenuContext;
  contextMenuDisabled: boolean;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  contextMenuX: number;
  contextMenuY: number;
  floatingStyles: CSSProperties;
  hoveringPort: HoveringPort | undefined;
  hoveringShowPortInfo: boolean;
  onContextMenuExited: () => void;
  onContextMenuEntered: () => void;
  onContextMenuItemSelected: (
    itemId: string,
    data: unknown,
    context: ContextMenuContext,
    meta: { x: number; y: number },
  ) => void;
  selectionBox: SelectionBoxState | null;
  setFloating: (node: HTMLElement | null) => void;
  showContextMenu: boolean;
}

export const NodeCanvasOverlays: FC<NodeCanvasOverlaysProps> = ({
  canvasClientOffset,
  context,
  contextMenuDisabled,
  contextMenuRef,
  contextMenuX,
  contextMenuY,
  floatingStyles,
  hoveringPort,
  hoveringShowPortInfo,
  onContextMenuExited,
  onContextMenuEntered,
  onContextMenuItemSelected,
  selectionBox,
  setFloating,
  showContextMenu,
}) => {
  return (
    <>
      <CSSTransition
        nodeRef={contextMenuRef as unknown as RefObject<HTMLElement>}
        in={showContextMenu}
        timeout={200}
        classNames="context-menu"
        onEnter={onContextMenuEntered}
        onExited={onContextMenuExited}
      >
        <ContextMenu
          disabled={contextMenuDisabled}
          ref={contextMenuRef as unknown as Ref<HTMLDivElement>}
          x={contextMenuX}
          y={contextMenuY}
          displayOffset={canvasClientOffset}
          context={context}
          onMenuItemSelected={onContextMenuItemSelected}
        />
      </CSSTransition>
      {selectionBox && (
        <div
          className="selection-box"
          style={{
            left:
              (selectionBox.width < 0 ? selectionBox.x + selectionBox.width : selectionBox.x) - canvasClientOffset.x,
            top:
              (selectionBox.height < 0 ? selectionBox.y + selectionBox.height : selectionBox.y) - canvasClientOffset.y,
            width: Math.abs(selectionBox.width),
            height: Math.abs(selectionBox.height),
          }}
        />
      )}
      {hoveringPort && hoveringShowPortInfo && (
        <PortInfo floatingStyles={floatingStyles} ref={setFloating} port={hoveringPort} />
      )}
    </>
  );
};
