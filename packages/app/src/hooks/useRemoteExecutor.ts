import {
  logRuntimeDebug,
  logRuntimeInfo,
  type CodeConsoleMessage,
  type GraphOutputs,
  type NodeId,
  type Outputs,
  type ProcessEventMessageMap,
  type RemoteRunRequestId,
  type RivetWebAppStorage,
  type StringArrayDataValue,
  type GraphId,
} from '@valerypopoff/rivet2-core';
import { useCurrentExecution } from './useCurrentExecution';
import { graphState } from '../state/graph';
import { settingsState, showNodeRunDurationsState } from '../state/settings';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { useRemoteDebugger } from './useRemoteDebugger';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { loadedProjectState, projectContextState, projectDataState, projectState } from '../state/savedGraphs';
import { useStableCallback } from './useStableCallback';
import { toast } from 'react-toastify';
import { trivetState } from '../state/trivet';
import { runTrivet } from '@valerypopoff/trivet';
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
  selectTestSuitesToRun,
  shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent,
} from './remoteExecutorHelpers.js';
import { handleError } from '../utils/errorHandling.js';
import { getLLMChatV2CustomProviderApiKeyEnvVarNames } from '../utils/chatV2CustomProviderEnv.js';
import { useEnvironmentProvider } from '../providers/ProvidersContext.js';
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
  captureRemoteResponseTraceRootExecution,
  collectRemoteAgentTraceEvent,
  emitRemoteResponseTrace,
  type RemoteResponseTraceState,
} from './remoteResponseTrace.js';

type RemoteExecutorMessageHandler = Parameters<ExecutorSessionRuntime['subscribeMessages']>[0];

export function useRemoteExecutor() {
  const executorSession = useExecutorSessionRuntime();
  const environmentProvider = useEnvironmentProvider();
  const store = useStore();
  const activeGraphRequestIdRef = useRef<RemoteRunRequestId | null>(null);
  const earlyResultRequestIdsRef = useRef(new Set<RemoteRunRequestId>());
  const webAppStoragePatchCallbacksByRequestIdRef = useRef(
    new Map<RemoteRunRequestId, (storagePatch: RivetWebAppStorage) => void>(),
  );
  const responseTraceByRequestIdRef = useRef(new Map<RemoteRunRequestId, RemoteResponseTraceState>());
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
  const [{ testSuites }, setTrivetState] = useAtom(trivetState);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const frozenNodeOutputs = useAtomValue(frozenNodeOutputsState);
  const setFrozenNodeOutputs = useSetAtom(frozenNodeOutputsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const pluginStates = useAtomValue(pluginsState);

  const remoteDebugger = useRemoteDebugger({
    onDisconnect: () => {
      clearActiveRemoteRunRequest(activeGraphRequestIdRef);
      earlyResultRequestIdsRef.current.clear();
      webAppStoragePatchCallbacksByRequestIdRef.current.clear();
      responseTraceByRequestIdRef.current.clear();
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
        collectRemoteAgentTraceEvent(responseTraceByRequestIdRef.current, requestId, 'llm-call-finished', data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.llmCallFinished(data);
        }
        break;
      case 'llmProfileAttempt':
        collectRemoteAgentTraceEvent(responseTraceByRequestIdRef.current, requestId, 'llm-profile-attempt', data);
        if (shouldDispatchExecutionEvent) {
          eventDispatcher.llmProfileAttempt(data);
        }
        break;
      case 'toolCallFinished':
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
            extraEnvVarNames: getLLMChatV2CustomProviderApiKeyEnvVarNames(projectToUpload),
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

  const tryRunTests = useStableCallback(
    async (options: { testSuiteIds?: string[]; testCaseIds?: string[]; iterationCount?: number } = {}) => {
      toast.info(
        (options.iterationCount ?? 1) > 1 ? `Running Tests (${options.iterationCount!} iterations)` : 'Running Tests',
      );
      logRuntimeInfo('Running remote Trivet tests', {
        selectedTestSuiteCount: options.testSuiteIds?.length,
        selectedTestCaseCount: options.testCaseIds?.length,
        iterationCount: options.iterationCount ?? 1,
      });
      currentExecution.onTrivetStart();

      setTrivetState((s) => ({
        ...s,
        runningTests: true,
        recentTestResults: undefined,
      }));
      const testSuitesToRun = selectTestSuitesToRun(testSuites, options);
      try {
        const projectForTests = withDerivedProjectPluginSpecs(
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

        const result = await runTrivet({
          project: projectForTests,
          iterationCount: options.iterationCount,
          testSuites: testSuitesToRun,
          onUpdate: (results) => {
            setTrivetState((s) => ({
              ...s,
              recentTestResults: results,
            }));
          },
          runGraph: async (project, graphId, inputs) => {
            const sessionState = executorSession.getRuntimeState();
            if (!sessionState.capabilities.canSendRun) {
              throw new Error(
                `Remote executor cannot accept a test graph run right now (status: ${sessionState.status}, target: ${
                  sessionState.target?.type ?? 'none'
                }).`,
              );
            }

            if (sessionState.capabilities.canUploadProject) {
              const projectToUpload = withDerivedProjectPluginSpecs(
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
              const settings = await fillMissingSettingsFromEnvironmentVariables(
                savedSettings,
                projectNodeRegistry.getPlugins(),
                {
                  environmentProvider,
                  extraEnvVarNames: getLLMChatV2CustomProviderApiKeyEnvVarNames(projectToUpload),
                },
              );

              uploadRemoteExecutorProjectIfNeeded({
                cache: uploadCacheRef.current,
                project: projectToUpload,
                sessionKey: getRemoteExecutorUploadSessionKey(sessionState),
                settings,
                transport: {
                  sendDynamicData: (payload) => remoteDebugger.send('set-dynamic-data', payload),
                  sendStaticData: (id, dataValue) => remoteDebugger.sendRaw(`set-static-data:${id}:${dataValue}`),
                },
              });
            }

            const contextValues = getProjectContextValues(projectContext);

            const results = await sendPendingRemoteGraphRunRequest({
              disconnectErrorMessage: 'Remote executor disconnected before the test graph run could be sent.',
              executorSession,
              payload: {
                graphId,
                inputs,
                contextValues,
                projectPath: loadedProject.path,
                captureNodeTimings: showNodeRunDurations,
              },
              sendRun: (payload) => remoteDebugger.send('run', payload),
            });
            return results;
          },
        });
        setTrivetState((s) => ({
          ...s,
          recentTestResults: result,
          runningTests: false,
        }));
        toast.info(
          `Ran tests: ${result.testSuiteResults.length} tests, ${
            result.testSuiteResults.filter((t) => t.passing).length
          } passing`,
        );
        logRuntimeInfo('Finished remote Trivet tests', {
          testSuiteCount: result.testSuiteResults.length,
          passingTestSuiteCount: result.testSuiteResults.filter((testSuite) => testSuite.passing).length,
          iterationCount: result.iterationCount,
        });
      } catch (e) {
        setTrivetState((s) => ({
          ...s,
          runningTests: false,
        }));
        handleError(e, 'Failed to run remote tests');
      }
    },
  );

  function tryAbortGraph() {
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
    tryRunTests,
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
