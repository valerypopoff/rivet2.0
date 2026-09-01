import type { LLMChatOutputHistoryEntryWithRefs, LLMChatOutputPageValue } from '../../state/dataFlow.js';
import { getLLMChatOutputHistoryPageLabel } from '../../utils/llmChatOutputHistory.js';
import type { FC, MouseEvent } from 'react';

export type LLMChatOutputHistoryPagerProps = {
  entries: LLMChatOutputHistoryEntryWithRefs[];
  forceVisible?: boolean;
  /** `latest` currently renders a partial output rather than a completed page. */
  showLivePage?: boolean;
  selectedPage: LLMChatOutputPageValue;
  onSelectPage: (page: LLMChatOutputPageValue) => void;
};

/** Nested LLM pager; process paging stays separate in NodeOutputPager. */
export const LLMChatOutputHistoryPager: FC<LLMChatOutputHistoryPagerProps> = ({
  entries,
  forceVisible = false,
  showLivePage = false,
  selectedPage,
  onSelectPage,
}) => {
  if (entries.length === 0 || (entries.length < 2 && !forceVisible && !showLivePage)) {
    return null;
  }

  const requestedIndex = selectedPage === 'latest' ? -1 : entries.findIndex((entry) => entry.entryId === selectedPage);
  const isLatestPage = selectedPage === 'latest' && showLivePage;
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : entries.length - 1;
  const selectedEntry = entries[selectedIndex];
  if (!isLatestPage && !selectedEntry) {
    return null;
  }

  const handlePointerDown = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();
  const previousPage = isLatestPage ? entries.at(-1) : entries[selectedIndex - 1];
  const nextPage = isLatestPage ? undefined : entries[selectedIndex + 1];
  const canGoToLatestPage = showLivePage && !isLatestPage;

  return (
    <div className="picker llm-chat-output-history-pager" onMouseDown={handlePointerDown}>
      <button
        aria-label="Show previous LLM response round"
        className="picker-left"
        disabled={!previousPage}
        onClick={() => previousPage && onSelectPage(previousPage.entryId)}
        type="button"
      >
        {'<'}
      </button>
      <div className="picker-page llm-chat-output-history-pager-label">
        {isLatestPage ? 'Current response · Running' : getLLMChatOutputHistoryPageLabel(selectedEntry!)}
      </div>
      <button
        aria-label="Show next LLM response round"
        className="picker-right"
        disabled={!nextPage && !canGoToLatestPage}
        onClick={() => onSelectPage(nextPage ? nextPage.entryId : 'latest')}
        type="button"
      >
        {'>'}
      </button>
    </div>
  );
};
