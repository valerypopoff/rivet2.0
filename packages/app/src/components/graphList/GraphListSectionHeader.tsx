import type { FC, KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import FilterIcon from 'majesticons/line/filter-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { Tooltip } from '../Tooltip.js';
import { GRAPH_FILTER_INPUT_MARKER } from './graphFilterFocus.js';

export const GraphListSectionHeader: FC<{
  filterOpen: boolean;
  onCloseFilter(): void;
  onFilterTextChange(value: string): void;
  onOpenFilter(): void;
  searchText: string;
}> = ({ filterOpen, onCloseFilter, onFilterTextChange, onOpenFilter, searchText }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (filterOpen) {
      inputRef.current?.focus();
    }
  }, [filterOpen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseFilter();
    }
  };

  if (filterOpen) {
    return (
      <div className="graph-list-section-header graph-list-section-filter">
        <FilterIcon aria-hidden="true" className="graph-list-section-filter-icon" />
        <input
          {...GRAPH_FILTER_INPUT_MARKER}
          ref={inputRef}
          aria-label="Filter graphs"
          autoComplete="off"
          spellCheck={false}
          type="text"
          value={searchText}
          onChange={(event) => onFilterTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="graph-list-filter-close"
          onClick={onCloseFilter}
          aria-label="Close graph filter"
        >
          <CrossIcon aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="graph-list-section-header">
      <span className="graph-list-heading">Graphs</span>
      <Tooltip content="Filter graphs" placement="right" tag="span" className="graph-list-filter-tooltip">
        <button type="button" className="graph-list-filter-toggle" onClick={onOpenFilter} aria-label="Filter graphs">
          <FilterIcon aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
};
