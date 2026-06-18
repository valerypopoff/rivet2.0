import { css } from '@emotion/react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue } from 'jotai';
import CloseIcon from 'majesticons/line/multiply-line.svg?react';
import LeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import RightIcon from 'majesticons/line/chevron-right-line.svg?react';
import RivetLogo from '../rivet-2-logo-no-background.svg';
import {
  openedProjectsSortedIdsState,
  openedProjectsState,
  projectDataUnsavedChangesState,
  projectState,
  projectUnsavedChangesState,
} from '../state/savedGraphs';
import clsx from 'clsx';
import { useLoadProject } from '../hooks/useLoadProject';
import { useSyncCurrentStateIntoOpenedProjects } from '../hooks/useSyncCurrentStateIntoOpenedProjects';
import { type SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { isInTauri } from '../utils/tauri.js';
import { isMacOSPlatform, isWindowsPlatform } from '../utils/platform/os.js';
import { getAppWindowHandle } from '../utils/platform/window.js';
import { type NativeWindowHandle, type NativeWindowListener } from '../utils/platform/core.js';
import { useRunMenuCommand } from '../hooks/useMenuCommands.js';
import { useRivetWorkspaceHost } from '../hooks/useRivetWorkspaceHost.js';
import { OverlayTabs } from './OverlayTabs.js';
import { popupMenuListStyles, popupMenuRowStyles, popupMenuSeparatorStyles } from './PopupMenu.js';
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { getVisibleFileMenuGroups } from '../utils/fileMenuConfiguration.js';
import { leftSidebarLiveWidthState, overlayOpenState } from '../state/ui.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import {
  GRAPH_HISTORY_NEXT_TOOLTIP,
  GRAPH_HISTORY_PREVIOUS_TOOLTIP,
  GRAPH_TREE_TOGGLE_SHORTCUT_LABEL,
} from '../hooks/canvasNavigationShortcuts.js';
import { Tooltip } from './Tooltip.js';
import { useGraphHistoryNavigation } from '../hooks/useGraphHistoryNavigation.js';
import { hasProjectUnsavedChanges } from '../utils/projectUnsavedChanges.js';
import { AppModalHeader } from './AppModalHeader.js';

export const styles = css`
  position: absolute;

  left: 0;
  top: 0;
  right: 0;
  height: var(--project-selector-height);
  z-index: 250;

  --project-selector-strip-bg: var(--grey-dark-colorish);
  --project-selector-divider-color: color-mix(in srgb, var(--grey-light) 18%, var(--project-selector-strip-bg) 82%);

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
    align-items: stretch;
    background: var(--project-selector-strip-bg);
    color: var(--grey-light);
    display: flex;
    flex: 0 0 auto;
    position: relative;
    height: 100%;
  }

  .sidebar-toggle-menu {
    width: var(--project-selector-height);
  }

  .graph-history-controls {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
  }

  .graph-history-menu {
    width: var(--project-selector-height);

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
    --project-tab-bg: var(--project-selector-strip-bg);
    --project-tab-active-bg: color-mix(in srgb, var(--grey-light) 14%, var(--grey-darkish) 86%);
    --project-tab-current-bg: var(--project-tab-bg);
    --project-tab-hover-bg: var(--project-tab-active-bg);

    align-self: flex-start;
    background: var(--project-tab-current-bg);
    border-radius: 7px;
    color: var(--grey-light);
    height: calc(100% - 9px);
    margin: 4px 0 5px;
    min-width: 78px;
  }

  .sidebar-toggle-menu,
  .graph-history-menu {
    --project-tab-bg: var(--project-selector-strip-bg);
    --project-tab-active-bg: color-mix(in srgb, var(--grey-light) 14%, var(--grey-darkish) 86%);
    --project-tab-current-bg: var(--project-tab-bg);
    --project-tab-hover-bg: var(--project-tab-active-bg);

    align-self: flex-start;
    background: var(--project-tab-current-bg);
    border-radius: 7px;
    height: calc(100% - 9px);
    margin: 4px 0 5px;
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

    &.unsaved {
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

const unsavedProjectCloseModalBody = css`
  color: var(--foreground);
  display: flex;
  flex-direction: column;
  font-size: var(--ui-font-size-compact);
  gap: 8px;

  p {
    margin: 0;
  }
