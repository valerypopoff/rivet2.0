import {
  logRuntimeDebug,
  logRuntimeInfo,
  ExecutionRecorder,
  type CodeConsoleMessage,
  type GraphOutputs,
  type NodeId,
  type ProjectId,
  type Outputs,
  type ProcessEventMessageMap,
  type RemoteRunRequestId,
  type RivetWebAppStorage,
  type StringArrayDataValue,
  type GraphId,
  type GraphInputNode,
  type Project,
} from '@valerypopoff/rivet2-core';
import { useCurrentExecution } from './useCurrentExecution';
import { graphState } from '../state/graph';
import { settingsState, showNodeRunDurationsState } from '../state/settings';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { useRemoteDebugger } from './useRemoteDebugger';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { loadedProjectState, projectContextState, projectDataState, projectState } from '../state/savedGraphs';
import { useStableCallback } from './useStableCallback';
import { toast, type Id as ToastId } from 'react-toastify';
import { evaluationsState } from '../state/evaluations';
import {
  EvaluationGraphExecutionError,
  fingerprintEvaluationDataset,
  finalizeEvaluationRecordingRetention,
  runEvaluationSuite,
  type EvaluationExecutionMetrics,
  type EvaluationRecordingReference,
  type EvaluationRunPurpose,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import { produce } from 'immer';
import { userInputModalQuestionsState } from '../state/userInput';
import { frozenNodeOutputsState, graphRunningState, lastRunDataByNodeState } from '../state/dataFlow';
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai';
import { type RefObject, useEffect, useRef } from 'react';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import {
  createProcessEventDispatcher,
  getDependentDataForNodeForPreload,
  getEditorRunFromPlan,
  getEditorRunToPlan,
  getFrozenNodeOptionsForExecutorTarget,
  getFrozenNodeOutputsForExecutorRunPayload,
  shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent,
} from './remoteExecutorHelpers.js';
import { handleError } from '../utils/errorHandling.js';
import { getLLMChatV2ApiKeyEnvVarNames } from '../utils/chatV2ProviderEnv.js';
import { useEnvironmentProvider, useEvaluationRunStore } from '../providers/ProvidersContext.js';
import { pluginsState } from '../state/plugins.js';
import { withDerivedProjectPluginSpecs } from '../utils/pluginUsage.js';
import { getProjectContextValues } from '../utils/projectContextValues.js';
import {
  resetRemoteExecutorUploadCache,
  type RemoteExecutorUploadCache,
  uploadRemoteExecutorProjectIfNeeded,
} from './remoteExecutorUploadCache.js';
import type { ExecutorSessionRuntime } from './executorSession.js';
import {
  clearActiveRemoteRunRequest,
  clearActiveRemoteRunRequestIfMatches,
  createUnscopedRemoteExecutionRoutingState,
  getRemoteExecutionEventDispatchDecision,
  resetUnscopedRemoteExecutionRoutingState,
  sendPendingRemoteGraphRunRequest,
  startActiveRemoteGraphRunRequest,
} from './remoteExecutorRunRequest.js';
import {
  createRemoteDebuggerDiagnostics,
  isAbortLikeRemoteDebuggerNodeError,
  shouldLogRemoteDebuggerNodeExcluded,
  summarizeRemoteDebuggerEvent,
  summarizeRemoteDebuggerRoutingState,
} from './remoteDebuggerDiagnostics.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';
import { waitForExecutorSessionRunCapability } from './executorSessionRunReadiness.js';
import {
  formatEvaluationCompletionToast,
  formatEvaluationRunHistoryPersistenceWarning,
} from '../utils/evaluationRunSummary.js';
import { evaluationRecordingRetentionUpdates } from '../utils/evaluationRecordingRetentionUpdates.js';
import {
  captureRemoteResponseTraceRootExecution,
  collectRemoteAgentTraceEvent,
  emitRemoteResponseTrace,
  type RemoteResponseTraceState,
} from './remoteResponseTrace.js';

type RemoteExecutorMessageHandler = Parameters<ExecutorSessionRuntime['subscribeMessages']>[0];

type RemoteEvaluationMetricsState = {
  metrics: EvaluationExecutionMetrics;
  providerAttempts: PortableJson[];
};

function createRemoteEvaluationMetricsState(): RemoteEvaluationMetricsState {
  return {
    metrics: { durationMs: 0, modelCallCount: 0, toolCallCount: 0, toolFailureCount: 0 },
    providerAttempts: [],
  };
}

function collectRemoteEvaluationEvent(
  state: RemoteEvaluationMetricsState | undefined,
  message: 'llmCallFinished' | 'llmProfileAttempt' | 'toolCallFinished',
  data: unknown,
): void {
  if (!state) return;

  if (message === 'llmCallFinished') {
    const event = data as ProcessEventMessageMap['llmCallFinished'];
    state.metrics.modelCallCount = (state.metrics.modelCallCount ?? 0) + 1;
    state.metrics.inputTokens = (state.metrics.inputTokens ?? 0) + (event.normalizedUsage?.promptTokens ?? 0);
    state.metrics.outputTokens = (state.metrics.outputTokens ?? 0) + (event.normalizedUsage?.completionTokens ?? 0);
    state.metrics.cachedInputTokens =
      (state.metrics.cachedInputTokens ?? 0) + (event.normalizedUsage?.cachedTokens ?? 0);
    state.metrics.reasoningTokens =
      (state.metrics.reasoningTokens ?? 0) + (event.normalizedUsage?.reasoningTokens ?? 0);
    if (event.pricing.status === 'known')
      state.metrics.costUsd = (state.metrics.costUsd ?? 0) + (event.pricing.costUsd ?? 0);
    else state.metrics.hasUnknownCost = true;
    state.providerAttempts.push({
      kind: 'provider-call',
      provider: event.provider,
      model: event.model,
      customProviderApi: event.customProviderApi ?? null,
      outcome: event.outcome,
      finishReason: event.finishReason ?? null,
      profileIndex: event.profileIndex ?? null,
      attemptIndex: event.attemptIndex,
      roundIndex: event.roundIndex ?? null,
      durationMs: event.durationMs ?? null,
    });
    return;
  }

  if (message === 'llmProfileAttempt') {
    const event = data as ProcessEventMessageMap['llmProfileAttempt'];
    state.providerAttempts.push({
      kind: 'profile-decision',
      provider: event.provider,
      model: event.model,
      customProviderApi: event.customProviderApi ?? null,
      stage: event.stage,
      outcome: event.outcome,
      profileIndex: event.profileIndex ?? null,
      attemptIndex: event.attemptIndex ?? null,
      roundIndex: event.roundIndex,
      status: event.status ?? null,
      healthState: event.healthState ?? null,
      healthDisposition: event.healthDisposition ?? null,
      timeoutKind: event.timeoutKind ?? null,
    });
    return;
  }

  const event = data as ProcessEventMessageMap['toolCallFinished'];
  state.metrics.toolCallCount = (state.metrics.toolCallCount ?? 0) + 1;
  if (event.outcome !== 'success') state.metrics.toolFailureCount = (state.metrics.toolFailureCount ?? 0) + 1;
}

function evaluationInputsToGraphOutputs(
  project: Project,
  graphId: GraphId,
  inputs: Record<string, PortableJson>,
): GraphOutputs {
  const graph = project.graphs[graphId];
  if (!graph) throw new Error(`Evaluation target graph "${graphId}" does not exist.`);
  const graphInputs = new Map(
    graph.nodes
      .filter((node): node is GraphInputNode => node.type === 'graphInput')
      .map((node) => [node.data.id, node]),
  );
  return Object.fromEntries(
    Object.entries(inputs).map(([inputId, value]) => {
      const graphInput = graphInputs.get(inputId);
      if (!graphInput) throw new Error(`Evaluation provided unknown graph input "${inputId}".`);
      return [inputId, { type: graphInput.data.dataType, value }];
    }),
  ) as GraphOutputs;
}

function createRemoteEvaluationRecordingReference(): EvaluationRecordingReference {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `evaluation-recording-${id}`,
    retention: 'temporary',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function useRemoteExecutor() {
  const executorSession = useExecutorSessionRuntime();
  const environmentProvider = useEnvironmentProvider();
  const evaluationRunStore = useEvaluationRunStore();
  const store = useStore();
  const activeGraphRequestIdRef = useRef<RemoteRunRequestId | null>(null);
  // An evaluation owns several remote graph requests at once, so it cannot
  // share the normal one-request editor abort state.
  const evaluationAbortControllerRef = useRef<AbortController | null>(null);
  const evaluationProjectIdRef = useRef<ProjectId | null>(null);
  const earlyResultRequestIdsRef = useRef(new Set<RemoteRunRequestId>());
  const webAppStoragePatchCallbacksByRequestIdRef = useRef(
    new Map<RemoteRunRequestId, (storagePatch: RivetWebAppStorage) => void>(),
  );
  const responseTraceByRequestIdRef = useRef(new Map<RemoteRunRequestId, RemoteResponseTraceState>());
  const evaluationMetricsByRequestIdRef = useRef(new Map<RemoteRunRequestId, RemoteEvaluationMetricsState>());
  const externalDebuggerRunFlushedFrozenOutputsRef = useRef(false);
  const remoteDebuggerDiagnosticsRef = useRef(createRemoteDebuggerDiagnostics());
  const unscopedEventRoutingRef = useRef(createUnscopedRemoteExecutionRoutingState());
  const uploadCacheRef = useRef<RemoteExecutorUploadCache>({});
  const projectNodeRegistry = useProjectNodeRegistry();
  const project = useAtomValue(projectState);
  const projectData = useAtomValue(projectDataState);

  const projectContext = useAtomValue(projectContextState(project.metadata.id));

  const currentExecution = useCurrentExecution({
    onMissingDebuggerTerminalEvent: (event) => {
      if (executorSession.getRuntimeState().target?.type !== 'external-debugger') {
        return;
      }

      remoteDebuggerDiagnosticsRef.current.logMissingTerminalEvent(event);
    },
  });
  const graph = useAtomValue(graphState);
  const savedSettings = useAtomValue(settingsState);
  const showNodeRunDurations = useAtomValue(showNodeRunDurationsState);
  const [evaluations, setEvaluationsState] = useAtom(evaluationsState);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const frozenNodeOutputs = useAtomValue(frozenNodeOutputsState);
  const setFrozenNodeOutputs = useSetAtom(frozenNodeOutputsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const pluginStates = useAtomValue(pluginsState);

  const remoteDebugger = useRemoteDebugger({
    onDisconnect: () => {
      evaluationAbortControllerRef.current?.abort(
        new DOMException('Remote executor disconnected while an evaluation was running.', 'AbortError'),
      );
      evaluationAbortControllerRef.current = null;
      evaluationProjectIdRef.current = null;
      clearActiveRemoteRunRequest(activeGraphRequestIdRef);
      earlyResultRequestIdsRef.current.clear();
      webAppStoragePatchCallbacksByRequestIdRef.current.clear();
      responseTraceByRequestIdRef.current.clear();
      evaluationMetricsByRequestIdRef.current.clear();
      executorSession.setActiveGraphRunRequestId(null);
      if (store.get(projectState).metadata.id !== project.metadata.id) {
        return;
      }

      if (store.get(graphRunningState)) {
        currentExecution.onRunActivityEvent('error', {
          error: new Error('Remote executor disconnected before the graph run reached a terminal event.'),
        });
      }
      currentExecution.onStop();
    },
  });

  const eventDispatcher = createProcessEventDispatcher(currentExecution);

  // Evaluations expose one active suite in the editor. Stop a remote
  // evaluation when the user changes project instead of allowing its later
  // events to appear under a different project's Evaluations workspace.
  useEffect(() => {
    if (evaluationProjectIdRef.current == null || evaluationProjectIdRef.current === project.metadata.id) return;
    evaluationAbortControllerRef.current?.abort(new DOMException('Active project changed.', 'AbortError'));
  }, [project.metadata.id]);

  useEffect(() => {
    externalDebuggerRunFlushedFrozenOutputsRef.current = false;
    remoteDebuggerDiagnosticsRef.current.reset();
    resetUnscopedRemoteExecutionRoutingState(unscopedEventRoutingRef.current);
    activeGraphRequestIdRef.current = executorSession.getActiveGraphRunRequestId();
  }, [executorSession, project.metadata.id]);

  useEffect(() => {
    const resetSessionCaches = () => {
      externalDebuggerRunFlushedFrozenOutputsRef.current = false;
      remoteDebuggerDiagnosticsRef.current.reset();
      resetRemoteExecutorUploadCache(uploadCacheRef.current);
    };
    const unsubscribeConnect = executorSession.subscribeLifecycle('connect', resetSessionCaches);
    const unsubscribeDisconnect = executorSession.subscribeLifecycle('disconnect', resetSessionCaches);

    return () => {
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [executorSession]);

  const handleExecutorMessage: RemoteExecutorMessageHandler = useStableCallback((message, data, requestId) => {
    if (store.get(projectState).metadata.id !== project.metadata.id) {
      return;
    }

    const sessionState = executorSession.getRuntimeState();
    const externalDebuggerTarget = sessionState.target?.type === 'external-debugger' ? sessionState.target : undefined;
    const routingBefore = externalDebuggerTarget
      ? summarizeRemoteDebuggerRoutingState(unscopedEventRoutingRef.current)
      : undefined;
    const eventSummary = externalDebuggerTarget ? summarizeRemoteDebuggerEvent(message, data) : undefined;
    const dispatchDecision = getRemoteExecutionEventDispatchDecision({
      activeRequestId: activeGraphRequestIdRef.current ?? executorSession.getActiveGraphRunRequestId(),
      currentProjectId: project.metadata.id,
      data,
      message,
      requestId,
      unscopedRoutingState: unscopedEventRoutingRef.current,
    });
    const shouldDispatchExecutionEvent = dispatchDecision.shouldDispatch;
    const routingAfter = externalDebuggerTarget
      ? summarizeRemoteDebuggerRoutingState(unscopedEventRoutingRef.current)
      : undefined;

    if (
      shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
        alreadyFlushed: externalDebuggerRunFlushedFrozenOutputsRef.current,
        message,
        shouldDispatchExecutionEvent,
        target: externalDebuggerTarget,
      })
    ) {
      externalDebuggerRunFlushedFrozenOutputsRef.current = true;
      setFrozenNodeOutputs({});
    }

    if (externalDebuggerTarget && routingBefore && routingAfter && eventSummary) {
      remoteDebuggerDiagnosticsRef.current.recordEvent({
        activeRequestId: activeGraphRequestIdRef.current,
        currentProjectId: project.metadata.id,
        decision: dispatchDecision,
        event: eventSummary,
        message,
        requestId,
        routingAfter,
        routingBefore,
        session: {
          status: sessionState.status,
          targetType: externalDebuggerTarget.type,
          url: externalDebuggerTarget.url,
        },
      });
    }

    switch (message) {
      case 'codeConsole':
        if (shouldDispatchExecutionEvent) {
          logCodeConsoleMessage(data as CodeConsoleMessage);
        }
        break;
      case 'nodeStart':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.nodeStart(data);
        }
        break;
      case 'nodeFinish':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.nodeFinish(data);
        }
        break;
      case 'nodeError':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.nodeError(data);
          if (eventSummary && isAbortLikeRemoteDebuggerNodeError(data)) {
            remoteDebuggerDiagnosticsRef.current.logUnexpectedAbortNodeError(eventSummary);
          }
        }
        break;
      case 'userInput':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.userInput(data);
        }
        break;
      case 'start':
        captureRemoteResponseTraceRootExecution(responseTraceByRequestIdRef.current, requestId, data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.start(data);
        }
        break;
      case 'done':
        executorSession.resolvePendingGraphExecution(requestId, (data as { results: unknown }).results as any);
        if (requestId) {
          earlyResultRequestIdsRef.current.delete(requestId);
          webAppStoragePatchCallbacksByRequestIdRef.current.delete(requestId);
          responseTraceByRequestIdRef.current.delete(requestId);
        }
        clearActiveRemoteRunRequestIfMatches(activeGraphRequestIdRef, requestId);
        if (requestId === executorSession.getActiveGraphRunRequestId()) {
          executorSession.setActiveGraphRunRequestId(null);
        }
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.done(data);
        }
        break;
      case 'graphOutputsReady':
        emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, true);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.graphOutputsReady(data);
        }
        if (requestId) {
          earlyResultRequestIdsRef.current.add(requestId);
          webAppStoragePatchCallbacksByRequestIdRef.current.delete(requestId);
        }
        executorSession.resolvePendingGraphExecution(requestId, (data as { outputs: GraphOutputs }).outputs);
        break;
      case 'webAppStoragePatch': {
        const callback = requestId ? webAppStoragePatchCallbacksByRequestIdRef.current.get(requestId) : undefined;
        if (callback) {
          try {
            callback((data as ProcessEventMessageMap['webAppStoragePatch']).storagePatch);
          } catch (error) {
            handleError(error, 'Failed to apply web app storage returned by the executor.');
          }
        }
        break;
      }
      case 'abort':
        executorSession.rejectPendingGraphExecution(requestId, new Error('graph execution aborted'));
        if (requestId) {
          earlyResultRequestIdsRef.current.delete(requestId);
          webAppStoragePatchCallbacksByRequestIdRef.current.delete(requestId);
          emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, false, 'aborted');
          responseTraceByRequestIdRef.current.delete(requestId);
        }
        clearActiveRemoteRunRequestIfMatches(activeGraphRequestIdRef, requestId);
        if (requestId === executorSession.getActiveGraphRunRequestId()) {
          executorSession.setActiveGraphRunRequestId(null);
        }
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.abort(data);
        }
        break;
      case 'graphAbort':
        emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, false, 'aborted');
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.graphAbort(data);
        }
        break;
      case 'graphError':
        emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, false, 'error');
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.graphError(data);
        }
        break;
      case 'partialOutput':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.partialOutput(data);
        }
        break;
      case 'llmCallFinished':
        collectRemoteEvaluationEvent(
          requestId == null ? undefined : evaluationMetricsByRequestIdRef.current.get(requestId),
          'llmCallFinished',
          data,
        );
        collectRemoteAgentTraceEvent(responseTraceByRequestIdRef.current, requestId, 'llm-call-finished', data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.llmCallFinished(data);
        }
        break;
      case 'llmProfileAttempt':
        collectRemoteEvaluationEvent(
          requestId == null ? undefined : evaluationMetricsByRequestIdRef.current.get(requestId),
          'llmProfileAttempt',
          data,
        );
        collectRemoteAgentTraceEvent(responseTraceByRequestIdRef.current, requestId, 'llm-profile-attempt', data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.llmProfileAttempt(data);
        }
        break;
      case 'toolCallFinished':
        collectRemoteEvaluationEvent(
          requestId == null ? undefined : evaluationMetricsByRequestIdRef.current.get(requestId),
          'toolCallFinished',
          data,
        );
        collectRemoteAgentTraceEvent(responseTraceByRequestIdRef.current, requestId, 'tool-call-finished', data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.toolCallFinished(data);
        }
        break;
      case 'progress':
        executorSession.reportPendingGraphProgress(requestId, (data as ProcessEventMessageMap['progress']).progress);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.progress(data);
        }
        break;
      case 'graphStart':
        captureRemoteResponseTraceRootExecution(responseTraceByRequestIdRef.current, requestId, data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.graphStart(data);
        }
        break;
      case 'graphFinish':
        emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, false);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.graphFinish(data);
        }
        break;
      case 'nodeOutputsCleared':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.nodeOutputsCleared(data);
        }
        break;
      case 'trace':
        if (shouldDispatchExecutionEvent) {
          logRuntimeDebug('Remote graph trace', { trace: data });
        }
        break;
      case 'pause':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.pause(data);
        }
        break;
      case 'resume':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.resume(data);
        }
        break;
      case 'error':
        executorSession.rejectPendingGraphExecution(requestId, (data as { error: Error }).error);
        if (requestId) {
          earlyResultRequestIdsRef.current.delete(requestId);
          webAppStoragePatchCallbacksByRequestIdRef.current.delete(requestId);
          emitRemoteResponseTrace(responseTraceByRequestIdRef.current, requestId, data, false, 'error');
          responseTraceByRequestIdRef.current.delete(requestId);
        }
        clearActiveRemoteRunRequestIfMatches(activeGraphRequestIdRef, requestId);
        if (requestId === executorSession.getActiveGraphRunRequestId()) {
          executorSession.setActiveGraphRunRequestId(null);
        }
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.error(data);
        }
        break;
      case 'nodeExcluded':
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.nodeExcluded(data);
          if (eventSummary && shouldLogRemoteDebuggerNodeExcluded(eventSummary)) {
            remoteDebuggerDiagnosticsRef.current.logNodeExcluded(eventSummary);
          }
        }
        break;
    }
  });

  useEffect(() => {
    return executorSession.subscribeMessages(handleExecutorMessage);
  }, [executorSession, handleExecutorMessage]);

  const tryRunGraph = async (options: EditorGraphRunOptions = {}): Promise<GraphOutputs | undefined> => {
    options.abortSignal?.throwIfAborted();
    let sessionState = executorSession.getRuntimeState();
    if (!sessionState.capabilities.canSendRun && options.waitForResults) {
      sessionState = await waitForExecutorSessionRunCapability(executorSession);
      options.abortSignal?.throwIfAborted();
    }

    if (!sessionState.capabilities.canSendRun) {
      logRuntimeDebug('Remote graph run skipped because executor session cannot send runs.', {
        status: sessionState.status,
        target: sessionState.target?.type ?? 'none',
      });
      if (options.throwOnError) {
        throw new Error(`Executor cannot run graphs right now (status: ${sessionState.status}).`);
      }
      return undefined;
    }

    const graphToRun = options.graphId ?? graph.metadata!.id!;

    try {
      const projectWithCurrentGraph = withDerivedProjectPluginSpecs(
        {
          ...project,
          graphs: {
            ...project.graphs,
            [graph.metadata!.id!]: graph,
          },
        },
        {
          appPluginStates: pluginStates,
          currentGraph: graph,
          registry: projectNodeRegistry,
        },
      );

      if (executorSession.getRuntimeState().capabilities.canUploadProject) {
        const projectToUpload = projectWithCurrentGraph;
        const settings = await fillMissingSettingsFromEnvironmentVariables(
          savedSettings,
          projectNodeRegistry.getPlugins(),
          {
            environmentProvider,
            extraEnvVarNames: getLLMChatV2ApiKeyEnvVarNames(projectToUpload),
          },
        );

        uploadRemoteExecutorProjectIfNeeded({
          cache: uploadCacheRef.current,
          project: projectToUpload,
          projectData,
          sessionKey: getRemoteExecutorUploadSessionKey(executorSession.getRuntimeState()),
          settings,
          transport: {
            sendDynamicData: (payload) => remoteDebugger.send('set-dynamic-data', payload),
            sendStaticData: (id, dataValue) => remoteDebugger.sendRaw(`set-static-data:${id}:${dataValue}`),
          },
        });
      }

      const contextValues = getProjectContextValues(projectContext);
      let runToNodeIds = options.to;
      let preloadData: Record<NodeId, Outputs> | undefined;

      if (options.from) {
        const runFromPlan = getEditorRunFromPlan(
          projectWithCurrentGraph,
          graphToRun,
          options.from,
          projectNodeRegistry,
        );
        runToNodeIds = runFromPlan.runToNodeIds;
        preloadData = getDependentDataForNodeForPreload(
          runFromPlan.preloadNodeIds,
          lastRunData,
          getFrozenNodeOptionsForExecutorTarget(frozenNodeOutputs, graphToRun, sessionState.target),
        );
        currentExecution.preserveNodeRunDataForNextStart(runFromPlan.preserveNodeIds);
        currentExecution.suppressPreloadedNodeEventsForCurrentRun(runFromPlan.preloadNodeIds);
      } else if (options.to) {
        const runToPlan = getEditorRunToPlan(
          projectWithCurrentGraph,
          graphToRun,
          options.to,
          projectNodeRegistry,
          getFrozenNodeOptionsForExecutorTarget(frozenNodeOutputs, graphToRun, sessionState.target),
        );
        runToNodeIds = runToPlan.runToNodeIds;
        currentExecution.preserveNodeRunDataForNextStart(runToPlan.preserveNodeIds);
      }

      const payload = {
        graphId: graphToRun,
        runToNodeIds,
        preloadData,
        frozenNodeOutputs: getFrozenNodeOutputsForExecutorRunPayload(frozenNodeOutputs, sessionState.target),
        contextValues,
        inputs: options.inputs,
        projectPath: loadedProject.path,
        useEditorCache: true,
        captureNodeTimings: showNodeRunDurations,
        returnWhenGraphOutputsReady: options.returnWhenGraphOutputsReady,
        ...(options.webAppStorage === undefined ? {} : { webAppStorage: options.webAppStorage }),
      };

      if (options.waitForResults) {
        return await sendPendingRemoteGraphRunRequest({
          abortSignal: options.abortSignal,
          disconnectErrorMessage: 'Remote executor disconnected before the graph run could be sent.',
          executorSession,
          onRequestCreated: (requestId) => {
            activeGraphRequestIdRef.current = requestId;
            executorSession.setActiveGraphRunRequestId(requestId);
            if (options.onWebAppStoragePatch) {
              webAppStoragePatchCallbacksByRequestIdRef.current.set(requestId, options.onWebAppStoragePatch);
            }
            if (options.onResponseTrace) {
              responseTraceByRequestIdRef.current.set(requestId, {
                callback: options.onResponseTrace,
                events: [],
                startedAt: Date.now(),
                delivered: false,
              });
            }
          },
          onRequestSettled: (requestId) => {
            if (earlyResultRequestIdsRef.current.has(requestId)) {
              return;
            }
            webAppStoragePatchCallbacksByRequestIdRef.current.delete(requestId);
            if (!earlyResultRequestIdsRef.current.has(requestId)) {
              responseTraceByRequestIdRef.current.delete(requestId);
            }
            clearActiveRemoteRunRequestIfMatches(activeGraphRequestIdRef, requestId);
            if (requestId === executorSession.getActiveGraphRunRequestId()) {
              executorSession.setActiveGraphRunRequestId(null);
            }
          },
          onProgress: options.onProgress,
          payload,
          sendAbort: (requestId) => remoteDebugger.send('abort', { requestId }),
          sendRun: (payload) => remoteDebugger.send('run', payload),
        });
      }

      const runRequest = startActiveRemoteGraphRunRequest({
        activeRequestIdRef: activeGraphRequestIdRef,
        createRequestId: () => executorSession.createRemoteExecutionRequest(),
        payload,
        sendRun: (payload) => remoteDebugger.send('run', payload),
      });
      if (runRequest.type === 'sent') {
        executorSession.setActiveGraphRunRequestId(runRequest.requestId);
      }
      if (runRequest.type === 'send-failed') {
        currentExecution.clearNodeRunDataPreservationForNextStart();
        logRuntimeDebug('Remote graph run skipped because executor session disconnected before send.', {
          target: executorSession.getRuntimeState().target?.type ?? 'none',
        });
      }
      return undefined;
    } catch (e) {
      currentExecution.clearNodeRunDataPreservationForNextStart();
      if (options.throwOnError) {
        logRuntimeDebug('Remote graph run failed.', { error: e });
        throw e;
      }
      handleError(e, 'Failed to start remote graph run');
    }
    return undefined;
  };

  const tryRunEvaluation = useStableCallback(
    async ({
      suiteId,
      projectOverride,
      purpose,
    }: {
      suiteId: string;
      projectOverride?: Project;
      purpose: EvaluationRunPurpose;
    }) => {
      const suite = evaluations.data.suites.find((candidate) => candidate.id === suiteId);
      const dataset = evaluations.datasets.find((candidate) => candidate.id === suite?.datasetId);
      if (!suite || !dataset) throw new Error('The selected evaluation suite or its dataset no longer exists.');
      const evaluationBaseProject = projectOverride ?? project;
      // The active canvas may be unrelated to the selected suite. Always use
      // the suite target when deriving the remotely uploaded project.
      const evaluationGraph = evaluationBaseProject.graphs[suite.targetGraphId];
      if (!evaluationGraph) {
        throw new Error(`Evaluation target graph "${suite.targetGraphId}" no longer exists.`);
      }
      const projectForEvaluation = withDerivedProjectPluginSpecs(
        evaluationBaseProject,
        { appPluginStates: pluginStates, currentGraph: evaluationGraph, registry: projectNodeRegistry },
      );
      const evaluationProjectId = projectForEvaluation.metadata.id;
      if (!evaluationProjectId)
        throw new Error('The loaded project is missing its project ID, so the evaluation cannot be stored.');
      if (evaluationAbortControllerRef.current) {
        throw new Error('An evaluation is already running for this project.');
      }

      // Register before the asynchronous storage and executor preparation.
      // Otherwise switching projects during that work can start an evaluation
      // after its originating workspace has already gone away.
      const evaluationAbortController = new AbortController();
      evaluationAbortControllerRef.current = evaluationAbortController;
      evaluationProjectIdRef.current = evaluationProjectId;
      const isActiveEvaluationProject = () => store.get(projectState).metadata.id === evaluationProjectId;
      const ensureActiveEvaluationProject = () => {
        if (evaluationAbortController.signal.aborted) throw evaluationAbortController.signal.reason;
        if (isActiveEvaluationProject()) return;

        const reason = new DOMException('Active project changed.', 'AbortError');
        evaluationAbortController.abort(reason);
        throw reason;
      };
      const updateActiveProjectEvaluationState = (update: Parameters<typeof setEvaluationsState>[0]): void => {
        if (isActiveEvaluationProject()) setEvaluationsState(update);
      };
      let runningToastId: ToastId | undefined;
      try {
        let datasetSnapshotWarning: string | undefined;
        try {
          await evaluationRunStore.putDatasetSnapshot({
            projectId: evaluationProjectId,
            fingerprint: fingerprintEvaluationDataset(dataset),
            dataset: structuredClone({ ...dataset, projectId: evaluationProjectId }),
            createdAt: new Date().toISOString(),
          });
          ensureActiveEvaluationProject();
        } catch (error) {
          if (evaluationAbortController.signal.aborted) throw evaluationAbortController.signal.reason;
          datasetSnapshotWarning =
            'The exact evaluation dataset snapshot could not be retained; later replay may not have the original cases.';
          logRuntimeDebug('Remote evaluation dataset snapshot was not retained.', {
            error,
            suiteId,
            projectId: evaluationProjectId,
          });
        }

        const sessionState = executorSession.getRuntimeState();
        if (!sessionState.capabilities.canSendRun) {
          throw new Error(
            `Remote executor cannot accept an evaluation run right now (status: ${sessionState.status}, target: ${sessionState.target?.type ?? 'none'}).`,
          );
        }
        if (sessionState.capabilities.canUploadProject) {
          const settings = await fillMissingSettingsFromEnvironmentVariables(
            savedSettings,
            projectNodeRegistry.getPlugins(),
            {
              environmentProvider,
              extraEnvVarNames: getLLMChatV2ApiKeyEnvVarNames(projectForEvaluation),
            },
          );
          ensureActiveEvaluationProject();
          uploadRemoteExecutorProjectIfNeeded({
            cache: uploadCacheRef.current,
            project: projectForEvaluation,
            sessionKey: getRemoteExecutorUploadSessionKey(sessionState),
            settings,
            transport: {
              sendDynamicData: (payload) => remoteDebugger.send('set-dynamic-data', payload),
              sendStaticData: (id, dataValue) => remoteDebugger.sendRaw(`set-static-data:${id}:${dataValue}`),
            },
          });
        }

        ensureActiveEvaluationProject();
        const runKind = purpose === 'evaluation' ? 'evaluation' : 'execution benchmark';
        runningToastId = toast.info(`Running ${runKind}: ${suite.name}`);
        currentExecution.onEvaluationStart();
        updateActiveProjectEvaluationState((state) => ({ ...state, runningSuiteId: suiteId, currentRun: undefined }));
        const result = await runEvaluationSuite({
          project: projectForEvaluation,
          evaluationData: evaluations.data,
          dataset,
          suiteId,
          purpose,
          executionMode: 'remote',
          signal: evaluationAbortController.signal,
          onUpdate: (run) => {
            updateActiveProjectEvaluationState((state) => ({ ...state, currentRun: run }));
          },
          runGraph: async ({ graphId, inputs, project: evaluationProject, signal, metadata }) => {
            const startedAt = Date.now();
            if (signal?.aborted) throw signal.reason;
            let requestId: RemoteRunRequestId | undefined;
            const captured = createRemoteEvaluationMetricsState();
            const recorder = new ExecutionRecorder();
            const recording = createRemoteEvaluationRecordingReference();
            const recordingAbortController = new AbortController();
            let recorderPromise: Promise<void> | undefined;
            const persistRecording = async (): Promise<EvaluationRecordingReference | undefined> => {
              if (recorder.events.length === 0) return undefined;
              try {
                await evaluationRunStore.putRecording({
                  projectId: evaluationProjectId,
                  runId: metadata.evaluationRunId,
                  trialId: `${metadata.caseId}:${metadata.trialIndex}`,
                  reference: recording,
                  serialized: recorder.serialize(),
                  createdAt: new Date().toISOString(),
                });
                return recording;
              } catch (error) {
                logRuntimeDebug('Remote evaluation recording was not retained.', {
                  error,
                  graphId,
                  evaluationRunId: metadata.evaluationRunId,
                });
                return undefined;
              }
            };
            try {
              const outputs = await sendPendingRemoteGraphRunRequest({
                abortSignal: signal,
                disconnectErrorMessage: 'Remote executor disconnected before the evaluation graph run could be sent.',
                executorSession,
                onRequestCreated: (createdRequestId) => {
                  requestId = createdRequestId;
                  evaluationMetricsByRequestIdRef.current.set(createdRequestId, captured);
                  recorderPromise = executorSession.recordSocketEvents((socket) =>
                    recorder.recordSocket(socket, {
                      requestId: createdRequestId,
                      signal: recordingAbortController.signal,
                    }),
                  );
                },
                payload: {
                  graphId,
                  inputs: evaluationInputsToGraphOutputs(evaluationProject, graphId, inputs),
                  contextValues: getProjectContextValues(projectContext),
                  projectPath: loadedProject.path,
                  captureNodeTimings: showNodeRunDurations,
                  evaluation: metadata,
                },
                sendAbort: (createdRequestId) => remoteDebugger.send('abort', { requestId: createdRequestId }),
                sendRun: (payload) => remoteDebugger.send('run', payload),
              });
              captured.metrics.durationMs = Date.now() - startedAt;
              await recorderPromise;
              const persistedRecording = await persistRecording();
              return {
                outputs: Object.fromEntries(
                  Object.entries(outputs).map(([key, value]) => [key, value.value as PortableJson]),
                ),
                metrics: captured.metrics,
                ...(persistedRecording === undefined ? {} : { recording: persistedRecording }),
                ...(captured.providerAttempts.length === 0 ? {} : { providerAttempts: captured.providerAttempts }),
              };
            } catch (error) {
              captured.metrics.durationMs = Math.max(captured.metrics.durationMs, Date.now() - startedAt);
              recordingAbortController.abort();
              await recorderPromise;
              const persistedRecording = await persistRecording();
              if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
              throw new EvaluationGraphExecutionError(error instanceof Error ? error.message : String(error), {
                metrics: captured.metrics,
                ...(persistedRecording === undefined ? {} : { recording: persistedRecording }),
                ...(captured.providerAttempts.length === 0 ? {} : { providerAttempts: captured.providerAttempts }),
              });
            } finally {
              recordingAbortController.abort();
              if (requestId !== undefined) evaluationMetricsByRequestIdRef.current.delete(requestId);
            }
          },
        });
        const finalizedResult = finalizeEvaluationRecordingRetention(
          result,
          suite.configuration?.recordingRetention ?? 'failures-and-baselines',
        );
        if (datasetSnapshotWarning) finalizedResult.warnings.push(datasetSnapshotWarning);
        try {
          await Promise.all(
            evaluationRecordingRetentionUpdates(evaluationProjectId, finalizedResult.trials).map((update) =>
              evaluationRunStore.updateRecordingRetention(update),
            ),
          );
        } catch (error) {
          finalizedResult.warnings.push('Some evaluation recording retention updates could not be saved.');
          logRuntimeDebug('Remote evaluation recording retention was not persisted.', {
            error,
            suiteId,
            projectId: evaluationProjectId,
          });
        }
        try {
          await evaluationRunStore.put(finalizedResult);
        } catch (error) {
          finalizedResult.warnings.push(formatEvaluationRunHistoryPersistenceWarning(error));
          logRuntimeDebug('Completed remote evaluation was not retained.', {
            error,
            suiteId,
            projectId: evaluationProjectId,
          });
        }
        updateActiveProjectEvaluationState((state) => ({
          ...state,
          runningSuiteId: undefined,
          currentRun: finalizedResult,
          selectedRunId: finalizedResult.id,
          runs: [finalizedResult, ...state.runs.filter((run) => run.id !== finalizedResult.id)],
        }));
        if (store.get(projectState).metadata.id === evaluationProjectId) {
          toast.info(formatEvaluationCompletionToast(finalizedResult));
        }
        return finalizedResult;
      } catch (error) {
        updateActiveProjectEvaluationState((state) => ({ ...state, runningSuiteId: undefined }));
        if (!evaluationAbortController.signal.aborted && isActiveEvaluationProject()) {
          handleError(error, 'Failed to run evaluation');
        }
        return undefined;
      } finally {
        if (runningToastId !== undefined) toast.dismiss(runningToastId);
        if (evaluationAbortControllerRef.current === evaluationAbortController) {
          evaluationAbortControllerRef.current = null;
          evaluationProjectIdRef.current = null;
        }
      }
    },
  );

  function tryAbortGraph() {
    if (evaluationAbortControllerRef.current) {
      evaluationAbortControllerRef.current.abort(new DOMException('Evaluation canceled.', 'AbortError'));
      return;
    }
    const sessionState = executorSession.getRuntimeState();
    if (!sessionState.capabilities.canSendAbort) {
      logRuntimeDebug('Remote graph abort skipped because executor session cannot send abort.', {
        status: sessionState.status,
        target: sessionState.target?.type ?? 'none',
      });
      return;
    }

    logRuntimeInfo('Aborting via remote debugger');
    const requestId = getActiveGraphRunRequestId(activeGraphRequestIdRef, executorSession);
    const abortSent = remoteDebugger.send('abort', requestId ? { requestId } : undefined);
    if (!abortSent) {
      logRuntimeDebug('Remote graph abort skipped because executor session disconnected before send.', {
        target: executorSession.getRuntimeState().target?.type ?? 'none',
      });
    }
  }

  function tryPauseGraph() {
    const sessionState = executorSession.getRuntimeState();
    if (!sessionState.capabilities.canSendPause) {
      logRuntimeDebug('Remote graph pause skipped because executor session cannot send pause.', {
        status: sessionState.status,
        target: sessionState.target?.type ?? 'none',
      });
      return;
    }

    logRuntimeInfo('Pausing via remote debugger');
    const requestId = getActiveGraphRunRequestId(activeGraphRequestIdRef, executorSession);
    const pauseSent = remoteDebugger.send('pause', requestId ? { requestId } : undefined);
    if (!pauseSent) {
      logRuntimeDebug('Remote graph pause skipped because executor session disconnected before send.', {
        target: executorSession.getRuntimeState().target?.type ?? 'none',
      });
    }
  }

  function tryResumeGraph() {
    const sessionState = executorSession.getRuntimeState();
    if (!sessionState.capabilities.canSendResume) {
      logRuntimeDebug('Remote graph resume skipped because executor session cannot send resume.', {
        status: sessionState.status,
        target: sessionState.target?.type ?? 'none',
      });
      return;
    }

    logRuntimeInfo('Resuming via remote debugger');
    const requestId = getActiveGraphRunRequestId(activeGraphRequestIdRef, executorSession);
    const resumeSent = remoteDebugger.send('resume', requestId ? { requestId } : undefined);
    if (!resumeSent) {
      logRuntimeDebug('Remote graph resume skipped because executor session disconnected before send.', {
        target: executorSession.getRuntimeState().target?.type ?? 'none',
      });
    }
  }

  const submitUserInput = useStableCallback((nodeId: NodeId, answers: StringArrayDataValue) => {
    const requestId = getActiveGraphRunRequestId(activeGraphRequestIdRef, executorSession);
    const inputSent = remoteDebugger.send(
      'user-input',
      requestId ? { nodeId, answers, requestId } : { nodeId, answers },
    );
    if (!inputSent) {
      logRuntimeDebug('Remote user input skipped because executor session disconnected before send.', {
        target: executorSession.getRuntimeState().target?.type ?? 'none',
      });
    }
    setUserInputQuestions((q) =>
      produce(q, (draft) => {
        delete draft[nodeId];
      }),
    );
  });

  return {
    remoteDebugger,
    tryRunGraph,
    tryAbortGraph,
    tryPauseGraph,
    tryResumeGraph,
    active: remoteDebugger.sessionState.capabilities.canSendRun,
    tryRunEvaluation,
    submitUserInput,
  };
}

function getActiveGraphRunRequestId(
  activeGraphRequestIdRef: RefObject<RemoteRunRequestId | null>,
  executorSession: ExecutorSessionRuntime,
): RemoteRunRequestId | null {
  return activeGraphRequestIdRef.current ?? executorSession.getActiveGraphRunRequestId();
}

function getRemoteExecutorUploadSessionKey(
  sessionState: ReturnType<ExecutorSessionRuntime['getRuntimeState']>,
): string {
  return `${sessionState.target?.type ?? 'none'}:${sessionState.url}`;
}

function logCodeConsoleMessage(message: CodeConsoleMessage) {
  switch (message.level) {
    case 'debug':
      console.debug(...message.args);
      break;
    case 'error':
      console.error(...message.args);
      break;
    case 'info':
      console.info(...message.args);
      break;
    case 'warn':
      console.warn(...message.args);
      break;
    case 'log':
    default:
      console.log(...message.args);
      break;
  }
}
