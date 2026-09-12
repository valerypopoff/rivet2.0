import type { FC, MouseEvent } from 'react';

export type NodeOutputPagerProps = {
  /** A settled, semantic page label (for example a Watch terminal iteration). */
  labelledPage?: { index: number; label: string };
  selectedPage: number | 'latest';
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  stopDoubleClickPropagation?: boolean;
};

export const NodeOutputPager: FC<NodeOutputPagerProps> = ({
  labelledPage,
  onNextPage,
  onPrevPage,
  selectedPage,
  stopDoubleClickPropagation = false,
  totalPages,
}) => {
  const handleDoubleClick = stopDoubleClickPropagation ? (event: MouseEvent) => event.stopPropagation() : undefined;

  return (
    <div className="picker">
      <button className="picker-left" onClick={onPrevPage} onDoubleClick={handleDoubleClick}>
        {'<'}
      </button>
      <div className="picker-page">{getNodeOutputPagerPageLabel(selectedPage, totalPages, labelledPage)}</div>
      <button className="picker-right" onClick={onNextPage} onDoubleClick={handleDoubleClick}>
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
