import { produce } from 'immer';
import type { GraphExecutionMetadata, ProcessEvents, NodeId, ProcessId } from '@valerypopoff/rivet2-core';
import type {
  LLMChatOutputHistoryEntryWithRefs,
  NodeRunData,
  NodeRunDataWithRefs,
  RunDataByNodeId,
} from '../state/dataFlow.js';
import type { ProcessQuestions } from '../state/userInput.js';
import { collectStoredRefIds } from '../utils/executionDataStorage.js';
import { upsertLLMChatOutputHistoryEntry } from '../utils/llmChatOutputHistory.js';

/** A history page is observational: it must not replace terminal outputs or selection. */
export function updateLLMChatOutputHistory(
  previous: RunDataByNodeId,
  event: ProcessEvents['llmChatOutputSnapshot'],
  entry: LLMChatOutputHistoryEntryWithRefs,
  previousDataPerNodeToKeep?: number,
): { runData: RunDataByNodeId; obsoleteRefIds: string[]; evictedProcessIds: ProcessId[] } {
  const process = previous[event.nodeId]?.find((candidate) => candidate.processId === event.processId);
  const updated = upsertLLMChatOutputHistoryEntry(process?.data ?? {}, entry);
  const result = updateNodeRunData(previous, {
    nodeId: event.nodeId,
    processId: event.processId,
    execution: process ? undefined : event.execution,
    data: { llmChatOutputHistory: updated.data.llmChatOutputHistory },
    previousDataPerNodeToKeep,
  });
  return {
    runData: result.runData,
    evictedProcessIds: result.evictedProcessIds,
    obsoleteRefIds: [...new Set([...updated.replacedRefIds, ...result.obsoleteRefIds])],
  };
}

/** A terminal invocation must not leave a prompt blocking other live branches. */
export function removeUserInputQuestionsForProcess(
  questions: Record<NodeId, ProcessQuestions[]>,
  nodeId: NodeId,
  processId: ProcessId,
): Record<NodeId, ProcessQuestions[]> {
  const pending = questions[nodeId];
  if (!pending) return questions;
  const remaining = pending.filter((request) => request.processId !== processId);
  if (remaining.length === pending.length) return questions;
  const next = { ...questions };
  if (remaining.length > 0) next[nodeId] = remaining;
  else delete next[nodeId];
  return next;
}

export function prepareNodeRunDataForStorage(data: Partial<NodeRunData>): Partial<NodeRunData> {
  if (data.status?.type !== 'running' || (data.outputData === undefined && data.splitOutputData === undefined)) {
    return data;
  }

  const { outputData: _outputData, splitOutputData: _splitOutputData, ...dataWithoutOutputs } = data;
  return dataWithoutOutputs;
}

export function mergeNodeRunDataForProcess(
  previousData: NodeRunDataWithRefs,
  nextData: Partial<NodeRunDataWithRefs>,
): NodeRunDataWithRefs {
  const mergedData = {
    ...previousData,
    ...nextData,
  };

  if (nextData.recordedTiming !== undefined) {
    mergedData.recordedTiming = {
      ...previousData.recordedTiming,
      ...nextData.recordedTiming,
    };
  }

  // Split pages are independently streamed through partialOutput, while a
  // terminal error contributes more pages as diagnostic evidence. Both are
  // index-level patches, never replacements for already retained siblings.
  if (nextData.splitOutputData !== undefined) {
    mergedData.splitOutputData = {
      ...previousData.splitOutputData,
      ...nextData.splitOutputData,
    };
  }

  if (nextData.status?.type === 'running' && isTerminalNodeRunStatus(previousData.status)) {
    mergedData.status = previousData.status;
    copyOptionalNodeRunField(previousData, mergedData, 'startedAt');
    copyOptionalNodeRunField(previousData, mergedData, 'finishedAt');
    copyOptionalNodeRunField(previousData, mergedData, 'recordedTiming');
    copyOptionalNodeRunField(previousData, mergedData, 'durationMs');
    copyOptionalNodeRunField(previousData, mergedData, 'splitRunDurationMs');
    copyOptionalNodeRunField(previousData, mergedData, 'outputData');
    copyOptionalNodeRunField(previousData, mergedData, 'splitOutputData');
  }

  return mergedData;
}

function copyOptionalNodeRunField<T extends keyof NodeRunDataWithRefs>(
  source: NodeRunDataWithRefs,
  target: NodeRunDataWithRefs,
  key: T,
): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}

export function isTerminalNodeRunStatus(status: NodeRunDataWithRefs['status']): boolean {
  return (
    status?.type === 'ok' || status?.type === 'error' || status?.type === 'notRan' || status?.type === 'interrupted'
  );
}

