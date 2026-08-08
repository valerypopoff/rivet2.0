import clsx from 'clsx';
import type { FC, KeyboardEvent, SVGProps } from 'react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import { Tooltip } from '../Tooltip.js';
import { SubgraphLinkIcon } from '../visualNode/SubgraphLinkIcon.js';
import { GRAPH_FILTER_INPUT_MARKER } from './graphFilterFocus.js';

export const GraphListHeader: FC<{
  hasWebApps: boolean;
  nodeLibraryItemCount: number;
  nodeLibraryOpen: boolean;
  onClearFilter(): void;
  onCreateWebApp(): void;
  onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  onFilterTextChange(value: string): void;
  onOpenNodeLibrary(): void;
  onOpenProjectSettings(): void;
  onOpenSearch(): void;
  projectTitle: string;
  searchText: string;
}> = ({
  hasWebApps,
  nodeLibraryItemCount,
  nodeLibraryOpen,
  onClearFilter,
  onCreateWebApp,
  onFilterKeyDown,
  onFilterTextChange,
  onOpenNodeLibrary,
  onOpenProjectSettings,
  onOpenSearch,
  projectTitle,
  searchText,
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
      <div className="graph-list-filter">
        <label className="graph-list-filter-label">
          <FilterIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-filter" />
          <input
            {...GRAPH_FILTER_INPUT_MARKER}
            aria-label="Filter graphs"
            autoComplete="off"
            spellCheck={false}
            type="text"
            placeholder="Filter graphs"
            value={searchText}
            onChange={(event) => onFilterTextChange(event.target.value)}
            onKeyDown={onFilterKeyDown}
          />
        </label>
        {searchText.length > 0 && (
          <button type="button" className="clear" onClick={onClearFilter} aria-label="Clear graph filter">
            <CrossIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-filter-clear" />
          </button>
        )}
      </div>
      {!hasWebApps && (
        <button type="button" className="graph-list-action" onClick={onCreateWebApp}>
          <PlusIcon aria-hidden="true" className="project-tree-panel-icon" />
          <span>Create web app</span>
        </button>
      )}
    </div>
  </div>
);

const FilterIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" {...props}>
    <path d="M2.5 3.5h11L9.25 8.35v3.4l-2.5.9v-4.3L2.5 3.5Z" fill="currentColor" />
  </svg>
);
