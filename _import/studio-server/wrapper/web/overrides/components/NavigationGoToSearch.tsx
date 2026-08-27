import clsx from 'clsx';
import { useAtom, useAtomValue } from 'jotai';
import { useEffect, type FC } from 'react';
import { type NodeId } from '@valerypopoff/rivet2-core';
import {
  goToSearchState,
} from '../../../../rivet/packages/app/src/state/graphBuilder';
import {
  useSearchProject,
  type SearchedItem,
} from '../../../../rivet/packages/app/src/hooks/useSearchProject';
import { projectState } from '../../../../rivet/packages/app/src/state/savedGraphs';
import { useGoToNode } from '../../../../rivet/packages/app/src/hooks/useGoToNode';

export const NavigationGoToSearch: FC = () => {
  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);
  const results = useSearchProject(goToSearch.query, goToSearch.searching);

  useEffect(() => {
    setGoToSearch((search) => ({
      ...search,
      entries: results,
    }));
  }, [results.map((result) => result.item.id).join(','), setGoToSearch]);

  return (
    <div className="entries">
      {goToSearch.entries.map((entry, index) => (
        <div key={entry.item.id} className="entry">
          <SearchResultItem entry={entry} selected={index === goToSearch.selectedIndex} searchText={goToSearch.query} />
        </div>
      ))}
    </div>
  );
};

const SearchResultItem: FC<{
  entry: SearchedItem;
  searchText: string;
  selected: boolean;
}> = ({ entry, selected, searchText }) => {
  const project = useAtomValue(projectState);
  const goToNode = useGoToNode();

  useEffect(() => {
    if (selected) {
      const element = document.querySelector('.search-result-item.selected');
      element?.scrollIntoView({ block: 'nearest' });
      goToNode(entry.item.id as NodeId);
    }
  }, [selected, entry.item.id, goToNode]);

  return (
    <div className={clsx('search-result-item', { selected })}>
      <div className="title">
        <HighlightedText text={entry.item.title} searchText={searchText} />
      </div>
      <div className="graph">in {project.graphs[entry.item.containerGraph]?.metadata?.name ?? 'Unknown Graph'}</div>
      <div className="description">
        <HighlightedText text={entry.item.description} searchText={searchText} />
      </div>
      <div className="data">
        <HighlightedText text={entry.item.joinedData} searchText={searchText} />
      </div>
    </div>
  );
};

interface HighlightedTextProps {
  text: string;
  searchText: string;
  className?: string;
  highlightClassName?: string;
  contextAmount?: number;
}

interface Range {
  start: number;
  end: number;
}

const HighlightedText: FC<HighlightedTextProps> = ({
  text,
  searchText,
  className = '',
  highlightClassName = 'highlighted',
  contextAmount = 100,
}) => {
  if (!searchText.trim() || !text) {
    return <span className={className}>{text}</span>;
  }

  const searchWords = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (searchWords.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const ranges: Range[] = [];

  searchWords.forEach((word) => {
    const textLower = text.toLowerCase();
    let startIndex = 0;

    while (startIndex < text.length) {
      const matchIndex = textLower.indexOf(word, startIndex);
      if (matchIndex === -1) {
        break;
      }

      ranges.push({
        start: matchIndex,
        end: matchIndex + word.length,
      });
      startIndex = matchIndex + 1;
    }
  });

  if (ranges.length === 0) {
    return <span className={className}>{text.substring(0, contextAmount)}</span>;
  }

  const sortedRanges = ranges.sort((left, right) => left.start - right.start);

  const mergedRanges = sortedRanges.reduce<Range[]>((accumulator, current) => {
    if (accumulator.length === 0) {
      return [current];
    }

    const previous = accumulator[accumulator.length - 1]!;

    if (current.start <= previous.end) {
      accumulator[accumulator.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, current.end),
      };
    } else {
      accumulator.push(current);
    }
    return accumulator;
  }, []);

  const firstMatch = mergedRanges[0]!;
  const lastMatch = mergedRanges[mergedRanges.length - 1];

  if (!firstMatch || !lastMatch) {
    return <span className={className}>{text}</span>;
  }

  const visibleStart = Math.max(0, firstMatch.start - contextAmount);
  const visibleEnd = Math.min(text.length, lastMatch.end + contextAmount);
  const adjustedRanges = mergedRanges.map((range) => ({
    start: range.start - visibleStart,
    end: range.end - visibleStart,
  }));
  const trimmedText = text.slice(visibleStart, visibleEnd);
  const showStartEllipsis = visibleStart > 0;
  const showEndEllipsis = visibleEnd < text.length;

  const segments: JSX.Element[] = [];
  let lastIndex = 0;

  if (showStartEllipsis) {
    segments.push(<span key="start-ellipsis">...</span>);
  }

  adjustedRanges.forEach((range, index) => {
    if (range.start > lastIndex) {
      segments.push(<span key={`text-${index}`}>{trimmedText.substring(lastIndex, range.start)}</span>);
    }

    segments.push(
      <span key={`highlight-${index}`} className={highlightClassName}>
        {trimmedText.substring(range.start, range.end)}
      </span>,
    );

    lastIndex = range.end;
  });

  if (lastIndex < trimmedText.length) {
    segments.push(<span key={`text-${adjustedRanges.length}`}>{trimmedText.substring(lastIndex)}</span>);
  }

  if (showEndEllipsis) {
    segments.push(<span key="end-ellipsis">...</span>);
  }

  return <span className={className}>{segments}</span>;
};
