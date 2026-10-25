import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  type PortId,
  type GraphId,
  type Inputs,
  type NodeId,
  type Outputs,
  type ProcessId,
  type DataType,
  type DataValue,
  type ScalarDataType,
  type GraphExecutionMetadata,
  type GraphRunId,
  type RootRunId,
  type FrozenNodeOutputsByGraph,
  type AgentTraceEvent,
  type LLMChatOutputSnapshotKind,
  type LLMChatOutputSnapshotOutcome,
} from '@valerypopoff/rivet2-core';
import { graphNavigationStackState } from './graphBuilder.js';
import type { GraphViewKey } from '../domain/graphEditing/navigationActions.js';
import { getGraphSelectionOptions } from './selectors/executionSelectors.js';
import type { ProcessQuestions } from './userInput.js';
import type { RunActivityJournal } from '../features/runActivity/runActivityJournal.js';
export { createEmptyProjectExecutionSnapshot } from './projectExecutionSnapshot.js';
import { executionSnapshotField } from './projectExecutionStore.js';
export { executionSnapshotsState as projectExecutionSnapshotsState } from './projectExecutionStore.js';

export type GraphRunSelection =
  | GraphRunId
  | 'latest'
  | {
      /** Transient navigation scope, including callers that start no child run. */
      type: 'caller';
      parentNodeId: NodeId;
      /** Absent when the enclosing graph itself has no selected invocation. */
      parentGraphRunId?: GraphRunId;
      /** Absent until the caller has a process in the selected parent run. */
      parentProcessId?: ProcessId;
    };

export type GraphRunRecord = {
  graphRunId: GraphRunId;
  rootRunId: RootRunId;
  graphId: GraphId;
  parentGraphRunId?: GraphRunId;
  executor?: GraphExecutionMetadata['executor'];
  startedAt?: number;
  finishedAt?: number;
  status?: 'running' | 'ok' | 'error' | 'aborted';
};

export type ProcessDataForNode = {
  processId: ProcessId;
  rootRunId?: RootRunId;
  graphRunId?: GraphRunId;
  /** Parent invocation for child work, including retained Watch branch runs. */
  parentGraphRunId?: GraphRunId;
  graphId?: GraphId;
  data: NodeRunDataWithRefs;
};

export type RunDataByNodeId = Record<NodeId, ProcessDataForNode[]>;

export type ProjectExecutionSnapshot = {
  /** Runtime-only legacy terminal reconciliation, owned by this project view. */
  completedRootRunIds?: RootRunId[];
  graphPaused: boolean;
  graphRunHistoryByView: Record<GraphViewKey, GraphRunRecord[]>;
  graphRunning: boolean;
  graphStartTime: number | undefined;
  frozenNodeOutputs?: FrozenNodeOutputsByGraph;
  lastRecording?: string;
  lastRunDataByNode: RunDataByNodeId;
  rootGraph: GraphId | undefined;
  runActivityJournal: RunActivityJournal;
  runningGraphs: GraphId[];
  selectedGraphRunByView: Record<GraphViewKey, GraphRunSelection>;
  selectedProcessPageNodes: Record<NodeId, PageValue>;
  selectedLLMChatOutputPageByInvocation: Record<string, LLMChatOutputPageValue>;
  userInputQuestions: Record<NodeId, ProcessQuestions[]>;
};

export type NodeRunDataBase = {
  /** Privacy-bounded physical model/tool events correlated to this invocation. */
  agentTraceEvents?: AgentTraceEvent[];
  /** Historical node lifecycle bounds while a recording is replayed. */
  recordedTiming?: {
    startedAt?: number;
    finishedAt?: number;
  };
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  splitRunDurationMs?: Record<number, number>;
  /** Identifies the settled terminal iteration of a repeated Watch branch. */
  streamingWatchTerminal?: boolean;
  debugData?: {
    codeSource?: string;
    expressionSource?: string;
    extractObjectPathSource?: string;
    extractObjectPathUsePathInput?: boolean;
    jsListCallbackBodySource?: string;
  };

  status?:
    | { type: 'ok' }
    | { type: 'error'; error: string }
    | { type: 'running' }
    | { type: 'interrupted' }
    | { type: 'notRan'; reason: string };
};

/** Display-only completed logical LLM Chat pages, keyed by split item. */
export type LLMChatOutputHistoryEntryBase = {
  entryId: string;
  roundIndex: number;
  splitIndex: number;
  kind: LLMChatOutputSnapshotKind;
  outcome: LLMChatOutputSnapshotOutcome;
};

export type LLMChatOutputHistoryEntry = LLMChatOutputHistoryEntryBase & {
  outputData: Outputs;
};

export type LLMChatOutputHistoryEntryWithRefs = LLMChatOutputHistoryEntryBase & {
  outputData: StoredInputsOrOutputs;
};

export type NodeRunData = NodeRunDataBase & {
  inputData?: Inputs;

  outputData?: Outputs;

  splitOutputData?: {
    [index: number]: Outputs;
  };

  llmChatOutputHistory?: Record<number, LLMChatOutputHistoryEntry[]>;
};

