import type { NodeId, ProcessId } from '@valerypopoff/rivet2-core';
import { useAtom } from 'jotai';
import type { FC, ReactNode } from 'react';
import {
  type InputsOrOutputsWithRefs,
  type LLMChatOutputHistoryEntryWithRefs,
  getLLMChatOutputHistorySelectionKey,
  selectedLLMChatOutputPageState,
} from '../../state/dataFlow.js';
import { resolveLLMChatOutputHistoryEntry } from '../../utils/llmChatOutputHistory.js';
import { LLMChatOutputHistoryPager } from './LLMChatOutputHistoryPager.js';

export const LLMChatSplitOutputHistory: FC<{
  nodeId: NodeId;
  processId: ProcessId;
  splitIndex: number;
  entries: LLMChatOutputHistoryEntryWithRefs[] | undefined;
  hasTerminalOutput: boolean;
  isRunning: boolean;
  latestOutputs: InputsOrOutputsWithRefs;
  renderOutputs: (outputs: InputsOrOutputsWithRefs) => ReactNode;
}> = ({ nodeId, processId, splitIndex, entries = [], hasTerminalOutput, isRunning, latestOutputs, renderOutputs }) => {
  const selectionKey = getLLMChatOutputHistorySelectionKey(nodeId, processId, splitIndex);
  const [selectedPage, setSelectedPage] = useAtom(selectedLLMChatOutputPageState(selectionKey));
  const selectedEntry = resolveLLMChatOutputHistoryEntry(entries, selectedPage);
  const selectedOutputs = selectedPage === 'latest' ? latestOutputs : selectedEntry?.outputData ?? latestOutputs;

  return (
    <div className="llm-chat-split-output-history">
      <LLMChatOutputHistoryPager
        entries={entries}
        forceVisible={entries.length > 0 && !hasTerminalOutput}
        showLivePage={isRunning && hasTerminalOutput}
        selectedPage={selectedPage}
        onSelectPage={setSelectedPage}
      />
      {renderOutputs(selectedOutputs)}
    </div>
  );
};
