import type { DataValue, ScalarOrArrayDataValue, StringArrayDataValue } from './DataValue.js';
import type { Dataset, DatasetId, DatasetMetadata, DatasetRow } from './Dataset.js';
import type { ChartNode, NodeId, PortId } from './NodeBase.js';
import type { GraphId, NodeGraph } from './NodeGraph.js';
import type { GraphExecutionMetadata, ProcessId } from './ProcessContext.js';
import type { Project, ProjectId } from './Project.js';
import type { Settings } from './Settings.js';
import type { FrozenNodeOutputsByGraph } from './GraphProcessor.js';

export type GraphInputs = Record<string, DataValue>;
export type GraphOutputs = Record<string, DataValue>;
export type Inputs = Record<PortId, DataValue | undefined>;
export type Outputs = Record<PortId, DataValue | undefined>;
export type RemoteRunRequestId = string;

export type CodeConsoleLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';

export type CodeConsoleMessage = {
  args: unknown[];
  level: CodeConsoleLevel;
};

type WithExecution<T extends object> = T & { execution: GraphExecutionMetadata };

export type SerializedProcessEventMap = {
  start: WithExecution<{
    project: Project;
    startGraph: NodeGraph;
    inputs: GraphInputs;
    contextValues: Record<string, DataValue>;
  }>;
  graphStart: WithExecution<{ graph: NodeGraph; inputs: GraphInputs }>;
  graphError: WithExecution<{ graph: NodeGraph; error: Error | string }>;
  graphFinish: WithExecution<{ graph: NodeGraph; outputs: GraphOutputs }>;
  graphAbort: WithExecution<{ successful: boolean; graph: NodeGraph; error?: Error | string }>;
  nodeStart: WithExecution<{ node: ChartNode; inputs: Inputs; processId: ProcessId }>;
  nodeFinish: WithExecution<{
    node: ChartNode;
    outputs: Outputs;
    processId: ProcessId;
    durationMs?: number;
    splitRunDurationMs?: Record<number, number>;
  }>;
  nodeError: WithExecution<{
    node: ChartNode;
    error: Error | string;
    processId: ProcessId;
    durationMs?: number;
    splitRunDurationMs?: Record<number, number>;
  }>;
  nodeExcluded: WithExecution<{
    node: ChartNode;
    processId: ProcessId;
    inputs: Inputs;
    outputs: Outputs;
    reason: string;
  }>;
  userInput: WithExecution<{
    node: ChartNode;
    inputStrings: string[];
    inputs: Inputs;
    processId: ProcessId;
    renderingType: 'text' | 'markdown';
  }>;
  partialOutput: WithExecution<{ node: ChartNode; outputs: Outputs; index: number; processId: ProcessId }>;
  nodeOutputsCleared: WithExecution<{ node: ChartNode; processId?: ProcessId }>;
  error: { error: Error | string };
  done: { results: GraphOutputs };
  abort: { successful: boolean; error?: string | Error };
  finish: void;
  trace: string;
  pause: void;
  resume: void;
  globalSet: WithExecution<{ id: string; value: ScalarOrArrayDataValue; processId: ProcessId }>;
};

export type ProcessEventMessage = {
  [K in keyof ProcessEventMessageMap]: { message: K; data: ProcessEventMessageMap[K]; requestId?: RemoteRunRequestId };
}[keyof ProcessEventMessageMap];

export type ProcessEventMessageMap = {
  codeConsole: CodeConsoleMessage;
  nodeStart: SerializedProcessEventMap['nodeStart'];
  nodeFinish: SerializedProcessEventMap['nodeFinish'];
  nodeError: SerializedProcessEventMap['nodeError'];
  nodeExcluded: SerializedProcessEventMap['nodeExcluded'];
  userInput: SerializedProcessEventMap['userInput'];
  start: SerializedProcessEventMap['start'];
  done: SerializedProcessEventMap['done'];
  abort: SerializedProcessEventMap['abort'];
  graphAbort: SerializedProcessEventMap['graphAbort'];
  graphStart: SerializedProcessEventMap['graphStart'];
  graphFinish: SerializedProcessEventMap['graphFinish'];
  partialOutput: SerializedProcessEventMap['partialOutput'];
  nodeOutputsCleared: SerializedProcessEventMap['nodeOutputsCleared'];
  error: SerializedProcessEventMap['error'];
  graphError: SerializedProcessEventMap['graphError'];
  trace: string;
  pause: void;
  resume: void;
};

export type GraphUploadAllowedMessage = {
  message: 'graph-upload-allowed';
  data: undefined;
};

export type DatasetRequestMessage = {
  [K in keyof DatasetRequestMap]: { message: K; data: DatasetRequestPayload<DatasetRequestMap[K]> };
}[keyof DatasetRequestMap];

export type DatasetRequestPayload<T> = {
  requestId: string;
  payload: T;
};

export type DatasetRequestMap = {
  'datasets:get-metadata': { id: DatasetId };
  'datasets:get-for-project': { projectId: ProjectId };
  'datasets:get-data': { id: DatasetId };
  'datasets:put-data': { id: DatasetId; data: Dataset };
  'datasets:put-row': { id: DatasetId; row: DatasetRow };
  'datasets:put-metadata': { metadata: DatasetMetadata };
  'datasets:clear-data': { id: DatasetId };
  'datasets:delete': { id: DatasetId };
  'datasets:knn': { datasetId: DatasetId; k: number; vector: number[] };
};

export type IncomingMessage = ProcessEventMessage | GraphUploadAllowedMessage | DatasetRequestMessage;

export type OutgoingMessageMap = {
  'user-input': { nodeId: NodeId; answers: StringArrayDataValue; requestId?: RemoteRunRequestId };
  'set-dynamic-data': { project: Project; settings: Settings };
  run: {
    requestId: RemoteRunRequestId;
    graphId: GraphId;
    runToNodeIds?: NodeId[];
    preloadData?: Record<NodeId, Outputs>;
    frozenNodeOutputs?: FrozenNodeOutputsByGraph;
    contextValues: Record<string, DataValue>;
    inputs?: GraphInputs;
    projectPath?: string | null;
    useEditorCache?: boolean;
    captureNodeTimings?: boolean;
  };
  abort: { requestId?: RemoteRunRequestId } | undefined;
  pause: { requestId?: RemoteRunRequestId } | undefined;
  resume: { requestId?: RemoteRunRequestId } | undefined;
  preload: { nodeData: Record<NodeId, Outputs>; requestId?: RemoteRunRequestId };
  'datasets:response': { requestId: string; payload: unknown };
};

export type OutgoingMessage = {
  [K in keyof OutgoingMessageMap]: { type: K; data: OutgoingMessageMap[K] };
}[keyof OutgoingMessageMap];