export type StoredDataPreview =
  | {
      kind: 'text';
      excerpt: string;
      totalChars: number;
      lineCount: number;
      encodedHint?: 'base64' | 'data-uri';
    }
  | {
      kind: 'json';
      excerpt: string;
      totalChars: number;
      itemCount?: number;
    }
  | {
      kind: 'summary';
      label: string;
      /**
       * Optional compact text representation for consumers that cannot or
       * should not restore the ref-backed value. This supplements the summary
       * label; it never changes how the normal output renderer restores the
       * underlying value.
       */
      excerpt?: string;
      totalBytes?: number;
      itemCount?: number;
    };

export type StoredDataValue = {
  [P in DataType]:
    | {
        type: P;
        storage: 'inline';
        value: Extract<DataValue, { type: P }>['value'];
      }
    | {
        type: P;
        storage: 'ref';
        refId: string;
        preview: StoredDataPreview;
      };
}[DataType];

export type StoredInputsOrOutputs = Record<PortId, StoredDataValue>;

export type NodeRunDataWithRefs = NodeRunDataBase & {
  inputData?: StoredInputsOrOutputs;

  outputData?: StoredInputsOrOutputs;

  splitOutputData?: {
    [index: number]: StoredInputsOrOutputs;
  };

  llmChatOutputHistory?: Record<number, LLMChatOutputHistoryEntryWithRefs[]>;
};

export type InputsOrOutputsWithRefs = StoredInputsOrOutputs;

export type DataValueWithRefs = StoredDataValue;

export type PageValue = number | 'latest';

export type LLMChatOutputPageValue = string | 'latest';

export type PageUpdater = (prev: PageValue) => PageValue;

export type ScalarDataValueWithRefs = Extract<DataValueWithRefs, { type: ScalarDataType }>;

export const currentGraphViewState = atom((get) => {
  const navigation = get(graphNavigationStackState);
  if (navigation.index == null) {
    return undefined;
  }

  return navigation.stack[navigation.index];
});

export const lastRunDataByNodeState = executionSnapshotField('lastRunDataByNode');

export const lastRunDataState = atomFamily((nodeId: NodeId) => atom((get) => get(lastRunDataByNodeState)[nodeId]));

export const graphRunHistoryByViewState = executionSnapshotField('graphRunHistoryByView');

export const selectedGraphRunByViewState = executionSnapshotField('selectedGraphRunByView');

export const runningGraphsState = executionSnapshotField('runningGraphs');

export const rootGraphState = executionSnapshotField('rootGraph');

export const graphRunningState = executionSnapshotField('graphRunning');

export const graphStartTimeState = executionSnapshotField('graphStartTime');

/** Metadata-only activity for the current and most recent root execution. */
export const runActivityJournalState = executionSnapshotField('runActivityJournal');

export const graphPausedState = executionSnapshotField('graphPaused');

export const resolvedGraphSelectionState = atom((get) => {
  const currentGraphView = get(currentGraphViewState);
  const graphRunHistoryByView = get(graphRunHistoryByViewState);
  const selectedGraphRunByView = get(selectedGraphRunByViewState);

  return getGraphSelectionOptions({
    currentGraphView,
    graphRunHistoryByView,
    selectedGraphRunByView,
  });
});

export const selectedProcessPageNodesState = executionSnapshotField('selectedProcessPageNodes');

/** UI-only round choice; history itself stays in NodeRunData and recordings. */
export const selectedLLMChatOutputPageByInvocationState = executionSnapshotField(
  'selectedLLMChatOutputPageByInvocation',
);

export function getLLMChatOutputHistorySelectionKey(nodeId: NodeId, processId: ProcessId, splitIndex: number): string {
  return `${nodeId}:${processId}:${splitIndex}`;
}

export const frozenNodeOutputsState = executionSnapshotField('frozenNodeOutputs', (value) => value!);

export const selectedProcessPageState = atomFamily((nodeId: NodeId) =>
  atom(
    (get) => get(selectedProcessPageNodesState)[nodeId] ?? 0,
    (get, set, newValue: PageValue | PageUpdater) => {
      set(selectedProcessPageNodesState, (oldValue) => {
        const currentValue = oldValue[nodeId] ?? 0;
        const nextValue = typeof newValue === 'function' ? (newValue as PageUpdater)(currentValue) : newValue;

        return {
          ...oldValue,
          [nodeId]: nextValue,
        };
      });
    },
  ),
);

export const selectedLLMChatOutputPageState = atomFamily((key: string) =>
  atom(
    (get) => get(selectedLLMChatOutputPageByInvocationState)[key] ?? 'latest',
    (get, set, newValue: LLMChatOutputPageValue) => {
      set(selectedLLMChatOutputPageByInvocationState, (previous) => ({ ...previous, [key]: newValue }));
    },
  ),
);

export function removeExecutionNodeStateFamilies(nodeId: NodeId): void {
  lastRunDataState.remove(nodeId);
  selectedProcessPageState.remove(nodeId);
}
