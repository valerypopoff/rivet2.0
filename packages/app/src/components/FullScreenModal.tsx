import { type FC, type PointerEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { css, Global } from '@emotion/react';
import Modal, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import {
  type HorizontalModalBounds,
  type HorizontalModalResizeEdge,
  normalizeHorizontalModalBounds,
  resizeHorizontalModalBounds,
} from '../utils/fullScreenModalBounds.js';
import { resizeCursorStyles } from '../utils/resizeCursors.js';

interface FullScreenModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  horizontalBounds?: HorizontalModalBounds;
  onHorizontalBoundsChange?: (bounds: HorizontalModalBounds) => void;
  testId?: string;
}

const styles = css`
  --fullscreen-modal-vertical-inset: 16px;

  box-sizing: border-box;
  padding: var(--fullscreen-modal-vertical-inset) 0;
  height: 100%;
  max-height: calc(100vh - 32px);
  width: 100%;
`;

const resizableStyles = css`
  .fullscreen-modal-content {
    min-width: 0;
    min-height: 100%;
  }

  .fullscreen-modal-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 9999;
    width: 16px;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: var(--resize-edge-horizontal-cursor);
  }

  .fullscreen-modal-resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    opacity: 0;
    background: var(--primary);
    transition: opacity 120ms ease;
  }

  .fullscreen-modal-resize-handle:hover::after,
  .fullscreen-modal-resize-handle.resizing::after {
    opacity: 0.65;
  }

  .fullscreen-modal-resize-handle-left::after {
    left: 8px;
  }

  .fullscreen-modal-resize-handle-left {
    left: -8px;
  }

  .fullscreen-modal-resize-handle-right::after {
    right: 8px;
  }

  .fullscreen-modal-resize-handle-right {
    right: -8px;
  }
`;

function getResizableModalShellStyles(testId: string, bounds: HorizontalModalBounds) {
  return css`
    [data-testid='${testId}--positioner'] {
      left: ${bounds.leftPercent}vw !important;
      right: ${bounds.rightPercent}vw !important;
      width: auto !important;
      max-width: none !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    [data-testid='${testId}'] {
      position: relative !important;
      width: 100% !important;
      max-width: 100% !important;
    }

    [data-testid='${testId}--scrollable'] {
      border-top: 0 !important;
      border-bottom: 0 !important;
      overflow-x: auto !important;
      overflow-y: auto !important;
    }

    [data-testid='${testId}--body'] {
      padding-top: 0 !important;
      padding-bottom: 0 !important;
    }
  `;
}

function getViewportWidth(): number {
  if (typeof document !== 'undefined' && document.documentElement.clientWidth > 0) {
    return document.documentElement.clientWidth;
  }

  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

export const FullScreenModal: FC<FullScreenModalProps> = ({
  isOpen,
  onClose,
  children,
  horizontalBounds,
  onHorizontalBoundsChange,
  testId,
}) => {
  const [activeResizeEdge, setActiveResizeEdge] = useState<HorizontalModalResizeEdge | null>(null);
  const isHorizontallyResizable = horizontalBounds != null && onHorizontalBoundsChange != null;
  const modalTestId = testId ?? (isHorizontallyResizable ? 'resizable-fullscreen-modal' : undefined);
  const normalizedHorizontalBounds = useMemo(
    () => (horizontalBounds ? normalizeHorizontalModalBounds(horizontalBounds, getViewportWidth()) : undefined),
    [horizontalBounds],
  );
  useEffect(() => {
    if (activeResizeEdge == null || typeof document === 'undefined') {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = resizeCursorStyles.horizontal;
    document.body.style.userSelect = 'none';

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [activeResizeEdge]);

  const handleResizePointerDown = (edge: HorizontalModalResizeEdge) => (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveResizeEdge(edge);
  };

  const handleResizePointerMove = (edge: HorizontalModalResizeEdge) => (event: PointerEvent<HTMLDivElement>) => {
    if (activeResizeEdge !== edge || !horizontalBounds || !onHorizontalBoundsChange) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onHorizontalBoundsChange(
      resizeHorizontalModalBounds({
        bounds: horizontalBounds,
        clientX: event.clientX,
        edge,
        viewportWidth: getViewportWidth(),
      }),
    );
  };

  const handleResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveResizeEdge(null);
  };

  const resizeHandles =
    isHorizontallyResizable && normalizedHorizontalBounds ? (
      <>
        <div
          aria-label="Resize fullscreen output modal from the left edge"
          aria-orientation="vertical"
          className={`fullscreen-modal-resize-handle fullscreen-modal-resize-handle-left${
            activeResizeEdge === 'left' ? ' resizing' : ''
          }`}
          onLostPointerCapture={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          onPointerDown={handleResizePointerDown('left')}
          onPointerMove={handleResizePointerMove('left')}
          onPointerUp={handleResizePointerEnd}
          role="separator"
        />
        <div
          aria-label="Resize fullscreen output modal from the right edge"
          aria-orientation="vertical"
          className={`fullscreen-modal-resize-handle fullscreen-modal-resize-handle-right${
            activeResizeEdge === 'right' ? ' resizing' : ''
          }`}
          onLostPointerCapture={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          onPointerDown={handleResizePointerDown('right')}
          onPointerMove={handleResizePointerMove('right')}
          onPointerUp={handleResizePointerEnd}
          role="separator"
        />
      </>
    ) : null;

  return (
    <ModalTransition>
      {isOpen && (
        <>
          {isHorizontallyResizable ? <Global styles={resizableStyles} /> : null}
          {isHorizontallyResizable && normalizedHorizontalBounds && modalTestId ? (
            <Global styles={getResizableModalShellStyles(modalTestId, normalizedHorizontalBounds)} />
          ) : null}
          <Modal onClose={onClose} shouldReturnFocus={false} width="100%" height="100%" testId={modalTestId}>
            {resizeHandles}
            <ModalBody>
              <div css={styles} onWheel={(e) => e.stopPropagation()}>
                {isHorizontallyResizable ? <div className="fullscreen-modal-content">{children}</div> : children}
              </div>
            </ModalBody>
          </Modal>
        </>
      )}
    </ModalTransition>
  );
};
