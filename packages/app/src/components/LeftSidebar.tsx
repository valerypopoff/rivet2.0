import { css } from '@emotion/react';
import { type CSSProperties, type FC, type PointerEvent, useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { projectState } from '../state/savedGraphs.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { GraphList } from './GraphList.js';
import { leftSidebarLiveWidthState, leftSidebarWidthState } from '../state/ui.js';
import { clampLeftSidebarWidth, shouldCollapseLeftSidebarDrag } from '../utils/leftSidebarWidth.js';
import { resizeCursorStyles } from '../utils/resizeCursors.js';

const styles = css`
  position: fixed;
  top: var(--project-selector-height);
  left: 0;
  width: var(--left-sidebar-width);
  background-color: var(--app-panel-bg);
  backdrop-filter: blur(2px);
  padding: 0;
  z-index: 50;
  border-right: 1px solid var(--app-panel-border);
  height: calc(100vh - var(--project-selector-height));

  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
  }

  label {
    font-size: var(--ui-font-size-sm);
  }

  .resize-handle {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    z-index: 100;
    cursor: var(--resize-edge-horizontal-cursor);
    touch-action: none;
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: var(--primary);
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .resize-handle:hover::after,
  &.resizing .resize-handle::after {
    opacity: 0.65;
  }

  .left-sidebar-content {
    height: 100%;
  }
`;

export const LeftSidebar: FC = () => {
  const project = useAtomValue(projectState);
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenState);
  const [persistedSidebarWidth, setPersistedSidebarWidth] = useAtom(leftSidebarWidthState);
  const [liveSidebarWidth, setLiveSidebarWidth] = useAtom(leftSidebarLiveWidthState);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartClientXRef = useRef(0);
  const dragStartWidthRef = useRef(liveSidebarWidth);
  const liveSidebarWidthRef = useRef(liveSidebarWidth);
  const resizeSidebarOpenRef = useRef(sidebarOpen);
  const isResizingRef = useRef(false);

  liveSidebarWidthRef.current = liveSidebarWidth;

  useEffect(() => {
    if (!isResizing) {
      resizeSidebarOpenRef.current = sidebarOpen;
    }
  }, [isResizing, sidebarOpen]);

  useEffect(() => {
    if (!isResizing) {
      setLiveSidebarWidth(clampLeftSidebarWidth(persistedSidebarWidth));
    }
  }, [isResizing, persistedSidebarWidth, setLiveSidebarWidth]);

  useEffect(() => {
    if (isResizing) {
      return;
    }

    const handleWindowResize = () => {
      setLiveSidebarWidth(clampLeftSidebarWidth(persistedSidebarWidth));
    };

    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [isResizing, persistedSidebarWidth, setLiveSidebarWidth]);

  useEffect(() => {
    if (!isResizing) {
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
  }, [isResizing]);

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartClientXRef.current = event.clientX;
    dragStartWidthRef.current = liveSidebarWidth;
    resizeSidebarOpenRef.current = true;
    isResizingRef.current = true;
    setIsResizing(true);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizingRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rawWidth = dragStartWidthRef.current + event.clientX - dragStartClientXRef.current;
    const nextSidebarOpen = !shouldCollapseLeftSidebarDrag(rawWidth);
    if (resizeSidebarOpenRef.current !== nextSidebarOpen) {
      resizeSidebarOpenRef.current = nextSidebarOpen;
      setSidebarOpen(nextSidebarOpen);
    }
    const nextWidth = clampLeftSidebarWidth(rawWidth);
    liveSidebarWidthRef.current = nextWidth;
    setLiveSidebarWidth(nextWidth);
  };

  const handleResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizingRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    isResizingRef.current = false;
    setIsResizing(false);
    if (resizeSidebarOpenRef.current) {
      setPersistedSidebarWidth(liveSidebarWidthRef.current);
    } else {
      setLiveSidebarWidth(clampLeftSidebarWidth(persistedSidebarWidth));
    }
  };

  return (
    <div
      id="graph-tree-sidebar"
      className={isResizing ? 'resizing' : undefined}
      css={styles}
      style={
        {
          '--left-sidebar-width': `${liveSidebarWidth}px`,
          transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
        } as CSSProperties
      }
      key={project.metadata.id}
    >
      {(sidebarOpen || isResizing) && (
        <div
          aria-label="Resize graphs panel"
          aria-orientation="vertical"
          className="resize-handle"
          onLostPointerCapture={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          role="separator"
        />
      )}
      <div className="left-sidebar-content">
        <div className="panel" data-contextmenutype="graph-list">
          <GraphList />
        </div>
      </div>
    </div>
  );
};
