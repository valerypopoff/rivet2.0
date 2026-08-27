import {
  type DataValue,
  getScalarTypeOf,
  type Inputs,
  type NodeId,
  type Outputs,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { cloneDeep, mapValues } from 'lodash-es';
import type { DataRefReader, DataRefStore } from '../providers/ProvidersContext.js';
import type {
  DataValueWithRefs,
  InputsOrOutputsWithRefs,
  NodeRunData,
  NodeRunDataWithRefs,
  LLMChatOutputHistoryEntry,
  LLMChatOutputHistoryEntryWithRefs,
  RunDataByNodeId,
  StoredDataPreview,
  StoredDataValue,
} from '../state/dataFlow.js';
import { fixDataValueUint8Arrays } from './executionDataSanitization.js';
import { getStorageDecision } from './executionDataPreview.js';

type DataRefDeleter = Pick<DataRefStore, 'delete'>;

export type RefScope = {
  projectId?: string;
  nodeId: string;
  processId: string;
  channel: 'input' | 'output' | 'llm-chat-output-history';
  splitIndex?: number;
  historyEntryId?: string;
};

export function storeNodeDataForHistory(
  data: Partial<NodeRunData>,
  refStore: DataRefStore,
  scope: Omit<RefScope, 'channel'>,
): Partial<NodeRunDataWithRefs> {
  const storedData: Partial<NodeRunDataWithRefs> = {};

  if (data.startedAt !== undefined) {
    storedData.startedAt = data.startedAt;
  }

  if (data.finishedAt !== undefined) {
    storedData.finishedAt = data.finishedAt;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'durationMs')) {
    storedData.durationMs = data.durationMs;
  }

  if (data.splitRunDurationMs !== undefined) {
    storedData.splitRunDurationMs = { ...data.splitRunDurationMs };
  }

  if (data.debugData !== undefined) {
    storedData.debugData = cloneDeep(data.debugData);
  }

  if (data.status !== undefined) {
    storedData.status = data.status;
  }

  if (data.inputData !== undefined) {
    storedData.inputData = storeInputsOrOutputsForHistory(data.inputData, refStore, {
      ...scope,
      channel: 'input',
    });
  }

  if (data.outputData !== undefined) {
    storedData.outputData = storeInputsOrOutputsForHistory(data.outputData, refStore, {
      ...scope,
      channel: 'output',
    });
  }

  if (data.splitOutputData !== undefined) {
    storedData.splitOutputData = mapValues(data.splitOutputData, (value, key) =>
      storeInputsOrOutputsForHistory(value, refStore, {
        ...scope,
        channel: 'output',
        splitIndex: Number(key),
      }),
    ) as NodeRunDataWithRefs['splitOutputData'];
  }

  if (data.llmChatOutputHistory !== undefined) {
    storedData.llmChatOutputHistory = mapValues(data.llmChatOutputHistory, (entries) =>
      entries.map((entry) => storeLLMChatOutputHistoryEntry(entry, refStore, scope)),
    ) as NodeRunDataWithRefs['llmChatOutputHistory'];
  }

  return storedData;
}

/** Stores one LLM round in a namespace that can never collide with terminal output refs. */
export function storeLLMChatOutputHistoryEntry(
  entry: LLMChatOutputHistoryEntry,
  refStore: DataRefStore,
  scope: Omit<RefScope, 'channel' | 'historyEntryId' | 'splitIndex'>,
): LLMChatOutputHistoryEntryWithRefs {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    outcome: entry.outcome,
    roundIndex: entry.roundIndex,
    splitIndex: entry.splitIndex,
    outputData: storeInputsOrOutputsForHistory(entry.outputData, refStore, {
      ...scope,
      channel: 'llm-chat-output-history',
      historyEntryId: entry.entryId,
      splitIndex: entry.splitIndex,
    })!,
  };
}

export function storeInputsOrOutputsForHistory(
  data: Inputs | Outputs | undefined,
  refStore: DataRefStore,
  scope: RefScope,
): InputsOrOutputsWithRefs | undefined {
  if (data == null) {
    return undefined;
  }

  const storedData: Partial<Record<PortId, StoredDataValue>> = {};

  for (const [portId, value] of Object.entries(data) as Array<[PortId, DataValue | undefined]>) {
    if (value == null) {
      continue;
    }

    storedData[portId] = storeDataValueForHistory(value, refStore, scope, portId);
  }

  return storedData as InputsOrOutputsWithRefs;
}

export function storeDataValueForHistory(
  value: DataValue,
  refStore: DataRefStore,
  scope: RefScope,
  portId: PortId,
): StoredDataValue {
  const fixedValue = fixDataValueUint8Arrays(value)!;
  const decision = getStorageDecision(fixedValue);

  if (decision.storage === 'inline') {
    return toStoredInlineDataValue(fixedValue);
  }

  const refId = buildExecutionDataRefId(scope, portId);
  refStore.set(refId, fixedValue, decision.sizeHint != null ? { sizeHint: decision.sizeHint } : undefined);

  return {
    type: fixedValue.type,
    storage: 'ref',
    refId,
    preview: decision.preview,
  } as StoredDataValue;
}

