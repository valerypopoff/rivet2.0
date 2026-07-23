import { css } from '@emotion/react';
import { nodeStyles } from '../nodeStyles.js';

export const nodeCanvasStyles = css`
  width: 100vw;
  height: calc(100vh - var(--data-bus-full-row-height, 0px));
  position: relative;
  top: var(--data-bus-full-row-height, 0px);
  background-color: var(--canvas-background-color, var(--grey-darker));
  overflow: hidden;
  z-index: 0;

  .canvas-background-pattern {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  &.dragging-node,
  &.dragging-node *,
  &.dragging-canvas,
  &.dragging-canvas * {
    cursor: grabbing !important;
  }

  .nodes {
    position: relative;
    z-index: 0;
    pointer-events: none;
  }

  .context-menu {
    position: absolute;
    display: none;
  }

  .context-menu-enter {
    display: block;
    opacity: 0;
    position: absolute;
  }

  .context-menu-enter-active {
    opacity: 1;
    transition: opacity 100ms ease-out;
    position: absolute;
  }

  .context-menu-exit {
    opacity: 1;
    position: absolute;
  }

  .context-menu-exit-active {
    opacity: 0;
    transition: opacity 100ms ease-out;
    position: absolute;
  }

  .context-menu-exit-done {
    opacity: 0;
    position: absolute;
    left: -1000px;
  }

  .debug-overlay {
    position: absolute;
    top: 50px;
    left: 50px;
    padding: 10px 20px;
    border-radius: 10px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 5px;
    }
    background-color: rgba(255, 255, 255, 0.03);
    color: var(--foreground);
    box-shadow: 0 2px 4px var(--shadow);
    z-index: 99999;
    font-size: var(--ui-font-size-sm);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .canvas-contents {
    position: absolute;
    inset: 0;
    transform-origin: top left;
    pointer-events: none;
  }

  .canvas-comment-contents {
    z-index: 0;
  }

  .canvas-node-contents {
    z-index: 2;
  }

  .origin {
    position: absolute;
    left: -5px;
    top: -5px;
  }

  .selection-box {
    position: absolute;
    border: 2px dashed var(--primary);
    background-color: var(--primary-5percent);
    z-index: 2000;
  }

  ${nodeStyles}
`;
