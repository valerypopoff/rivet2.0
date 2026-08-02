import { getError } from '../utils/errors.js';
import type { ExecutionRecorder } from '../recording/ExecutionRecorder.js';
import type { RecordedEvents } from '../recording/RecordedEvents.js';
import type { DataValue, StringArrayDataValue } from './DataValue.js';
import { nanoid } from 'nanoid/non-secure';
import type { GraphExecutionMetadata, GraphRunId, ProcessId, RootRunId } from './ProcessContext.js';
import type { GraphId } from './NodeGraph.js';
import type { ChartNode, NodeId, PortId } from './NodeBase.js';
import type { ProcessEvents } from './GraphProcessor.js';
import type Emittery from 'emittery';
import type { Project } from './Project.js';
import type { UserInputNode } from './nodes/UserInputNode.js';
import { emitDetached } from '../utils/emitDetached.js';

type Outputs = Record<PortId, DataValue | undefined>;
type GraphOutputs = Record<string, DataValue>;
type GraphInputs = Record<string, DataValue>;

function withOptionalDuration<T extends object>(
  payload: T,
  durationMs: number | undefined,
  splitRunDurationMs?: Record<number, number>,
): T & { durationMs?: number; splitRunDurationMs?: Record<number, number> } {
  return {
    ...payload,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(splitRunDurationMs === undefined ? {} : { splitRunDurationMs }),
  } as T & { durationMs?: number; splitRunDurationMs?: Record<number, number> };
}

