import type { LLMChatOutputSnapshotEvent } from '@valerypopoff/rivet2-core';
import type {
  LLMChatOutputHistoryEntryWithRefs,
  LLMChatOutputPageValue,
  NodeRunDataWithRefs,
} from '../state/dataFlow.js';
import { collectStoredRefIds } from './executionDataStorage.js';

/**
 * Pure, ref-aware reducer shared by live execution and inactive-project
 * snapshots. Event redelivery updates an entry in place instead of creating a
 * duplicate page.
 */
export function upsertLLMChatOutputHistoryEntry(
  data: NodeRunDataWithRefs,
  entry: LLMChatOutputHistoryEntryWithRefs,
): { data: NodeRunDataWithRefs; replacedRefIds: string[] } {
  const bySplitIndex = data.llmChatOutputHistory ?? {};
  const existingEntries = bySplitIndex[entry.splitIndex] ?? [];
  const previousEntry = existingEntries.find((candidate) => candidate.entryId === entry.entryId);
  const nextEntryRefIds = new Set(collectStoredRefIds(entry.outputData));
  const nextEntries = previousEntry
    ? existingEntries.map((candidate) => (candidate.entryId === entry.entryId ? entry : candidate))
    : [...existingEntries, entry];

  return {
    data: {
      ...data,
      llmChatOutputHistory: {
        ...bySplitIndex,
        [entry.splitIndex]: nextEntries,
      },
    },
    // Snapshot events may be redelivered. Their history-specific storage scope
    // deliberately makes the replacement reuse the same refs; deleting every
    // previous ref after the upsert would therefore delete the new page too.
    // Release only ports that disappeared from the replacement.
    replacedRefIds: previousEntry
      ? collectStoredRefIds(previousEntry.outputData).filter((refId) => !nextEntryRefIds.has(refId))
      : [],
  };
}

export function removeLLMChatOutputHistorySelectionsForProcess<T extends Record<string, unknown>>(options: {
  nodeId: string;
  processId?: string;
  selections: T;
}): T {
  const prefix = options.processId == null ? `${options.nodeId}:` : `${options.nodeId}:${options.processId}:`;
  const entries = Object.entries(options.selections).filter(([key]) => !key.startsWith(prefix));
  return Object.fromEntries(entries) as T;
}

export function toLLMChatOutputHistoryEntry(
  event: LLMChatOutputSnapshotEvent,
  outputData: LLMChatOutputHistoryEntryWithRefs['outputData'],
): LLMChatOutputHistoryEntryWithRefs {
  return {
    entryId: event.entryId,
    kind: event.kind,
    outcome: event.outcome,
    outputData,
    roundIndex: event.roundIndex,
    splitIndex: event.splitIndex,
  };
}

/**
 * Historical pages are presentation-only. Terminal output data remains the
 * source of truth for node ports and graph execution; this only selects the
 * output map rendered by the output surface.
 */
export function getSelectedLLMChatOutputHistoryData(options: {
  data: NodeRunDataWithRefs;
  selectedPage: LLMChatOutputPageValue;
  splitIndex?: number;
}): NodeRunDataWithRefs {
  const { data, selectedPage, splitIndex = 0 } = options;
  const entries = data.llmChatOutputHistory?.[splitIndex] ?? [];
  if (selectedPage === 'latest') {
    // An invocation can fail after completing a model round but before it has
    // produced terminal graph outputs (for example, a tool handler fails).
    // Present the newest retained round in that case while keeping the failure
    // status on the data so the invocation error remains visible.
    const latestEntry = entries.at(-1);
    return data.outputData == null && data.splitOutputData == null && latestEntry
      ? { ...data, outputData: latestEntry.outputData }
      : data;
  }

  const selectedEntry = entries.find((entry) => entry.entryId === selectedPage);
  if (!selectedEntry) {
    return data;
  }

  return {
    ...data,
    outputData: selectedEntry.outputData,
    // A history event describes one logical split item. Avoid rendering the
    // terminal split map alongside the selected page.
    splitOutputData: undefined,
  };
}

/**
 * A failed split invocation may have completed logical model rounds without
 * emitting a terminal split map. Give the normal split renderer a display-only
 * latest map for those completed items; ports and execution state still read
 * the original terminal data.
 */
export function getLLMChatSplitOutputHistoryPresentationData(data: NodeRunDataWithRefs): NodeRunDataWithRefs {
  if (data.splitOutputData != null || data.outputData != null || !data.llmChatOutputHistory) {
    return data;
  }

  const splitOutputData = Object.fromEntries(
    Object.entries(data.llmChatOutputHistory)
      .map(([splitIndex, entries]) => {
        const latestEntry = entries.at(-1);
        return latestEntry ? [Number(splitIndex), latestEntry.outputData] : undefined;
      })
      .filter((entry): entry is [number, LLMChatOutputHistoryEntryWithRefs['outputData']] => entry != null),
  );

  return Object.keys(splitOutputData).length > 0 ? { ...data, splitOutputData } : data;
}

export function shouldShowLLMChatOutputHistoryPager(options: {
  entries: LLMChatOutputHistoryEntryWithRefs[];
  hasTerminalOutput: boolean;
}): boolean {
  return options.entries.length > 1 || (!options.hasTerminalOutput && options.entries.length > 0);
}

export function getLLMChatOutputHistoryPageLabel(entry: LLMChatOutputHistoryEntryWithRefs): string {
  if (entry.kind === 'direct-tool-result') {
    return 'Direct tool result';
  }

  const outcomeLabel =
    entry.outcome === 'tool-calls'
      ? 'Requested tools'
      : entry.outcome === 'final-answer'
        ? 'Final answer'
        : entry.outcome === 'max-rounds'
          ? 'Maximum rounds reached'
          : entry.outcome === 'provider-failure'
            ? 'Provider failure'
            : entry.outcome === 'unresolved-tool-calls'
              ? 'Unresolved tool calls'
              : 'Direct tool result';
  return `Round ${entry.roundIndex + 1} · ${outcomeLabel}`;
}