export function collectReplacedRefIds(
  previousData: NodeRunDataWithRefs,
  nextData: Partial<NodeRunDataWithRefs>,
): string[] {
  const previousRefIds = new Set<string>();
  const nextRefIds = new Set<string>();

  if (nextData.inputData !== undefined) {
    for (const refId of collectStoredRefIds(previousData.inputData)) {
      previousRefIds.add(refId);
    }
    for (const refId of collectStoredRefIds(nextData.inputData)) {
      nextRefIds.add(refId);
    }
  }

  if (nextData.outputData !== undefined) {
    for (const refId of collectStoredRefIds(previousData.outputData)) {
      previousRefIds.add(refId);
    }
    for (const refId of collectStoredRefIds(nextData.outputData)) {
      nextRefIds.add(refId);
    }
  }

  if (nextData.splitOutputData !== undefined) {
    for (const previousSplitData of Object.values(previousData.splitOutputData ?? {})) {
      for (const refId of collectStoredRefIds(previousSplitData)) {
        previousRefIds.add(refId);
      }
    }
    for (const nextSplitData of Object.values(nextData.splitOutputData)) {
      for (const refId of collectStoredRefIds(nextSplitData)) {
        nextRefIds.add(refId);
      }
    }
  }

  return [...previousRefIds].filter((refId) => !nextRefIds.has(refId));
}
/** Shared state mutation; storage allocation/deletion and view selection stay with adapters. */
export function clearNodeRunData(
  previous: RunDataByNodeId,
  nodeId: NodeId,
  processId?: ProcessId,
): { runData: RunDataByNodeId; obsoleteRefIds: string[] } {
  const obsoleteRefIds: string[] = [];
  const runData = produce(previous, (draft) => {
    const runs = draft[nodeId];
    if (!runs) return;
    if (processId) {
      const index = runs.findIndex((process) => process.processId === processId);
      if (index !== -1) {
        obsoleteRefIds.push(...collectStoredRefIds(runs[index]!.data));
        runs.splice(index, 1);
      }
    } else {
      obsoleteRefIds.push(...runs.flatMap((process) => collectStoredRefIds(process.data)));
      delete draft[nodeId];
    }
  });
  return { runData, obsoleteRefIds };
}

/** Shared state mutation; storage allocation/deletion and view selection stay with adapters. */
export function updateNodeRunData(
  previous: RunDataByNodeId,
  options: {
    nodeId: NodeId;
    processId: ProcessId;
    execution?: GraphExecutionMetadata;
    data: Partial<NodeRunDataWithRefs>;
    ignoreIfTerminal?: boolean;
    previousDataPerNodeToKeep?: number;
  },
): { runData: RunDataByNodeId; obsoleteRefIds: string[]; evictedProcessIds: ProcessId[]; applied: boolean } {
  const { nodeId, processId, execution, data } = options;
  const obsoleteRefIds: string[] = [];
  const evictedProcessIds: ProcessId[] = [];
  const existingIndex = previous[nodeId]?.findIndex((process) => process.processId === processId) ?? -1;
  const existing = previous[nodeId]?.[existingIndex];
  if (options.ignoreIfTerminal && isTerminalNodeRunStatus(existing?.data.status)) {
    return { runData: previous, obsoleteRefIds, evictedProcessIds, applied: false };
  }
  const runData = produce(previous, (draft) => {
    draft[nodeId] ??= [];
    const process = draft[nodeId]![existingIndex];
    const keep = options.previousDataPerNodeToKeep ?? -1;
    if (process) {
      process.graphId = execution?.graphId ?? process.graphId;
      process.graphRunId = execution?.graphRunId ?? process.graphRunId;
      process.parentGraphRunId = execution?.parentGraphRunId ?? process.parentGraphRunId;
      process.rootRunId = execution?.rootRunId ?? process.rootRunId;
      const nextData = mergeNodeRunDataForProcess(process.data, data);
      obsoleteRefIds.push(...collectReplacedRefIds(process.data, nextData));
      process.data = nextData;
    }
    if (keep > -1) {
      // New invocations evict the older window. Late updates to an already
      // evicted invocation keep status/timing but must not restore its payloads.
      const discarded = process
        ? existingIndex < draft[nodeId]!.length - keep - 1
          ? [process]
          : []
        : keep === 0
          ? draft[nodeId]!
          : draft[nodeId]!.slice(0, -keep);
      for (const prior of discarded) {
        obsoleteRefIds.push(...collectStoredRefIds(prior.data));
        evictedProcessIds.push(prior.processId);
        if (prior.data.inputData) prior.data.inputData = {};
        if (prior.data.outputData) prior.data.outputData = {};
        if (prior.data.splitOutputData) prior.data.splitOutputData = {};
        if (prior.data.llmChatOutputHistory) prior.data.llmChatOutputHistory = {};
      }
    }
    if (process) return;
    draft[nodeId]!.push({
      processId,
      graphId: execution?.graphId,
      graphRunId: execution?.graphRunId,
      parentGraphRunId: execution?.parentGraphRunId,
      rootRunId: execution?.rootRunId,
      data: data as NodeRunDataWithRefs,
    });
  });
  return { runData, obsoleteRefIds, evictedProcessIds, applied: true };
}
