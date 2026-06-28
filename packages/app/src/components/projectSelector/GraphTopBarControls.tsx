import { type FC, type ReactNode } from 'react';

import { useAtom } from 'jotai';
import clsx from 'clsx';
import LeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import RightIcon from 'majesticons/line/chevron-right-line.svg?react';

import {
  GRAPH_HISTORY_NEXT_TOOLTIP,
  GRAPH_HISTORY_PREVIOUS_TOOLTIP,
  GRAPH_TREE_TOGGLE_SHORTCUT_LABEL,
} from '../../hooks/canvasNavigationShortcuts.js';
import { useGraphHistoryNavigation } from '../../hooks/useGraphHistoryNavigation.js';
import { sidebarOpenState } from '../../state/graphBuilder.js';
import { Tooltip } from '../Tooltip.js';

export const GraphTreeSidebarToggle: FC = () => {
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

export const GraphHistoryControls: FC = () => {
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
}> = ({ children, disabled, label, onClick, tooltip }) => (
  <Tooltip content={tooltip} placement="bottom" className="graph-history-tooltip">
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
  </Tooltip>
);
