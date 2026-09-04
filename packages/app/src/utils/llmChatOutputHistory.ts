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
 * Resolves a selected stored round. A selection can outlive history replacement
 * while an execution is replayed, so an unknown entry deliberately falls back
 * to the newest retained page instead of leaving the pager and content out of
 * sync.
 */
export function resolveLLMChatOutputHistoryEntry(
  entries: readonly LLMChatOutputHistoryEntryWithRefs[],
  selectedPage: LLMChatOutputPageValue,
): LLMChatOutputHistoryEntryWithRefs | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return selectedPage === 'latest'
    ? entries.at(-1)
    : entries.find((entry) => entry.entryId === selectedPage) ?? entries.at(-1);
}

/**
 * Historical pages are presentation-only. Terminal output data remains the
 * source of truth for node ports and graph execution. This selects the output
 * map rendered by the output surface and scopes a process-level terminal error
 * to its terminal page rather than copying it onto every earlier round.
 */
export function getSelectedLLMChatOutputHistoryData(options: {
  data: NodeRunDataWithRefs;
  selectedPage: LLMChatOutputPageValue;
  splitIndex?: number;
}): NodeRunDataWithRefs {
  const { data, selectedPage, splitIndex = 0 } = options;
  const entries = data.llmChatOutputHistory?.[splitIndex] ?? [];
  const hasTerminalOutput = data.outputData != null || data.splitOutputData != null;
  const selectedEntry = resolveLLMChatOutputHistoryEntry(entries, selectedPage);
  if (selectedPage === 'latest') {
    // An invocation can fail after completing a model round but before it has
    // produced terminal graph outputs (for example, a tool handler fails).
    // Present the newest retained round in that case while keeping the failure
    // status on the data so the invocation error remains visible.
    return !hasTerminalOutput && selectedEntry ? { ...data, outputData: selectedEntry.outputData } : data;
  }

  if (!selectedEntry) {
    return data;
  }

  return {
    ...data,
    outputData: selectedEntry.outputData,
    // A history event describes one logical split item. Avoid rendering the
    // terminal split map alongside the selected page.
    splitOutputData: undefined,
    // `status.error` belongs to the invocation as a whole. Keep it on `latest`
    // and on the newest retained round that led into the failure, but clear it
    // from every earlier completed snapshot.
    status: data.status?.type === 'error' && selectedEntry !== entries.at(-1) ? undefined : data.status,
  };
}

/**
 * A failed split invocation may have completed logical model rounds without
 * emitting a terminal split map. Give the normal split renderer a display-only
 * latest map for those completed items; ports and execution state still read
 * the original terminal data.
 */
export function getLLMChatSplitOutputHistoryPresentationData(
  data: NodeRunDataWithRefs,
  isSplitRun: boolean,
): NodeRunDataWithRefs {
  // History entries are keyed by split index even for an ordinary invocation,
  // whose only index is zero. Use the node's Run per item configuration rather
  // than optional timing telemetry to distinguish those cases. Turning a normal
  // multi-round failure into synthetic split output would bypass selected-round
  // status projection and make every historical page inherit the invocation
  // error.
  if (data.splitOutputData != null || data.outputData != null || !isSplitRun || !data.llmChatOutputHistory) {
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
