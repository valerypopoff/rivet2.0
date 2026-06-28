import { css } from '@emotion/react';

import { popupMenuListStyles, popupMenuRowStyles, popupMenuSeparatorStyles } from '../PopupMenu.js';

export const projectSelectorStyles = css`
  position: absolute;

  left: 0;
  top: 0;
  right: 0;
  height: var(--project-selector-height);
  z-index: 250;

  --project-selector-strip-bg: var(--app-strip-bg);
  --project-selector-divider-color: var(--app-strip-divider-color);

  background: var(--project-selector-strip-bg);

  display: flex;
  align-items: stretch;

  --top-bar-left-controls-width: calc(var(--project-selector-height) * 3);

  &::after {
    background: var(--grey-darkish);
    bottom: 0;
    content: '';
    height: 1px;
    left: 0;
    pointer-events: none;
    position: absolute;
    right: 0;
    z-index: 2;
  }

  > * {
    position: relative;
    z-index: 1;
  }

  &.graph-tree-open::after {
    left: var(--left-sidebar-width);
  }

  .sidebar-toggle-menu,
  .graph-history-menu,
  .file-menu {
    --project-tab-bg: var(--project-selector-strip-bg);
    --project-tab-active-bg: color-mix(in srgb, var(--grey-light) 14%, var(--grey-darkish) 86%);
    --project-tab-current-bg: var(--project-tab-bg);
    --project-tab-hover-bg: var(--project-tab-active-bg);

    align-items: stretch;
    align-self: flex-start;
    background: var(--project-tab-current-bg);
    border-radius: 7px;
    color: var(--grey-light);
    display: flex;
    flex: 0 0 auto;
    height: calc(100% - 9px);
    margin: 4px 0 5px;
    position: relative;
  }

  .sidebar-toggle-menu,
  .graph-history-menu {
    width: var(--project-selector-height);
  }

  .graph-history-controls {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
  }

  .graph-history-menu {
    &.disabled {
      color: var(--grey-light);
      cursor: default;
    }
  }

  .sidebar-toggle-tooltip {
    display: flex;
    width: 100%;
    height: 100%;
  }

  .graph-history-tooltip {
    display: flex;
    height: 100%;
  }

  .file-menu {
    min-width: 78px;
  }

  .file-menu:not(:hover):not(.open):has(
      + .projects-container .draggableProject:first-child .project:not(.active):not(:hover)
    )::after {
    background: var(--project-selector-divider-color);
    content: '';
    height: 18px;
    pointer-events: none;
    position: absolute;
    right: -2px;
    top: 50%;
    transform: translateY(-50%);
    width: 1px;
    z-index: 3;
  }

  .sidebar-toggle-menu:hover,
  .graph-history-menu:not(.disabled):hover,
  .file-menu:hover,
  .file-menu.open {
    --project-tab-current-bg: var(--project-tab-hover-bg);

    color: var(--grey-lightest);
  }

  .file-menu.open {
    z-index: 10;
  }

  .sidebar-toggle-button,
  .graph-history-button,
  .file-menu-button {
    align-items: center;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    display: flex;
    height: 100%;
    justify-content: center;
    margin: 0;
    font-size: var(--ui-font-size-sm);
    line-height: 1;
    min-height: 0;
    min-width: 0;
    padding: 0 12px;
    text-align: center;
    user-select: none;
    white-space: nowrap;
    width: 100%;
  }

  .file-menu-button {
    gap: 7px;
    padding: 0 10px;
  }

  .file-menu-logo {
    display: block;
    flex: 0 0 auto;
    filter: var(--rivet-logo-filter);
    height: 14px;
    opacity: var(--rivet-logo-opacity);
    width: 16px;
  }

  .sidebar-toggle-button {
    padding: 0;

    svg {
      color: currentColor;
      height: 16px;
      width: 16px;
    }
  }

  .graph-history-button {
    padding: 0;

    &:disabled {
      cursor: default;
      opacity: 0.45;
      pointer-events: none;
    }

    svg {
      color: currentColor;
      height: 16px;
      width: 16px;
    }
  }

  .sidebar-panel-spacer {
    background: var(--project-selector-strip-bg);
    flex: 0 0 max(0px, calc(var(--left-sidebar-width) - var(--top-bar-left-controls-width)));
    height: 100%;
    min-width: 0;
  }

  &.graph-tree-open .sidebar-panel-spacer {
    background: var(--project-selector-strip-bg);
  }

  &.graph-tree-open .sidebar-toggle-menu:hover,
  &.graph-tree-open .graph-history-menu:not(.disabled):hover {
    --project-tab-current-bg: var(--project-tab-hover-bg);

    color: var(--grey-lightest);
  }

  .file-dropdown {
    ${popupMenuListStyles};
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 1000;
  }

  .file-dropdown.open {
    display: flex;
  }

  .file-dropdown button {
    ${popupMenuRowStyles};
    width: 100%;
    justify-content: flex-start;
    white-space: nowrap;
    text-align: left;
  }

  .file-dropdown-separator {
    ${popupMenuSeparatorStyles};
  }

  .projects-container {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    z-index: 3;
  }

  .projects-container.empty {
    flex: 0 0 auto;
  }

  .projects-container.empty.with-window-drag-region {
    flex: 1 1 auto;
  }

  .projects {
    display: flex;
    align-items: flex-end;
    height: 100%;
    gap: 4px;
    padding: 4px 10px 0 4px;
    max-width: 100%;
    width: 100%;
  }

  .projects-container.with-window-drag-region .projects {
    flex: 0 1 auto;
    max-width: calc(100% - 40px);
    width: auto;
  }

  .window-drag-region {
    cursor: default;
    flex: 1 0 40px;
    min-width: 40px;
  }

  .draggableProject {
    display: flex;
    align-items: flex-start;
    min-width: 50px;
    flex-shrink: 1;
    height: 100%;
    position: relative;
  }

  .draggableProject::after {
    background: var(--project-selector-divider-color);
    content: '';
    height: 18px;
    pointer-events: none;
    position: absolute;
    right: -2px;
    top: calc(50% - 2px);
    transform: translateY(-50%);
    width: 1px;
    z-index: 3;
  }

  .draggableProject:last-child::after,
  .draggableProject:has(.project.active)::after,
  .draggableProject:has(.project:hover)::after,
  .draggableProject:has(+ .draggableProject .project:hover)::after,
  .draggableProject:has(+ .draggableProject .project.active)::after {
    display: none;
  }

  .project {
    --project-tab-bg: var(--project-selector-strip-bg);
    --project-tab-active-bg: color-mix(in srgb, var(--grey-light) 14%, var(--grey-darkish) 86%);
    --project-tab-current-bg: var(--project-tab-bg);
    --project-tab-hover-bg: var(--project-tab-active-bg);
    --project-tab-shoulder-size: 8px;

    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 10px;
    cursor: pointer;
    user-select: none;
    gap: 0;
    font-size: var(--ui-font-size-sm);
    height: calc(100% - 5px);
    margin-bottom: 5px;
    vertical-align: top;
    background: var(--project-tab-current-bg);
    border-radius: 7px;
    color: var(--grey-light);
    flex-shrink: 1;
    min-width: 50px;
    position: relative;
    z-index: 1;

    &::before,
    &::after {
      bottom: 0;
      content: '';
      display: none;
      height: var(--project-tab-shoulder-size);
      pointer-events: none;
      position: absolute;
      width: var(--project-tab-shoulder-size);
    }

    &::before {
      background: radial-gradient(
        circle at 0 0,
        transparent var(--project-tab-shoulder-size),
        var(--project-tab-current-bg) calc(var(--project-tab-shoulder-size) + 0.5px)
      );
      left: calc(-1 * var(--project-tab-shoulder-size));
    }

    &::after {
      background: radial-gradient(
        circle at 100% 0,
        transparent var(--project-tab-shoulder-size),
        var(--project-tab-current-bg) calc(var(--project-tab-shoulder-size) + 0.5px)
      );
      right: calc(-1 * var(--project-tab-shoulder-size));
    }

    svg {
      width: 12px;
      height: 12px;
    }

    .project-name {
      display: flex;
      align-items: center;
      align-self: stretch;
      overflow: hidden;
      gap: 8px;
      min-width: 50px;
      flex-shrink: 1;
      white-space: nowrap;
      text-overflow: ellipsis;

      &::before {
        background: currentColor;
        border-radius: 50%;
        content: '';
        display: none;
        flex: 0 0 auto;
        height: 6px;
        width: 6px;
      }

      > span {
        min-width: 50px;
        flex-shrink: 1;
      }
    }

    &.has-unsaved-changes .project-name::before {
      display: block;
    }

    &:hover {
      --project-tab-current-bg: var(--project-tab-hover-bg);

      color: var(--grey-lightest);
    }

    &.active {
      --project-tab-current-bg: var(--project-tab-active-bg);

      align-self: flex-end;
      border-radius: 8px 8px 0 0;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: var(--grey-lightest);
      gap: 8px;
      height: 100%;
      margin-bottom: 0;
      padding: 0 6px 4px 10px;
      z-index: 2;
    }

    &.active::before,
    &.active::after {
      display: block;
    }

    &.active:hover {
      --project-tab-current-bg: var(--project-tab-active-bg);
    }

    &.active .close-project {
      color: var(--grey-light);
    }

    &.active .close-project:hover {
      color: var(--grey-lightest);
      background-color: rgba(255, 255, 255, 0.12);
    }

    &.unsaved,
    &.preview {
      font-style: italic;
    }

    > .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      visibility: hidden;
    }

    &:not(.active) > .actions {
      display: none;
    }

    &.active:hover .actions {
      visibility: visible;
    }

    .close-project {
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--grey-light);
      width: 20px;
      height: 20px;
      border-radius: var(--ui-button-radius-sm);
      corner-shape: squircle;

      svg {
        width: 12px;
        height: 12px;
      }

      &:hover {
        color: var(--grey-lightest);
        background-color: rgba(255, 255, 255, 0.12);
      }
    }
  }

  .windows-window-controls {
    align-items: stretch;
    display: flex;
    flex: 0 0 auto;
    height: 100%;
  }

  .windows-window-control {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--grey-light);
    cursor: pointer;
    display: flex;
    height: 100%;
    justify-content: center;
    margin: 0;
    min-height: 0;
    padding: 0;
    width: 46px;

    svg {
      color: currentColor;
      height: 14px;
      width: 14px;
    }

    &:hover {
      background: var(--grey-darkish);
      color: var(--grey-lightest);
    }

    &.close-window:hover {
      background: #c42b1c;
      color: white;
    }
  }
`;
