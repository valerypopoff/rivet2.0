import { getError } from '../utils/errors.js';
import type { ExecutionRecorder } from '../recording/ExecutionRecorder.js';
import type { RecordedEvents } from '../recording/RecordedEvents.js';
import type { DataValue } from './DataValue.js';
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

function withReplayRecordedAt<T>(data: T, replayRecordedAt: number | undefined): T {
  if (
    typeof replayRecordedAt !== 'number' ||
    !Number.isFinite(replayRecordedAt) ||
    data == null ||
    typeof data !== 'object'
  ) {
    return data;
  }
  return { ...data, replayRecordedAt } as T;
}

const REPLAY_TIMED_LIFECYCLE_EVENTS = new Set<keyof ProcessEvents>([
  'start',
  'graphStart',
  'graphOutputsReady',
  'graphFinish',
  'graphError',
  'graphAbort',
  'nodeStart',
  'userInput',
  'progress',
  'partialOutput',
  'nodeFinish',
  'nodeError',
  'nodeExcluded',
  'nodeOutputsCleared',
]);

export async function replayExecutionRecording(options: {
  emitter: Emittery<ProcessEvents>;
  erroredNodes: Map<NodeId, Error | string>;
  graphInputs: GraphInputs;
  graphOutputs: GraphOutputs;
  /** Current graph selected for replay; used only if a recording has no scoped lifecycle event. */
  fallbackGraphId?: GraphId;
  /** Identity already allocated by the playback processor for its own lifecycle events. */
  initialReplayExecution?: GraphExecutionMetadata;
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
    fallbackGraphId,
    initialReplayExecution,
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

  let hasEmittedRunActivityExecution = false;
  let getFallbackExecution: ((graphId: GraphId) => GraphExecutionMetadata) | undefined;
  let currentReplayRecordedAt: number | undefined;

  const getReplayFallbackGraph = () => {
    const replayTargetGraph = fallbackGraphId == null ? undefined : project.graphs[fallbackGraphId];
    const projectMainGraph =
      project.metadata.mainGraphId == null ? undefined : project.graphs[project.metadata.mainGraphId];
    return replayTargetGraph ?? projectMainGraph ?? Object.values(project.graphs)[0];
  };

  const emitReplayExecutionEvent = <K extends keyof ProcessEvents>(
    event: K,
    data: ProcessEvents[K] & { execution: GraphExecutionMetadata },
  ): void => {
    // Run Activity can materialize a root only from an execution-bearing
    // lifecycle or observability event. Remember emitted events so a later
    // playback error remains attached to that root instead of synthesizing a
    // second one.
    hasEmittedRunActivityExecution = true;
    const payload = REPLAY_TIMED_LIFECYCLE_EVENTS.has(event)
      ? withReplayRecordedAt(data, currentReplayRecordedAt)
      : data;
    emitDetached(emitter, event, payload);
  };

  const emitReplayTerminalEvent = <K extends 'abort' | 'done' | 'error'>(event: K, data: ProcessEvents[K]): void => {
    emitDetached(emitter, event, withReplayRecordedAt(data, currentReplayRecordedAt));
  };

  const emitFallbackRootTerminal = (
    status: 'completed' | 'error' | 'aborted',
    data: { error?: Error | string; outputs?: GraphOutputs; successful?: boolean },
  ): void => {
    // Older recordings and preflight-error recordings can contain only the
    // unscoped processor terminal. Materialize the current project's root
    // graph once so Run Activity has exact execution identity to attach that
    // terminal confirmation to. Do not add a duplicate when any ordinary
    // graph/node event has already established the replay root.
    if (hasEmittedRunActivityExecution || !getFallbackExecution) return;

    const fallbackGraph = getReplayFallbackGraph();
    const fallbackGraphMetadataId = fallbackGraph?.metadata?.id;
    if (!fallbackGraph || !fallbackGraphMetadataId) return;

    const execution = getFallbackExecution(fallbackGraphMetadataId);
    if (status === 'completed') {
      emitReplayExecutionEvent('graphFinish', {
        graph: fallbackGraph,
        outputs: data.outputs ?? {},
        execution,
      });
      return;
    }

    if (status === 'error') {
      emitReplayExecutionEvent('graphError', {
        graph: fallbackGraph,
        error: data.error ?? 'Recording replay failed before graph execution began.',
        execution,
      });
      return;
    }

    emitReplayExecutionEvent('graphAbort', {
      graph: fallbackGraph,
      error: data.error,
      successful: data.successful ?? false,
      execution,
    });
  };

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
    const legacyRootRunId = initialReplayExecution?.rootRunId ?? (nanoid() as RootRunId);
    const legacyGraphRunsByGraphId = new Map<GraphId, GraphRunId>();
    const replayRootRunIds = new Map<RootRunId, RootRunId>();
    const replayGraphRunIdsByRoot = new Map<RootRunId, Map<GraphRunId, GraphRunId>>();
    const nodeStartTimestamps = new Map<string, number>();

    const getExecution = (graphId: GraphId, recordedExecution?: GraphExecutionMetadata): GraphExecutionMetadata => {
      if (recordedExecution) {
        return getReplayExecution(recordedExecution);
      }

      // Legacy recordings have no execution metadata. Keep the processor's
      // already-allocated selected-graph identity so an external abort during
      // replay terminates the same root instead of creating a second one.
      if (initialReplayExecution?.graphId === graphId) {
        return initialReplayExecution;
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
    getFallbackExecution = (graphId) => getExecution(graphId);

    // A recording describes a past execution, but replay is a new editor run.
    // Reusing recorded identities makes a second playback collide with the
    // journal's terminal root and can leave Run Activity showing stale state.
    // Keep its graph hierarchy intact while assigning fresh replay identity.
    const getReplayExecution = (recordedExecution: GraphExecutionMetadata): GraphExecutionMetadata => {
      let replayRootRunId = replayRootRunIds.get(recordedExecution.rootRunId);
      if (replayRootRunId == null) {
        // The first recorded root belongs to this playback processor. Later
        // roots remain distinct in malformed or concatenated recordings.
        replayRootRunId =
          replayRootRunIds.size === 0 && initialReplayExecution
            ? initialReplayExecution.rootRunId
            : (nanoid() as RootRunId);
        replayRootRunIds.set(recordedExecution.rootRunId, replayRootRunId);
      }

      const getReplayGraphRunId = (recordedGraphRunId: GraphRunId): GraphRunId => {
        let graphRunIds = replayGraphRunIdsByRoot.get(recordedExecution.rootRunId);
        if (graphRunIds == null) {
          graphRunIds = new Map();
          replayGraphRunIdsByRoot.set(recordedExecution.rootRunId, graphRunIds);
        }

        const replayGraphRunId = graphRunIds.get(recordedGraphRunId) ?? (nanoid() as GraphRunId);
        graphRunIds.set(recordedGraphRunId, replayGraphRunId);
        return replayGraphRunId;
      };

      const { rootRunId: _recordedRootRunId, graphRunId, parentGraphRunId, ...rest } = recordedExecution;
      const isInitialRootGraph =
        initialReplayExecution != null &&
        replayRootRunId === initialReplayExecution.rootRunId &&
        parentGraphRunId == null &&
        rest.graphId === initialReplayExecution.graphId;
      return {
        ...rest,
        rootRunId: replayRootRunId,
        graphRunId: isInitialRootGraph ? initialReplayExecution!.graphRunId : getReplayGraphRunId(graphRunId),
        ...(parentGraphRunId == null ? {} : { parentGraphRunId: getReplayGraphRunId(parentGraphRunId) }),
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
      currentReplayRecordedAt = event.ts;

      switch (event.type) {
        case 'start': {
          const { data } = event;
          emitReplayExecutionEvent('start', {
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
          emitFallbackRootTerminal('aborted', event.data);
          emitReplayTerminalEvent('abort', event.data);
          break;
        }
        case 'pause': {
          // A replay does not automatically stop at a historical pause, but
          // observers still need the original lifecycle event to faithfully
          // project the recorded run (including Run Activity's paused state).
          emitDetached(emitter, 'pause', { isReplay: true });
          break;
        }
        case 'resume': {
          emitDetached(emitter, 'resume', { isReplay: true });
          break;
        }
        case 'done': {
          emitFallbackRootTerminal('completed', { outputs: event.data.results });
          emitReplayTerminalEvent('done', event.data);
          setGraphOutputs(event.data.results);
          setRunning(false);
          break;
        }
        case 'error': {
          emitFallbackRootTerminal('error', event.data);
          emitReplayTerminalEvent('error', event.data);
          break;
        }
        case 'globalSet': {
          const { data } = event;
          const legacyGraphId = data.execution?.graphId ?? getReplayFallbackGraph()?.metadata?.id;
          if (legacyGraphId == null) {
            throw new Error(
              'Cannot replay a global value event because the current project has no graph to attach it to.',
            );
          }
          emitDetached(emitter, 'globalSet', {
            ...data,
            execution: getExecution(legacyGraphId, data.execution),
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
          emitReplayExecutionEvent('graphStart', {
            graph: getGraph(data.graphId),
            inputs: data.inputs,
            execution,
          });
          break;
        }
        case 'graphFinish': {
          const { data } = event;
          emitReplayExecutionEvent('graphFinish', {
            graph: getGraph(data.graphId),
            outputs: data.outputs,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphOutputsReady': {
          const { data } = event;
          emitReplayExecutionEvent('graphOutputsReady', {
            graph: getGraph(data.graphId),
            outputs: data.outputs,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphError': {
          const { data } = event;
          emitReplayExecutionEvent('graphError', {
            graph: getGraph(data.graphId),
            error: data.error,
            execution: getExecution(data.graphId, data.execution),
          });
          break;
        }
        case 'graphAbort': {
          const { data } = event;
          emitReplayExecutionEvent('graphAbort', {
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
          emitReplayExecutionEvent('nodeStart', {
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
          emitReplayExecutionEvent(
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
          emitReplayExecutionEvent(
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
          emitReplayExecutionEvent('nodeExcluded', {
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
          emitReplayExecutionEvent('nodeOutputsCleared', {
            node,
            processId: data.processId as ProcessId | undefined,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'partialOutput': {
          const { data } = event;
          const node = getNode(data.nodeId);
          emitReplayExecutionEvent('partialOutput', {
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
          emitReplayExecutionEvent('progress', {
            node: getNode(data.nodeId),
            processId: data.processId as ProcessId,
            progress: data.progress,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'llmCallFinished': {
          const { data } = event;
          emitReplayExecutionEvent('llmCallFinished', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'llmChatOutputSnapshot': {
          const { data } = event;
          emitReplayExecutionEvent('llmChatOutputSnapshot', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'llmProfileAttempt': {
          const { data } = event;
          emitReplayExecutionEvent('llmProfileAttempt', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.nodeId), data.execution),
          });
          break;
        }
        case 'toolCallFinished': {
          const { data } = event;
          emitReplayExecutionEvent('toolCallFinished', {
            ...data,
            execution: getExecution(data.execution?.graphId ?? getGraphIdForNode(data.sourceNodeId), data.execution),
          });
          break;
        }
        case 'userInput': {
          const { data } = event;
          const node = getNode(data.nodeId) as UserInputNode;
          emitReplayExecutionEvent('userInput', {
            // A replayed prompt is historical and must not wait for a new
            // answer, but listeners still receive a safe callback-shaped
            // event for compatibility with ordinary user-input observers.
            callback: () => undefined,
            inputStrings: data.inputStrings,
            inputs: data.inputs,
            isReplay: true,
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
    const replayError = getError(error);

    // A recording can fail before its first graph/node event, for example when
    // it refers to a graph that no longer exists in the loaded project. The
    // normal root-level `error` event is intentionally unscoped, so Run
    // Activity has no active root to attach it to in that case.
    emitFallbackRootTerminal('error', { error: replayError });

    // This is a fresh playback failure, not a historical event from the last
    // successful dispatch. Do not accidentally attribute it to that event's
    // recording timestamp.
    currentReplayRecordedAt = undefined;
    emitReplayTerminalEvent('error', { error: replayError });
  } finally {
    setRunning(false);
  }

  return graphOutputs;
}