export async function replayExecutionRecording(options: {
  emitter: Emittery<ProcessEvents>;
  erroredNodes: Map<NodeId, Error | string>;
  graphInputs: GraphInputs;
  graphOutputs: GraphOutputs;
  project: Project;
  recorder: ExecutionRecorder;
  recordingPlaybackChatLatency: number;
  setContextValues: (contextValues: Record<string, DataValue>) => void;
  setGraphInputs: (inputs: GraphInputs) => void;
  setGraphOutputs: (outputs: GraphOutputs) => void;
  setRunning: (running: boolean) => void;
  visitedNodes: Set<NodeId>;
  waitUntilUnpaused: () => Promise<void>;
  nodeResults: Map<NodeId, Outputs>;
  isAborted: () => boolean;
}): Promise<GraphOutputs> {
  const {
    emitter,
    erroredNodes,
    graphOutputs,
    project,
    recorder,
    recordingPlaybackChatLatency,
    setContextValues,
    setGraphInputs,
    setGraphOutputs,
    setRunning,
    visitedNodes,
    waitUntilUnpaused,
    nodeResults,
    isAborted,
  } = options;

  const nodesByIdAllGraphs: Record<NodeId, ChartNode> = {};
  const graphIdByNodeId: Record<NodeId, GraphId> = {};
  for (const graph of Object.values(project.graphs)) {
    for (const node of graph.nodes) {
      nodesByIdAllGraphs[node.id] = node;
      graphIdByNodeId[node.id] = graph.metadata!.id!;
    }
  }

  const rootGraphId = (project.metadata.mainGraphId ?? Object.keys(project.graphs)[0]) as GraphId;

  const getGraph = (graphId: GraphId) => {
    const graph = project.graphs[graphId];
    if (!graph) {
      throw new Error(`Mismatch between project and recording: graph ${graphId} not found in project`);
    }
    return graph;
  };

  const getNode = (nodeId: NodeId) => {
    const node = nodesByIdAllGraphs[nodeId];
    if (!node) {
      throw new Error(`Mismatch between project and recording: node ${nodeId} not found in any graph in project`);
    }
    return node;
  };

  const getGraphIdForNode = (nodeId: NodeId) => {
    const graphId = graphIdByNodeId[nodeId];
    if (!graphId) {
      throw new Error(
        `Mismatch between project and recording: node ${nodeId} is not associated with a graph in project`,
      );
    }
    return graphId;
  };

  try {
    const legacyRootRunId = nanoid() as RootRunId;
    const legacyGraphRunsByGraphId = new Map<GraphId, GraphRunId>();
    const nodeStartTimestamps = new Map<string, number>();

    const getExecution = (graphId: GraphId, recordedExecution?: GraphExecutionMetadata): GraphExecutionMetadata => {
      if (recordedExecution) {
        return recordedExecution;
      }

      let graphRunId = legacyGraphRunsByGraphId.get(graphId);
      if (!graphRunId) {
        graphRunId = nanoid() as GraphRunId;
        legacyGraphRunsByGraphId.set(graphId, graphRunId);
      }

      return {
        graphId,
        graphRunId,
        rootRunId: legacyRootRunId,
      };
    };

    const getNodeRunKey = (execution: GraphExecutionMetadata, nodeId: NodeId, processId: ProcessId): string =>
      `${execution.rootRunId}:${execution.graphRunId}:${nodeId}:${processId}`;

    const getRecordedDuration = (
      recordedDuration: number | undefined,
      execution: GraphExecutionMetadata,
      nodeId: NodeId,
      processId: ProcessId,
      terminalTs: number,
    ): number | undefined => {
      if (recordedDuration !== undefined) {
        return recordedDuration;
      }

      const startedAt = nodeStartTimestamps.get(getNodeRunKey(execution, nodeId, processId));
      return startedAt === undefined ? undefined : Math.max(0, terminalTs - startedAt);
    };

    for (const event of recorder.events) {
      if (isAborted()) {
        break;
      }

      await waitUntilUnpaused();

      switch (event.type) {
        case 'start': {
          const { data } = event;
          emitDetached(emitter, 'start', {
            project,
            contextValues: data.contextValues,
            inputs: data.inputs,
            startGraph: getGraph(data.startGraph),
            execution: getExecution(data.startGraph, data.execution),
          });
          setContextValues(data.contextValues);
          setGraphInputs(data.inputs);
          break;
        }
        case 'abort': {
          emitDetached(emitter, 'abort', event.data);
          break;
        }
        case 'pause':
        case 'resume': {
          break;
        }
        case 'done': {
          emitDetached(emitter, 'done', event.data);
          setGraphOutputs(event.data.results);
          setRunning(false);
          break;
        }
        case 'error': {
          emitDetached(emitter, 'error', event.data);
          break;
        }
        case 'globalSet': {
          const { data } = event;
          emitDetached(emitter, 'globalSet', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? rootGraphId, data.execution),
          });
          break;
        }
        case 'trace': {
          emitDetached(emitter, 'trace', event.data);
          break;
        }
        case 'graphStart': {
          const { data } = event;
          const execution = getExecution(data.graphId, data.execution);
          legacyGraphRunsByGraphId.set(data.graphId, execution.graphRunId);
          emitDetached(emitter, 'graphStart', {
            graph: getGraph(data.graphId),
            inputs: data.inputs,
            execution,
          });
          break;
        }
        case 'graphFinish': {
          const { data } = event;
          emitDetached(emitter, 'graphFinish', {
            graph: getGraph(data.graphId),
            outputs: data.outputs,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphOutputsReady': {
          const { data } = event;
          emitDetached(emitter, 'graphOutputsReady', {
            graph: getGraph(data.graphId),
            outputs: data.outputs,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphError': {
          const { data } = event;
          emitDetached(emitter, 'graphError', {
            graph: getGraph(data.graphId),
            error: data.error,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphAbort': {
          const { data } = event;
          emitDetached(emitter, 'graphAbort', {
            graph: getGraph(data.graphId),
            error: data.error,
            successful: data.successful,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'nodeStart': {
          const { data } = event;
          const node = getNode(data.nodeId);
          const execution = getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution);
          nodeStartTimestamps.set(getNodeRunKey(execution, data.nodeId, data.processId as ProcessId), event.ts);
          emitDetached(emitter, 'nodeStart', {
            node,
            inputs: data.inputs,
            ...(data.inputConnections === undefined ? {} : { inputConnections: data.inputConnections }),
            processId: data.processId as ProcessId,
            ...(data.resultOrigin === undefined ? {} : { resultOrigin: data.resultOrigin }),
            execution,
          });
          if (node.type === 'chat') {
            await new Promise((resolve) => setTimeout(resolve, recordingPlaybackChatLatency));
          }
          break;
        }
        case 'nodeFinish': {
          const { data } = event;
          const node = getNode(data.nodeId);
          const execution = getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution);
          emitDetached(
            emitter,
            'nodeFinish',
            withOptionalDuration(
              {
                node,
                outputs: data.outputs,
                processId: data.processId as ProcessId,
                ...(data.resultOrigin === undefined ? {} : { resultOrigin: data.resultOrigin }),
                execution,
              },
              getRecordedDuration(data.durationMs, execution, data.nodeId, data.processId as ProcessId, event.ts),
              data.splitRunDurationMs,
            ),
          );
          nodeResults.set(data.nodeId, data.outputs as Outputs);
          visitedNodes.add(data.nodeId);
          break;
        }
        case 'nodeError': {
          const { data } = event;
          const node = getNode(data.nodeId);
          const execution = getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution);
          emitDetached(
            emitter,
            'nodeError',
            withOptionalDuration(
              {
                node,
                error: data.error,
                processId: data.processId as ProcessId,
                ...(data.resultOrigin === undefined ? {} : { resultOrigin: data.resultOrigin }),
                execution,
              },
              getRecordedDuration(data.durationMs, execution, data.nodeId, data.processId as ProcessId, event.ts),
              data.splitRunDurationMs,
            ),
          );
          erroredNodes.set(data.nodeId, data.error);
          visitedNodes.add(data.nodeId);
          break;
        }
        case 'nodeExcluded': {
          const { data } = event;
          const node = getNode(data.nodeId);
          emitDetached(emitter, 'nodeExcluded', {
            node,
            processId: data.processId as ProcessId,
            inputs: data.inputs,
            outputs: data.outputs,
            reason: data.reason,
            ...(data.resultOrigin === undefined ? {} : { resultOrigin: data.resultOrigin }),
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          visitedNodes.add(data.nodeId);
          break;
        }
        case 'nodeOutputsCleared': {
          const { data } = event;
          const node = getNode(data.nodeId);
          if (data.processId == null) {
            nodeResults.delete(data.nodeId);
          }
          emitDetached(emitter, 'nodeOutputsCleared', {
            node,
            processId: data.processId as ProcessId | undefined,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'partialOutput': {
          const { data } = event;
          const node = getNode(data.nodeId);
          emitDetached(emitter, 'partialOutput', {
            node,
            outputs: data.outputs,
            index: data.index,
            processId: data.processId as ProcessId,
            ...(data.resultOrigin === undefined ? {} : { resultOrigin: data.resultOrigin }),
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'progress': {
          const { data } = event;
          emitDetached(emitter, 'progress', {
            node: getNode(data.nodeId),
            processId: data.processId as ProcessId,
            progress: data.progress,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'llmCallFinished': {
          const { data } = event;
          emitDetached(emitter, 'llmCallFinished', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'toolCallFinished': {
          const { data } = event;
          emitDetached(emitter, 'toolCallFinished', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.sourceNodeId), data.execution),
          });
          break;
        }
        case 'userInput': {
          const { data } = event;
          const node = getNode(data.nodeId) as UserInputNode;
          emitDetached(emitter, 'userInput', {
            callback: undefined as unknown as (values: StringArrayDataValue) => void,
            inputStrings: data.inputStrings,
            inputs: data.inputs,
            node,
            processId: data.processId as ProcessId,
            renderingType: data.renderingType,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'newAbortController': {
          break;
        }
        case 'finish': {
          emitDetached(emitter, 'finish', undefined);
          break;
        }
        default: {
          const typedEvent = event as RecordedEvents;
          if (typedEvent.type.startsWith('globalSet:')) {
            emitDetached(
              emitter as Emittery<ProcessEvents & Record<`globalSet:${string}`, ProcessEvents[`globalSet:${string}`]>>,
              typedEvent.type as `globalSet:${string}`,
              typedEvent.data as ProcessEvents[`globalSet:${string}`],
            );
          } else if (typedEvent.type.startsWith('userEvent:')) {
            emitDetached(
              emitter as Emittery<ProcessEvents & Record<`userEvent:${string}`, ProcessEvents[`userEvent:${string}`]>>,
              typedEvent.type as `userEvent:${string}`,
              typedEvent.data as ProcessEvents[`userEvent:${string}`],
            );
          }
          break;
        }
      }
    }
  } catch (error) {
    emitDetached(emitter, 'error', { error: getError(error) });
  } finally {
    setRunning(false);
  }

  return graphOutputs;
}