`;

export const ProjectSelector: FC<{
  mode?: 'project' | 'workspace';
}> = ({ mode = 'project' }) => {
  const projectMode = mode === 'project';
  const openedProjects = useAtomValue(openedProjectsState);
  const [openedProjectsSortedIds, setOpenedProjectsSortedIds] = useAtom(openedProjectsSortedIdsState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const projectDataUnsavedChanges = useAtomValue(projectDataUnsavedChangesState);
  const [openOverlay, setOpenOverlay] = useAtom(overlayOpenState);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const currentProject = useAtomValue(projectState);
  const { closeProject } = useRivetWorkspaceHost();
  const [projectPendingClose, setProjectPendingClose] = useState<ProjectId | null>(null);

  const sortedOpenedProjects = useMemo(() => {
    return openedProjectsSortedIds
      .map((projectId) => ({
        id: projectId,
        project: openedProjects[projectId]!,
      }))
      .filter((item) => item.project != null);
  }, [openedProjectsSortedIds, openedProjects]);
  const visibleProjects = projectMode ? sortedOpenedProjects : [];

  const loadProject = useLoadProject();
  const projectTabsSelected = projectMode && openOverlay === undefined;
  const reserveSidebarColumn = projectTabsSelected && sidebarOpen;
  const showFileMenu = !isInTauri() || isWindowsPlatform() || isMacOSPlatform();
  const showWindowsWindowControls = isInTauri() && isWindowsPlatform();

  useSyncCurrentStateIntoOpenedProjects({ enabled: projectMode });

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      setOpenedProjectsSortedIds((prev) => {
        const oldIndex = prev.indexOf(active?.id as ProjectId);
        const newIndex = prev.indexOf(over?.id as ProjectId);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  };

  const handleSelectProject = (projectId: ProjectId) => {
    if (projectId === currentProject.metadata.id) {
      setOpenOverlay(undefined);
      return;
    }

    const projectInfo = openedProjects[projectId];
    if (projectInfo) {
      void loadProject(projectInfo).then((loaded) => {
        if (loaded) {
          setOpenOverlay(undefined);
        }
      });
    }
  };

  const requestCloseProject = (projectId: ProjectId) => {
    if (hasProjectUnsavedChanges(projectUnsavedChanges, projectDataUnsavedChanges, projectId)) {
      setProjectPendingClose(projectId);
      return;
    }

    void closeProject(projectId);
  };

  const cancelCloseProject = () => setProjectPendingClose(null);

  const confirmCloseProject = () => {
    const projectId = projectPendingClose;
    if (!projectId) {
      return;
    }

    setProjectPendingClose(null);
    void closeProject(projectId);
  };

  const projectPendingCloseInfo = projectPendingClose ? openedProjects[projectPendingClose] : undefined;

  return (
    <div
      className={clsx({ 'graph-tree-open': reserveSidebarColumn })}
      css={styles}
      style={{ '--left-sidebar-width': `${leftSidebarWidth}px` } as CSSProperties}
    >
      {projectTabsSelected && <GraphTreeSidebarToggle />}
      {projectTabsSelected && <GraphHistoryControls />}
      {reserveSidebarColumn && <div className="sidebar-panel-spacer" aria-hidden="true" />}
      {showFileMenu && <ProjectFileMenu />}
      <div
        className={clsx('projects-container', {
          empty: visibleProjects.length === 0,
          'with-window-drag-region': showWindowsWindowControls,
        })}
      >
        <div className="projects">
          <DndContext onDragEnd={handleDragEnd}>
            <SortableContext items={visibleProjects} strategy={horizontalListSortingStrategy}>
              {visibleProjects.map((project) => {
                return (
                  <SortableProject
                    key={project.id}
                    projectId={project.project.projectId}
                    onCloseProject={() => requestCloseProject(project.project.projectId)}
                    onSelectProject={() => handleSelectProject(project.project.projectId)}
                    projectTabsSelected={projectTabsSelected}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
        </div>
        {showWindowsWindowControls && <WindowsWindowDragRegion />}
      </div>
      <OverlayTabs showWelcomeScreen={!projectMode} />
      {showWindowsWindowControls && <WindowsWindowControls />}
      <UnsavedProjectCloseConfirmModal
        projectTitle={projectPendingCloseInfo?.title}
        onClose={cancelCloseProject}
        onConfirm={confirmCloseProject}
        open={projectPendingCloseInfo != null}
      />
    </div>
  );
};

const useWindowsAppWindow = () => {
  const appWindowRef = useRef<NativeWindowHandle | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getAppWindowHandle()
      .then((handle) => {
        if (!cancelled) {
          appWindowRef.current = handle;
        }
      })
      .catch((err) => {
        console.warn(`Error getting app window handle: ${err}`);
      });

    return () => {
      cancelled = true;
      appWindowRef.current = null;
    };
  }, []);

  return useCallback(async () => {
    if (appWindowRef.current) {
      return appWindowRef.current;
    }

    appWindowRef.current = await getAppWindowHandle();
    return appWindowRef.current;
  }, []);
};

const WindowsWindowDragRegion: FC = () => {
  const getAppWindow = useWindowsAppWindow();

  const startDragging = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) {
      return;
    }

    void getAppWindow()
      .then((appWindow) => appWindow?.startDragging?.())
      .catch((err) => {
        console.warn(`Error starting app window drag: ${err}`);
      });
  };

  const toggleMaximize = () => {
    void getAppWindow()
      .then((appWindow) => appWindow?.toggleMaximize?.())
      .catch((err) => {
        console.warn(`Error toggling app window maximize state: ${err}`);
      });
  };

  return (
    <div
      className="window-drag-region"
      aria-hidden="true"
      onDoubleClick={toggleMaximize}
      onMouseDown={startDragging}
    />
  );
};

const WindowsWindowControls: FC = () => {
  const getAppWindow = useWindowsAppWindow();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlistenResize: NativeWindowListener | undefined;

    const refreshMaximizedState = async (appWindow?: NativeWindowHandle | null) => {
      try {
        const windowHandle = appWindow ?? (await getAppWindow());
        const maximized = await windowHandle?.isMaximized?.();

        if (!cancelled && maximized != null) {
          setIsWindowMaximized(maximized);
        }
      } catch (err) {
        console.warn(`Error tracking app window maximize state: ${err}`);
      }
    };

    void getAppWindow()
      .then(async (appWindow) => {
        await refreshMaximizedState(appWindow);

        const removeResizeListener = await appWindow?.listen?.('tauri://resize', () => {
          void refreshMaximizedState(appWindow);
        });

        if (cancelled) {
          void removeResizeListener?.();
        } else {
          unlistenResize = removeResizeListener;
        }
      })
      .catch((err) => {
        console.warn(`Error loading app window controls: ${err}`);
      });

    return () => {
      cancelled = true;
      void unlistenResize?.();
    };
  }, [getAppWindow]);

  const runWindowAction = (action: (appWindow: NativeWindowHandle) => Promise<void> | void) => {
    void getAppWindow()
      .then((appWindow) => {
        if (appWindow) {
          return action(appWindow);
        }
      })
      .catch((err) => {
        console.warn(`Error running app window action: ${err}`);
      });
  };

  const toggleMaximize = () => {
    runWindowAction(async (appWindow) => {
      await appWindow.toggleMaximize?.();
      const maximized = await appWindow.isMaximized?.();

      if (maximized != null) {
        setIsWindowMaximized(maximized);
      }
    });
  };

  return (
    <div className="windows-window-controls" aria-label="Window controls">
      <button
        type="button"
        className="windows-window-control"
        aria-label="Minimize window"
        onClick={() => runWindowAction((appWindow) => appWindow.minimize?.())}
      >
        <MinimizeWindowIcon />
      </button>
      <button
        type="button"
        className="windows-window-control"
        aria-label={isWindowMaximized ? 'Restore window' : 'Maximize window'}
        onClick={toggleMaximize}
      >
        {isWindowMaximized ? <RestoreWindowIcon /> : <MaximizeWindowIcon />}
      </button>
      <button
        type="button"
        className="windows-window-control close-window"
        aria-label="Close window"
        onClick={() => runWindowAction((appWindow) => appWindow.close())}
      >
        <CloseIcon />
      </button>
    </div>
  );
};

const MinimizeWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path d="M3 8.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
  </svg>
);

const MaximizeWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const RestoreWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path
      d="M5.25 3.25h7.5v7.5M3.25 5.25h8.5v8.5h-8.5z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);

const GraphTreeSidebarToggle: FC = () => {
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenState);
  const actionLabel = sidebarOpen ? 'Collapse graph tree' : 'Expand graph tree';
  const actionTitle = `${actionLabel} (${GRAPH_TREE_TOGGLE_SHORTCUT_LABEL})`;

  return (
    <div className="sidebar-toggle-menu">
      <Tooltip content={actionTitle} placement="bottom" className="sidebar-toggle-tooltip">
        <button
          type="button"
          className="sidebar-toggle-button dropdown-item"
          aria-controls="graph-tree-sidebar"
          aria-expanded={sidebarOpen}
          aria-label={actionLabel}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <GraphTreeSidebarIcon sidebarOpen={sidebarOpen} />
        </button>
      </Tooltip>
    </div>
  );
};

const GraphTreeSidebarIcon: FC<{ sidebarOpen: boolean }> = ({ sidebarOpen }) => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <rect x="2.75" y="3.5" width="10.5" height="9" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
    <path
      d={sidebarOpen ? 'M5.25 4.75v6.5' : 'M7.25 4.75v6.5'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.25"
    />
  </svg>
);

const GraphHistoryControls: FC = () => {
  const navigationStack = useGraphHistoryNavigation();

  return (
    <div className="graph-history-controls">
      <GraphHistoryButton
        disabled={!navigationStack.hasBackward}
        label="Go to previous graph"
        tooltip={GRAPH_HISTORY_PREVIOUS_TOOLTIP}
        onClick={navigationStack.navigateBack}
      >
        <LeftIcon />
      </GraphHistoryButton>
      <GraphHistoryButton
        disabled={!navigationStack.hasForward}
        label="Go to next graph"
        tooltip={GRAPH_HISTORY_NEXT_TOOLTIP}
        onClick={navigationStack.navigateForward}
      >
        <RightIcon />
      </GraphHistoryButton>
    </div>
  );
};

const GraphHistoryButton: FC<{
  children: ReactNode;
  disabled: boolean;
  label: string;
  tooltip: string;
  onClick: () => void;
}> = ({ children, disabled, label, onClick, tooltip }) => {
  const button = (
    <div className={clsx('graph-history-menu', { disabled })}>
      <button
        aria-label={label}
        className="graph-history-button dropdown-item"
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        type="button"
      >
        {children}
      </button>
    </div>
  );

  return (
    <Tooltip content={tooltip} placement="bottom" className="graph-history-tooltip">
      {button}
    </Tooltip>
  );
};

const UnsavedProjectCloseConfirmModal: FC<{
  open: boolean;
  projectTitle?: string;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ open, projectTitle, onClose, onConfirm }) => (
  <ModalTransition>
    {open && (
      <Modal autoFocus={false} onClose={onClose} width="small">
        <AppModalHeader title="Unsaved changes" onClose={onClose} />
        <ModalBody>
          <div css={unsavedProjectCloseModalBody}>
            <p>
              There are unsaved changes in <strong>{projectTitle ?? 'this project'}</strong>.
            </p>
            <p>Close this project tab anyway? Unsaved changes will be lost.</p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button appearance="danger" onClick={onConfirm}>
            Close without saving
          </Button>
        </ModalFooter>
      </Modal>
    )}
  </ModalTransition>
);

const ProjectFileMenu: FC = () => {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const runMenuCommandImpl = useRunMenuCommand();
  const hostUiConfig = useRivetAppHostUiConfig();
  const visibleFileMenuGroups = getVisibleFileMenuGroups(hostUiConfig.fileMenu);

  const runMenuCommand: typeof runMenuCommandImpl = (command) => {
    setFileMenuOpen(false);
    runMenuCommandImpl(command);
  };

  useEffect(() => {
    if (!fileMenuOpen) {
      return;
    }

    const handleWindowMouseDown = (event: MouseEvent) => {
      if (fileMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setFileMenuOpen(false);
    };

    window.addEventListener('mousedown', handleWindowMouseDown);

    return () => {
      window.removeEventListener('mousedown', handleWindowMouseDown);
    };
  }, [fileMenuOpen]);

  if (visibleFileMenuGroups.length === 0) {
    return null;
  }

  return (
    <div ref={fileMenuRef} className={clsx('file-menu', { open: fileMenuOpen })}>
      <button
        type="button"
        className="file-menu-button dropdown-item"
        aria-expanded={fileMenuOpen}
        aria-haspopup="menu"
        onClick={() => setFileMenuOpen((open) => !open)}
      >
        <img src={RivetLogo} alt="" aria-hidden="true" className="file-menu-logo" />
        Menu
      </button>
      <div className={clsx('file-dropdown', { open: fileMenuOpen })} role="menu">
        {visibleFileMenuGroups.map((group, groupIndex) => (
          <Fragment key={group.map((item) => item.id).join(':')}>
            {groupIndex > 0 && <div className="file-dropdown-separator" role="separator" />}
            {group.map((item) => (
              <button key={item.id} type="button" role="menuitem" onClick={() => runMenuCommand(item.id)}>
                {item.label}
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
};

export const SortableProject: FC<{
  projectId: ProjectId;
  projectTabsSelected: boolean;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({ projectId, onCloseProject, onSelectProject, projectTabsSelected }) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: projectId,
  });

  const constrainedTransformX = transform?.x ?? 0;

  return (
    <div
      className="draggableProject"
      ref={setNodeRef}
      style={{
        transform: `translate3d(${constrainedTransformX}px, 0px, 0)`,
        transition,
      }}
      {...attributes}
    >
      <ProjectTab
        projectId={projectId}
        dragListeners={listeners}
        onCloseProject={onCloseProject}
        onSelectProject={onSelectProject}
        projectTabsSelected={projectTabsSelected}
      />
    </div>
  );
};

export const ProjectTab: FC<{
  projectId: ProjectId;
  projectTabsSelected: boolean;
  dragListeners?: SyntheticListenerMap;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({ projectId, dragListeners, onCloseProject, onSelectProject, projectTabsSelected }) => {
  const openedProjects = useAtomValue(openedProjectsState);
  const projectUnsavedChanges = useAtomValue(projectUnsavedChangesState);
  const projectDataUnsavedChanges = useAtomValue(projectDataUnsavedChangesState);
  const currentProject = useAtomValue(projectState);

  const project = openedProjects[projectId];

  const unsaved = !project?.fsPath;
  const hasUnsavedChanges = hasProjectUnsavedChanges(projectUnsavedChanges, projectDataUnsavedChanges, projectId);
  const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\/]/).pop();
  const active = projectTabsSelected && currentProject.metadata.id === projectId;
  const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button === 0) {
      onSelectProject?.();
    }
  };

  const closeProject = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onCloseProject?.();
  };

  return (
    <div
      className={clsx('project', { active, unsaved, 'has-unsaved-changes': hasUnsavedChanges })}
      onMouseDown={handleMouseDown}
    >
      <div className="project-name" {...dragListeners}>
        <span>{projectDisplayName}</span>
      </div>
      {active && (
        <div className="actions">
          <button className="close-project" onMouseDown={(e) => e.stopPropagation()} onClick={closeProject}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
};
