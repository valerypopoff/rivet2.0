import type { FC, MouseEvent } from 'react';
import { isPageBoundaryModifierClick } from '../pageNavigation.js';

export type NodeOutputPagerProps = {
  /** A settled, semantic page label (for example a Watch terminal iteration). */
  labelledPage?: { index: number; label: string };
  selectedPage: number | 'latest';
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onFirstPage?: () => void;
  onLastPage?: () => void;
  stopDoubleClickPropagation?: boolean;
};

export const NodeOutputPager: FC<NodeOutputPagerProps> = ({
  labelledPage,
  onNextPage,
  onPrevPage,
  selectedPage,
  stopDoubleClickPropagation = false,
  totalPages,
  onFirstPage,
  onLastPage,
}) => {
  const handleDoubleClick = stopDoubleClickPropagation ? (event: MouseEvent) => event.stopPropagation() : undefined;
  const handlePreviousPage = (event: MouseEvent<HTMLButtonElement>) => {
    if (onFirstPage && isPageBoundaryModifierClick(event)) {
      onFirstPage();
      return;
    }

    onPrevPage();
  };
  const handleNextPage = (event: MouseEvent<HTMLButtonElement>) => {
    if (onLastPage && isPageBoundaryModifierClick(event)) {
      onLastPage();
      return;
    }

    onNextPage();
  };

  return (
    <div className="picker">
      <button className="picker-left" onClick={handlePreviousPage} onDoubleClick={handleDoubleClick}>
        {'<'}
      </button>
      <div className="picker-page">{getNodeOutputPagerPageLabel(selectedPage, totalPages, labelledPage)}</div>
      <button className="picker-right" onClick={handleNextPage} onDoubleClick={handleDoubleClick}>
        {'>'}
      </button>
    </div>
  );
};

export function getNodeOutputPagerPageLabel(
  selectedPage: number | 'latest',
  totalPages: number,
  labelledPage?: { index: number; label: string },
): string | number {
  if (selectedPage !== 'latest' && labelledPage?.index === selectedPage) {
    return labelledPage.label;
  }

  return selectedPage === 'latest' ? totalPages : selectedPage + 1;
}
