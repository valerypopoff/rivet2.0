import type { DataValue, ScalarOrArrayDataValue, StringArrayDataValue } from './DataValue.js';
import type { GraphExecutionMetadata, InternalProcessContext, ProcessId } from './ProcessContext.js';
import type { ChartNode, PortId } from './NodeBase.js';
import type { GraphId } from './NodeGraph.js';
import type { Project } from './Project.js';
import type { AttachedNodeData, ExternalFunction, Outputs } from './GraphProcessor.js';

export type NodeProcessContextBase = Omit<
  InternalProcessContext,
  | 'attachedData'
  | 'activeOutputPortIds'
  | 'createSubProcessor'
  | 'execution'
  | 'externalFunctions'
  | 'getPluginConfig'
  | 'node'
  | 'onPartialOutputs'
  | 'processId'
  | 'requestUserInput'
  | 'reportProgress'
  | 'isDirectRunTarget'
  | 'markResultAsEditorCacheHit'
  | 'setGlobal'
  | 'signal'
  | 'splitIndex'
  | 'toolCallContinuation'
  | 'toolCallTraceSource'
  | 'waitEvent'
>;

export function buildNodeProcessContext(options: {
  activeOutputPortIds: ReadonlySet<PortId>;
  base: NodeProcessContextBase;
  attachedData: AttachedNodeData;
  createSubProcessor: (
    subGraphId: GraphId | undefined,
    options?: { signal?: AbortSignal; project?: Project },
  ) => unknown;
  execution: GraphExecutionMetadata;
  externalFunctions: Record<string, ExternalFunction>;
  getPluginConfig: (name: string) => string | undefined;
  isDirectRunTarget: boolean;
  markResultAsEditorCacheHit?: InternalProcessContext['markResultAsEditorCacheHit'];
  node: ChartNode;
  nodeAbortController: AbortController;
  onPartialOutputs: (partialOutputs: Outputs) => void;
  processId: ProcessId;
  requestUserInput: (inputStrings: string[], renderingType: 'text' | 'markdown') => Promise<StringArrayDataValue>;
  reportProgress: InternalProcessContext['reportProgress'];
  setGlobal: (id: string, value: ScalarOrArrayDataValue) => void;
  splitIndex: number;
  toolCallContinuation?: InternalProcessContext['toolCallContinuation'];
  toolCallTraceSource?: InternalProcessContext['toolCallTraceSource'];
  waitEvent: (event: string) => Promise<DataValue | undefined>;
}): InternalProcessContext {
  const {
    attachedData,
    activeOutputPortIds,
    base,
    createSubProcessor,
    execution,
    externalFunctions,
    getPluginConfig,
    isDirectRunTarget,
    markResultAsEditorCacheHit,
    node,
    nodeAbortController,
    onPartialOutputs,
    processId,
    requestUserInput,
    reportProgress,
    setGlobal,
    splitIndex,
    toolCallContinuation,
    toolCallTraceSource,
    waitEvent,
  } = options;

  return {
    ...base,
    node,
    attachedData,
    activeOutputPortIds,
    isDirectRunTarget,
    markResultAsEditorCacheHit,
    waitEvent,
    waitForGlobal: (id, signal = nodeAbortController.signal) => base.waitForGlobal(id, signal),
    waitForStoredValue: (key, signal = nodeAbortController.signal) => base.waitForStoredValue(key, signal),
    externalFunctions: { ...externalFunctions },
    onPartialOutputs,
    signal: nodeAbortController.signal,
    processId,
    splitIndex,
    setGlobal,
    createSubProcessor: createSubProcessor as InternalProcessContext['createSubProcessor'],
    getPluginConfig,
    requestUserInput,
    reportProgress,
    toolCallContinuation,
    toolCallTraceSource,
    execution,
  };
}
