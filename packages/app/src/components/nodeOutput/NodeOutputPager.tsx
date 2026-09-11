import type { FC, MouseEvent } from 'react';

export type NodeOutputPagerProps = {
  latestPageLabel?: string;
  selectedPage: number | 'latest';
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  stopDoubleClickPropagation?: boolean;
};

export const NodeOutputPager: FC<NodeOutputPagerProps> = ({
  latestPageLabel,
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
      <div className="picker-page">{getNodeOutputPagerPageLabel(selectedPage, totalPages, latestPageLabel)}</div>
      <button className="picker-right" onClick={onNextPage} onDoubleClick={handleDoubleClick}>
        {'>'}
      </button>
    </div>
  );
};

export function getNodeOutputPagerPageLabel(
  selectedPage: number | 'latest',
  totalPages: number,
  latestPageLabel?: string,
): string | number {
  if (selectedPage === 'latest' || (latestPageLabel != null && selectedPage === totalPages - 1)) {
    return latestPageLabel ?? totalPages;
  }

  return selectedPage + 1;
}
