import clsx from 'clsx';
import type { FC } from 'react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import { Tooltip } from '../Tooltip.js';
import { SubgraphLinkIcon } from '../visualNode/SubgraphLinkIcon.js';

export const GraphListHeader: FC<{
  hasWebApps: boolean;
  nodeLibraryItemCount: number;
  nodeLibraryOpen: boolean;
  onCreateWebApp(): void;
  onOpenNodeLibrary(): void;
  onOpenProjectSettings(): void;
  onOpenSearch(): void;
  projectTitle: string;
}> = ({
  hasWebApps,
  nodeLibraryItemCount,
  nodeLibraryOpen,
  onCreateWebApp,
  onOpenNodeLibrary,
  onOpenProjectSettings,
  onOpenSearch,
  projectTitle,
}) => (
  <div className="project-tree-panel-header">
    <div className="project-tree-header">
      <span className="project-tree-header-label">Project:</span>
      <span className="project-tree-header-title">{projectTitle}</span>
    </div>
    <div className="graph-list-toolbar">
      <Tooltip content="Search (Ctrl/Cmd+F)" placement="right" tag="span" className="graph-list-action-tooltip">
        <button type="button" className="graph-list-action" onClick={onOpenSearch}>
          <SearchIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-search" />
          <span>Search</span>
        </button>
      </Tooltip>
      <button type="button" className="graph-list-action" onClick={onOpenProjectSettings}>
        <SettingsCogIcon
          aria-hidden="true"
          className="project-tree-panel-icon project-tree-panel-icon-project-settings"
        />
        <span>Project settings</span>
      </button>
      <button
        type="button"
        className={clsx('graph-list-action', { selected: nodeLibraryOpen })}
        aria-current={nodeLibraryOpen ? 'page' : undefined}
        onClick={onOpenNodeLibrary}
      >
        <span className="project-tree-panel-icon project-tree-panel-icon-node-library">
          <SubgraphLinkIcon />
        </span>
        <span>Node library</span>
        {nodeLibraryItemCount > 0 && (
          <span className="graph-folder-count">
            <span>{nodeLibraryItemCount}</span>
          </span>
        )}
      </button>
      {!hasWebApps && (
        <button type="button" className="graph-list-action" onClick={onCreateWebApp}>
          <PlusIcon aria-hidden="true" className="project-tree-panel-icon" />
          <span>Create web app</span>
        </button>
      )}
    </div>
  </div>
);