export function toStoredInlineDataValue(value: DataValue): StoredDataValue {
  return {
    type: value.type,
    storage: 'inline',
    value: cloneDeep(value.value),
  } as StoredDataValue;
}

export function isStoredRefDataValue(
  value: DataValueWithRefs | DataValue | undefined,
): value is Extract<StoredDataValue, { storage: 'ref' }> {
  return isPlainRecord(value) && (value as { storage?: unknown }).storage === 'ref';
}

export function isStoredInlineDataValue(
  value: DataValueWithRefs | DataValue | undefined,
): value is Extract<StoredDataValue, { storage: 'inline' }> {
  return isPlainRecord(value) && (value as { storage?: unknown }).storage === 'inline';
}

export function isPreviewOnlyStoredValue(
  value: DataValueWithRefs | DataValue | undefined,
): value is Extract<StoredDataValue, { storage: 'ref' }> {
  if (!isStoredRefDataValue(value)) {
    return false;
  }

  const scalarType = getScalarTypeOf(value.type);
  return (
    scalarType === 'string' ||
    scalarType === 'object' ||
    scalarType === 'any' ||
    (scalarType === 'chat-message' && value.preview.kind === 'text')
  );
}

export function getStoredValuePreview(value: DataValueWithRefs | DataValue | undefined): StoredDataPreview | undefined {
  return isStoredRefDataValue(value) ? value.preview : undefined;
}

export function restoreStoredDataValue(value: DataValueWithRefs, refStore: DataRefReader): DataValue {
  if (isStoredInlineDataValue(value)) {
    return {
      type: value.type,
      value: cloneDeep(value.value),
    } as DataValue;
  }

  if (!isPlainRecord(value) || !('storage' in value)) {
    return cloneDeep(value) as DataValue;
  }

  const resolved = refStore.get(value.refId);

  if (!resolved) {
    throw new Error(`Could not restore ref-backed value ${value.refId} for type ${value.type}`);
  }

  return fixDataValueUint8Arrays(cloneDeep(resolved))!;
}

export function tryRestoreStoredDataValue(
  value: DataValueWithRefs | undefined,
  refStore: DataRefReader,
): DataValue | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return restoreStoredDataValue(value, refStore);
  } catch {
    return undefined;
  }
}

export function restoreStoredInputsOrOutputs(
  data: InputsOrOutputsWithRefs | undefined,
  refStore: DataRefReader,
): Inputs | Outputs | undefined {
  if (!data) {
    return undefined;
  }

  const restoredData: Partial<Record<PortId, DataValue>> = {};

  for (const [portId, storedValue] of Object.entries(data) as Array<[PortId, DataValueWithRefs | undefined]>) {
    if (storedValue == null) {
      continue;
    }

    restoredData[portId] = restoreStoredDataValue(storedValue, refStore);
  }

  return restoredData as Inputs | Outputs;
}

export function tryRestoreStoredInputsOrOutputs(
  data: InputsOrOutputsWithRefs | undefined,
  refStore: DataRefReader,
): Inputs | Outputs | undefined {
  if (!data) {
    return undefined;
  }

  try {
    return restoreStoredInputsOrOutputs(data, refStore);
  } catch {
    return undefined;
  }
}

export function collectStoredRefIds(data: InputsOrOutputsWithRefs | NodeRunDataWithRefs | undefined): string[] {
  if (!data) {
    return [];
  }

  if (!isPlainRecord(data)) {
    return [];
  }

  if (isStoredNodeRunData(data)) {
    const runData = data;
    return [
      ...collectStoredRefIds(runData.inputData),
      ...collectStoredRefIds(runData.outputData),
      ...(runData.splitOutputData
        ? Object.values(runData.splitOutputData).flatMap((value) => collectStoredRefIds(value))
        : []),
      ...(runData.llmChatOutputHistory
        ? Object.values(runData.llmChatOutputHistory).flatMap((entries) =>
            entries.flatMap((entry) => collectStoredRefIds(entry.outputData)),
          )
        : []),
    ];
  }

  return Object.values(data).flatMap((value) => (isStoredRefDataValue(value) ? [value.refId] : []));
}

export function hasUnavailableStoredRefs(
  data: InputsOrOutputsWithRefs | NodeRunDataWithRefs | undefined,
  refStore: DataRefReader,
): boolean {
  return collectStoredRefIds(data).some((refId) => refStore.get(refId) == null);
}

export function clearExecutionDataRefs(refStore: DataRefDeleter, previousRunData: RunDataByNodeId): void {
  const allRefIds = Object.values(previousRunData).flatMap((processes) =>
    processes.flatMap((process) => collectStoredRefIds(process.data)),
  );

  for (const refId of allRefIds) {
    refStore.delete(refId);
  }
}

