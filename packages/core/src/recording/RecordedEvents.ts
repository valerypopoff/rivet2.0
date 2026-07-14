import type { Opaque, OverrideProperties } from 'type-fest';
import {
  type GraphExecutionMetadata,
  type ProcessEvents,
  type ProjectId,
  type GraphInputs,
  type DataValue,
  type GraphId,
  type GraphOutputs,
  type NodeId,
  type Inputs,
  type ProcessId,
  type Outputs,
  type ScalarOrArrayDataValue,
  type StringArrayDataValue,
} from '../index.js';

type WithOptionalExecution<T extends object> = T & { execution?: GraphExecutionMetadata };

type RecordedEventKey = Extract<keyof RecordedEventsMap, string>;

export type RecordingId = Opaque<string, 'RecordingId'>;

export type RecordedEventsMap = OverrideProperties<
  ProcessEvents,
  {
    start: WithOptionalExecution<{
      projectId: ProjectId;
      inputs: GraphInputs;
      contextValues: Record<string, DataValue>;
      startGraph: GraphId;
    }>;

    /** Called when a graph or subgraph has started. */
    graphStart: WithOptionalExecution<{ graphId: GraphId; inputs: GraphInputs }>;

    /** Called when a graph or subgraph has errored. */
    graphError: WithOptionalExecution<{ graphId: GraphId; error: Error | string }>;

    /** Called when a graph or a subgraph has finished. */
    graphFinish: WithOptionalExecution<{ graphId: GraphId; outputs: GraphOutputs }>;

    /** Called when a graph or subgraph has been aborted. */
    graphAbort: WithOptionalExecution<{ graphId: GraphId; error?: string; successful: boolean }>;

    /** Called when a node has started processing, with the input values for the node. */
    nodeStart: WithOptionalExecution<{ nodeId: NodeId; inputs: Inputs; processId: ProcessId }>;

    /** Called when a node has finished processing, with the output values for the node. */
    nodeFinish: WithOptionalExecution<{
      nodeId: NodeId;
      outputs: Outputs;
      processId: ProcessId;
      durationMs?: number;
      splitRunDurationMs?: Record<number, number>;
    }>;

    /** Called when a node has errored during processing. */
    nodeError: WithOptionalExecution<{
      nodeId: NodeId;
      error: string;
      processId: ProcessId;
      durationMs?: number;
      splitRunDurationMs?: Record<number, number>;
    }>;

    /** Called when a node has been excluded from processing. */
    nodeExcluded: WithOptionalExecution<{
      nodeId: NodeId;
      processId: ProcessId;
      inputs: Inputs;
      outputs: Outputs;
      reason: string;
    }>;

    /** Called when a user input node requires user input. Call the callback when finished, or call userInput() on the GraphProcessor with the results. */
    userInput: WithOptionalExecution<{
      nodeId: NodeId;
      inputStrings: string[];
      inputs: Inputs;
      callback: (values: StringArrayDataValue) => void;
      processId: ProcessId;
      renderingType: 'text' | 'markdown';
    }>;

    /** Called when a node has partially processed, with the current partial output values for the node. */
    partialOutput: WithOptionalExecution<{ nodeId: NodeId; outputs: Outputs; index: number; processId: ProcessId }>;

    progress: WithOptionalExecution<{
      nodeId: NodeId;
      processId: ProcessId;
      progress: ProcessEvents['progress']['progress'];
    }>;

    /** Called when the outputs of a node have been cleared entirely. If processId is present, only the one process() should be cleared. */
    nodeOutputsCleared: WithOptionalExecution<{ nodeId: NodeId; processId?: ProcessId }>;

    /** Called when the root graph has errored. The root graph will also throw. */
    error: { error: string };

    globalSet: WithOptionalExecution<{ id: string; value: ScalarOrArrayDataValue; processId: ProcessId }>;

    newAbortController: undefined;
  }
>;

export type RecordedEvent<T extends RecordedEventKey> = {
  type: T;
  data: RecordedEventsMap[T];
  ts: number;
};

export type RecordedEvents = {
  [K in RecordedEventKey]: RecordedEvent<K>;
}[RecordedEventKey];

export type Recording = {
  recordingId: RecordingId;

  startTs: number;
  finishTs: number;

  events: RecordedEvents[];
};

export type SerializedRecording = {
  version: number;
  recording: Recording;
  assets: Record<string, string>;
  strings: Record<string, string>;
};
