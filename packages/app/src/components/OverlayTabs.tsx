import { css } from '@emotion/react';
import { type FC, type ReactNode, useEffect, useMemo } from 'react';

import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import clsx from 'clsx';
import { trivetState } from '../state/trivet.js';
import { LoadingSpinner } from './LoadingSpinner.js';
import { type OverlayKey, overlayOpenState } from '../state/ui';
import { hideGraphSearchPanelState, searchingGraphState } from '../state/graphBuilder';
import { projectState } from '../state/savedGraphs.js';
import { graphState } from '../state/graph.js';
import { lastRunDataByNodeState } from '../state/dataFlow.js';
import { hasChatViewerRows } from '../utils/chatViewerData.js';
import { getVisibleWorkspaceTabs } from '../utils/workspaceTabs.js';

const styles = css`
  display: flex;
  align-items: stretch;
  align-self: stretch;
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(760px, 65vw);
  border-left: 1px solid var(--project-selector-divider-color, var(--app-strip-divider-color));

  .left-menu {
    display: flex;
    align-items: stretch;
    gap: 0;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
    user-select: none;
  }

  .left-menu::-webkit-scrollbar {
    display: none;
  }

  .menu-item {
    position: relative;
    background-color: transparent;
    color: var(--grey-light);
    border: none;
    transition:
      background-color 0.2s ease-out,
      color 0.2s ease-out;
    border-right: 1px solid var(--project-selector-divider-color, var(--app-strip-divider-color));

    margin: 0;
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
    height: 100%;

    background: var(--project-selector-strip-bg, var(--app-strip-bg));
  }

  .menu-item > button {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0 12px;
    color: inherit;
    font-size: var(--ui-font-size-sm);
    line-height: 1;
    min-height: 0;
    min-width: 0;
    text-align: center;
    white-space: nowrap;
  }

  .menu-item:hover {
    background-color: var(--grey-darkish);
  }

  .menu-item.active {
    background-color: var(--primary);
    color: var(--foreground-on-primary);

    &:hover {
      background-color: var(--primary-dark);
    }
  }

  .trivet-menu button {
    display: flex;
    flex-direction: row;

    .spinner {
      margin-left: 4px;
    }
  }

  .trivet-menu.active .spinner svg {
    color: var(--grey-dark);
  }
`;

export const OverlayTabs: FC<{
  showWelcomeScreen?: boolean;
}> = ({ showWelcomeScreen = false }) => {
  const [openOverlay, setOpenOverlay] = useAtom(overlayOpenState);
  const setGraphSearch = useSetAtom(searchingGraphState);

  const trivet = useAtomValue(trivetState);
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const allLastRunData = useAtomValue(lastRunDataByNodeState);

  const chatViewerAvailable = useMemo(
    () => hasChatViewerRows(project.graphs, currentGraph, allLastRunData),
    [allLastRunData, currentGraph, project.graphs],
  );

  useEffect(() => {
    if (openOverlay === 'chatViewer' && !chatViewerAvailable) {
      setOpenOverlay(undefined);
    }
  }, [chatViewerAvailable, openOverlay, setOpenOverlay]);

  const openWorkspace = (workspace: OverlayKey | undefined) => {
    setOpenOverlay((current) => (current === workspace ? undefined : workspace));
    setGraphSearch(hideGraphSearchPanelState);
  };

  const visibleWorkspaceTabs = getVisibleWorkspaceTabs({
    chatViewerAvailable,
    openOverlay,
    welcomeScreenAvailable: showWelcomeScreen,
  });

  return (
    <nav css={styles} aria-label="Workspace navigation">
      <div className="left-menu">
        {visibleWorkspaceTabs.map((tab) => (
          <WorkspaceTab
            key={tab.key}
            className={tab.className}
            active={openOverlay === tab.targetOverlay}
            onOpen={() => openWorkspace(tab.targetOverlay)}
          >
            {tab.label}
            {tab.key === 'trivet' && trivet.runningTests && (
              <div className="spinner">
                <LoadingSpinner />
              </div>
            )}
          </WorkspaceTab>
        ))}
      </div>
    </nav>
  );
};

const WorkspaceTab: FC<{
  active: boolean;
  children: ReactNode;
  className: string;
  onOpen: () => void;
}> = ({ active, children, className, onOpen }) => (
  <div className={clsx('menu-item', className, { active })}>
    <button
      type="button"
      className="dropdown-item"
      onMouseDown={(e) => {
        if (e.button === 0) {
          onOpen();
        }
      }}
    >
      {children}
    </button>
  </div>
);