export function clearRemovedExecutionDataRefs(
  refStore: DataRefDeleter,
  removedRunData: RunDataByNodeId,
  preservedRunData: RunDataByNodeId,
): void {
  const preservedRefIds = new Set(
    Object.values(preservedRunData).flatMap((processes) =>
      processes.flatMap((process) => collectStoredRefIds(process.data)),
    ),
  );

  const refIdsToDelete = Object.values(removedRunData)
    .flatMap((processes) => processes.flatMap((process) => collectStoredRefIds(process.data)))
    .filter((refId) => !preservedRefIds.has(refId));

  deleteStoredRefIds(refStore, refIdsToDelete);
}

export function splitRunDataByPreservedNodes(
  previousRunData: RunDataByNodeId,
  nodeIdsToPreserve: Iterable<NodeId>,
): { preservedRunData: RunDataByNodeId; removedRunData: RunDataByNodeId } {
  const preserveSet = new Set(nodeIdsToPreserve);
  const preservedRunData: RunDataByNodeId = {};
  const removedRunData: RunDataByNodeId = {};

  for (const [nodeId, runData] of Object.entries(previousRunData)) {
    if (preserveSet.has(nodeId as NodeId)) {
      preservedRunData[nodeId as NodeId] = runData;
    } else {
      removedRunData[nodeId as NodeId] = runData;
    }
  }

  return { preservedRunData, removedRunData };
}

export function deleteStoredRefIds(refStore: DataRefDeleter, refIds: Iterable<string>): void {
  for (const refId of refIds) {
    refStore.delete(refId);
  }
}

function buildExecutionDataRefId(scope: RefScope, portId: PortId): string {
  const namespace = scope.projectId ? `${scope.projectId}:` : '';

  if (scope.channel === 'llm-chat-output-history') {
    return `execution:${namespace}${scope.nodeId}:${scope.processId}:${scope.channel}:${scope.splitIndex ?? 0}:${scope.historyEntryId ?? 'unknown'}:${portId}`;
  }

  if (scope.splitIndex != null) {
    return `execution:${namespace}${scope.nodeId}:${scope.processId}:${scope.channel}:${scope.splitIndex}:${portId}`;
  }

  return `execution:${namespace}${scope.nodeId}:${scope.processId}:${scope.channel}:${portId}`;
}

function isStoredNodeRunData(value: InputsOrOutputsWithRefs | NodeRunDataWithRefs): value is NodeRunDataWithRefs {
  if (!isPlainRecord(value)) {
    return false;
  }

  const candidate = value as NodeRunDataWithRefs;
  if (hasNodeRunMetadata(candidate)) {
    return true;
  }

  return (
    isStoredPortMap(candidate.inputData) ||
    isStoredPortMap(candidate.outputData) ||
    isStoredSplitOutputData(candidate.splitOutputData) ||
    isStoredLLMChatOutputHistory(candidate.llmChatOutputHistory)
  );
}

function hasNodeRunMetadata(value: NodeRunDataWithRefs): boolean {
  return (
    typeof value.startedAt === 'number' ||
    typeof value.finishedAt === 'number' ||
    isNodeRunDurationMetadata(value, 'durationMs') ||
    isNodeRunPlainMetadata(value.splitRunDurationMs) ||
    isNodeRunPlainMetadata(value.debugData) ||
    isNodeRunStatus(value.status)
  );
}

function isNodeRunDurationMetadata(value: NodeRunDataWithRefs, key: 'durationMs'): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return false;
  }

  const durationMs = value[key];
  return durationMs === undefined || typeof durationMs === 'number';
}

function isNodeRunPlainMetadata(value: unknown): boolean {
  return isPlainRecord(value) && !isStoredDataValueLike(value);
}

function isNodeRunStatus(value: unknown): value is NonNullable<NodeRunDataWithRefs['status']> {
  if (
    !isPlainRecord(value) ||
    typeof value.type !== 'string' ||
    Object.prototype.hasOwnProperty.call(value, 'storage')
  ) {
    return false;
  }

  return (
    value.type === 'ok' ||
    value.type === 'error' ||
    value.type === 'running' ||
    value.type === 'interrupted' ||
    value.type === 'notRan'
  );
}

function isStoredSplitOutputData(value: unknown): value is NonNullable<NodeRunDataWithRefs['splitOutputData']> {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every((splitOutputData) => splitOutputData == null || isStoredPortMap(splitOutputData));
}

function isStoredLLMChatOutputHistory(
  value: unknown,
): value is NonNullable<NodeRunDataWithRefs['llmChatOutputHistory']> {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every(
    (entries) =>
      Array.isArray(entries) &&
      entries.every(
        (entry) =>
          isPlainRecord(entry) &&
          typeof entry.entryId === 'string' &&
          typeof entry.roundIndex === 'number' &&
          typeof entry.splitIndex === 'number' &&
          isStoredPortMap(entry.outputData),
      ),
  );
}

function isStoredPortMap(value: unknown): value is InputsOrOutputsWithRefs {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every((portValue) => portValue == null || isStoredDataValueLike(portValue));
}

function isStoredDataValueLike(value: unknown): value is StoredDataValue {
  return isPlainRecord(value) && typeof value.type === 'string' && typeof value.storage === 'string';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}
