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
  | 'setGlobal'
  | 'signal'
  | 'toolCallContinuation'
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
  node: ChartNode;
  nodeAbortController: AbortController;
  onPartialOutputs: (partialOutputs: Outputs) => void;
  processId: ProcessId;
  requestUserInput: (inputStrings: string[], renderingType: 'text' | 'markdown') => Promise<StringArrayDataValue>;
  reportProgress: InternalProcessContext['reportProgress'];
  setGlobal: (id: string, value: ScalarOrArrayDataValue) => void;
  toolCallContinuation?: InternalProcessContext['toolCallContinuation'];
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
    node,
    nodeAbortController,
    onPartialOutputs,
    processId,
    requestUserInput,
    reportProgress,
    setGlobal,
    toolCallContinuation,
    waitEvent,
  } = options;

  return {
    ...base,
    node,
    attachedData,
    activeOutputPortIds,
    isDirectRunTarget,
    waitEvent,
    externalFunctions: { ...externalFunctions },
    onPartialOutputs,
    signal: nodeAbortController.signal,
    processId,
    setGlobal,
    createSubProcessor: createSubProcessor as InternalProcessContext['createSubProcessor'],
    getPluginConfig,
    requestUserInput,
    reportProgress,
    toolCallContinuation,
    execution,
  };
}
