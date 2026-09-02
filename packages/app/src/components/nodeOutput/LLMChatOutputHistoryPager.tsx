import type { LLMChatOutputHistoryEntryWithRefs, LLMChatOutputPageValue } from '../../state/dataFlow.js';
import {
  getLLMChatOutputHistoryPageLabel,
  resolveLLMChatOutputHistoryEntry,
} from '../../utils/llmChatOutputHistory.js';
import type { FC, MouseEvent } from 'react';

export type LLMChatOutputHistoryPagerProps = {
  /** Uses the compact header placement while retaining the full round label. */
  compact?: boolean;
  entries: LLMChatOutputHistoryEntryWithRefs[];
  forceVisible?: boolean;
  /** `latest` currently renders a partial output rather than a completed page. */
  showLivePage?: boolean;
  selectedPage: LLMChatOutputPageValue;
  onSelectPage: (page: LLMChatOutputPageValue) => void;
};

/** Nested LLM pager; process paging stays separate in NodeOutputPager. */
export const LLMChatOutputHistoryPager: FC<LLMChatOutputHistoryPagerProps> = ({
  compact = false,
  entries,
  forceVisible = false,
  showLivePage = false,
  selectedPage,
  onSelectPage,
}) => {
  if (entries.length === 0 || (entries.length < 2 && !forceVisible && !showLivePage)) {
    return null;
  }

  const isLatestPage = selectedPage === 'latest' && showLivePage;
  const selectedEntry = resolveLLMChatOutputHistoryEntry(entries, selectedPage);
  const selectedIndex = selectedEntry ? entries.indexOf(selectedEntry) : -1;
  if (!isLatestPage && !selectedEntry) {
    return null;
  }

  const handlePointerDown = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();
  const previousPage = isLatestPage ? entries.at(-1) : entries[selectedIndex - 1];
  const nextPage = isLatestPage ? undefined : entries[selectedIndex + 1];
  const canGoToLatestPage = showLivePage && !isLatestPage;
  const selectedPageLabel = isLatestPage
    ? 'Current response · Running'
    : getLLMChatOutputHistoryPageLabel(selectedEntry!);

  return (
    <div
      className={`picker llm-chat-output-history-pager${compact ? ' compact' : ''}`}
      onMouseDown={handlePointerDown}
      title={selectedPageLabel}
    >
      <button
        aria-label="Show previous LLM response round"
        className="picker-left"
        disabled={!previousPage}
        onClick={() => previousPage && onSelectPage(previousPage.entryId)}
        type="button"
      >
        {'<'}
      </button>
      <div
        aria-label={selectedPageLabel}
        aria-live="polite"
        className="picker-page llm-chat-output-history-pager-label"
        role="status"
      >
        {selectedPageLabel}
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
