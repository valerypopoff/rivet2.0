import {
  GraphProcessor,
  type NodeId,
  type StringArrayDataValue,
  type DataValue,
  coerceTypeOptional,
  ExecutionRecorder,
  createFrozenNodeOutputResolver,
  type GraphOutputs,
  type Project,
  type GraphId,
  type GraphInputNode,
  type ProcessEventMessageMap,
  type ProcessEvents,
  type ProjectId,
  GptTokenizerTokenizer,
  logRuntimeDebug,
  logRuntimeError,
  logRuntimeInfo,
  AgentResponseTraceCollector,
  serializeDatasets,
  serializeProject,
} from '@valerypopoff/rivet2-core';
import { produce } from 'immer';
import { useEffect, useRef } from 'react';
import { toast, type Id as ToastId } from 'react-toastify';
import { TauriNativeApi } from '../model/native/TauriNativeApi';
import { useStableCallback } from './useStableCallback';
import { useSaveCurrentGraph } from './useSaveCurrentGraph';
import { useCurrentExecution } from './useCurrentExecution';
import { userInputModalQuestionsState } from '../state/userInput';
import {
  loadedProjectState,
  projectContextState,
  projectDataState,
  projectsState,
  projectState,
} from '../state/savedGraphs';
import { recordExecutionsState, settingsState, showNodeRunDurationsState } from '../state/settings';
import { graphState } from '../state/graph';
import {
  getLoadedRecordingForProject,
  isCurrentLoadedRecordingForProject,
  lastRecordingState,
  loadedRecordingState,
  recordingPlaybackStartingState,
} from '../state/execution';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { getLLMChatV2ApiKeyEnvVarNames } from '../utils/chatV2ProviderEnv';
import { applyEvaluationRunEvent, applyEvaluationRunSnapshot, evaluationsState } from '../state/evaluations';
import {
  EvaluationGraphExecutionError,
  type EvaluationExecutionMetrics,
  type EvaluationRecordingReference,
  type EvaluationRunPurpose,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import {
  createEmptyProjectExecutionSnapshot,
  frozenNodeOutputsState,
  lastRunDataByNodeState,
  projectExecutionSnapshotsState,
} from '../state/dataFlow';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { TauriProjectReferenceLoader } from '../model/TauriProjectReferenceLoader';
import {
  useAudioProvider,
  useDataRefs,
  useDatasetProvider,
  useEnvironmentProvider,
  useEvaluationRunStore,
  useLLMProfileHealthStore,
  useLocalExecutionRecordingPersistence,
  usePathPolicyProvider,
} from '../providers/ProvidersContext';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import { handleError } from '../utils/errorHandling.js';
import {
  createProcessEventDispatcher,
  getDependentDataForNodeForPreload,
  getEditorRunFromPlan,
  getEditorRunToPlan,
} from './remoteExecutorHelpers.js';
import { pluginsState } from '../state/plugins.js';
import { withDerivedProjectPluginSpecs } from '../utils/pluginUsage.js';
import { getProjectContextValues } from '../utils/projectContextValues.js';
import { cloneFrozenNodeOutputsForExecutor } from '../utils/frozenNodeOutputs.js';
import { dispatchGraphExecutionEvent } from './graphExecutionEventDispatch.js';
import {
  applyProcessEventToProjectExecutionSnapshots,
  shouldRouteProjectEventToSnapshot,
} from './projectExecutionSnapshotRouting.js';
import type { EditorGraphRunOptions } from './editorGraphRunOptions.js';
import { formatEvaluationCompletionToast } from '../utils/evaluationRunSummary.js';
import { executeEvaluationRunLifecycle } from '../utils/evaluationExecutionLifecycle.js';

function evaluationInputsToGraphOutputs(
  project: Project,
  graphId: GraphId,
  inputs: Record<string, PortableJson>,
): GraphOutputs {
  const graph = project.graphs[graphId];
  if (!graph) {
    throw new Error(`Evaluation target graph "${graphId}" does not exist.`);
  }
  const inputsById = new Map(
    graph.nodes
      .filter((node): node is GraphInputNode => node.type === 'graphInput')
      .map((node) => [node.data.id, node]),
  );
  return Object.fromEntries(
    Object.entries(inputs).map(([inputId, value]) => {
      const graphInput = inputsById.get(inputId);
      if (!graphInput) {
        throw new Error(`Evaluation provided unknown graph input "${inputId}".`);
      }
      return [inputId, { type: graphInput.data.dataType, value }];
    }),
  ) as GraphOutputs;
}

function createEvaluationRecordingReference(): EvaluationRecordingReference {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `evaluation-recording-${id}`,
    retention: 'temporary',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Yield to the macrotask queue so the browser can repaint.
 *
 * In browser execution mode, GraphProcessor runs in the same thread.  Emittery
 * defers all listeners to microtasks (`await resolvedPromise`), and PQueue
 * chains node processing as further microtasks.  React 18 batches state updates
 * and only commits + paints at macrotask boundaries, so intermediate states
 * (e.g. "running" indicators) are invisible without explicit yields.
 *
 * In contrast, Node execution mode delivers events as separate WebSocket
 * messages (macrotasks), giving the browser natural repaint opportunities.
 *
 * `MessageChannel` posts a macrotask with near-zero latency (unlike
 * `setTimeout(0)` which has a >=4 ms minimum).  By returning a Promise that
 * resolves on the next macrotask, any `await yieldToMacrotask()` inside an
 * Emittery listener pauses the GraphProcessor (which `await`s the `emit()`
 * call), lets React flush and the browser repaint, then resumes processing.
 */
function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });
}

export function useLocalExecutor() {
  const audioProvider = useAudioProvider();
  const dataRefs = useDataRefs();
  const datasetProvider = useDatasetProvider();
  const environmentProvider = useEnvironmentProvider();
  const evaluationRunStore = useEvaluationRunStore();
  const llmProfileHealthStore = useLLMProfileHealthStore();
  const localExecutionRecordingPersistence = useLocalExecutionRecordingPersistence();
  const pathPolicy = usePathPolicyProvider();
  const projectNodeRegistry = useProjectNodeRegistry();
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const store = useStore();
  const currentProcessorsByProjectId = useRef(new Map<ProjectId, GraphProcessor>());
  const evaluationAbortControllersByProjectId = useRef(new Map<ProjectId, AbortController>());
  const saveGraph = useSaveCurrentGraph();
  const currentExecution = useCurrentExecution();
  const eventDispatcher = createProcessEventDispatcher(currentExecution);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const savedSettings = useAtomValue(settingsState);
  const loadedRecording = getLoadedRecordingForProject(useAtomValue(loadedRecordingState), project.metadata.id);
  const recordingPlaybackStarting = useAtomValue(recordingPlaybackStartingState);
  const setRecordingPlaybackStarting = useSetAtom(recordingPlaybackStartingState);
  const setLastRecordingState = useSetAtom(lastRecordingState);
  const [evaluations, setEvaluationsState] = useAtom(evaluationsState);
  const recordExecutions = useAtomValue(recordExecutionsState);
  const showNodeRunDurations = useAtomValue(showNodeRunDurationsState);
  const projectData = useAtomValue(projectDataState);
  const projectContext = useAtomValue(projectContextState(project.metadata.id));
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const frozenNodeOutputs = useAtomValue(frozenNodeOutputsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const openedProjects = useAtomValue(projectsState).openedProjects;
  const pluginStates = useAtomValue(pluginsState);
  const editorExecutionCachesByProjectId = useRef(new Map<string, Map<string, unknown>>());
  const recordingPlaybackStartingRef = useRef(recordingPlaybackStarting);
  recordingPlaybackStartingRef.current = recordingPlaybackStarting;

  useEffect(() => {
    const openProjectIds = new Set(Object.keys(openedProjects));

    for (const [projectId, processor] of currentProcessorsByProjectId.current) {
      if (openProjectIds.has(projectId)) {
        continue;
      }

      processor.abort();
      currentProcessorsByProjectId.current.delete(projectId);
      evaluationAbortControllersByProjectId.current
        .get(projectId)
        ?.abort(new DOMException('Project closed.', 'AbortError'));
      evaluationAbortControllersByProjectId.current.delete(projectId);
      editorExecutionCachesByProjectId.current.delete(projectId);
    }
  }, [openedProjects]);

  // Evaluation workspace state is scoped to the active project. Unlike
  // ordinary graph runs, it does not keep a separate live-state snapshot for
  // every open tab, so a project switch must not let an old evaluation keep
  // publishing progress into the newly selected project's workspace.
  useEffect(() => {
    for (const [projectId, controller] of evaluationAbortControllersByProjectId.current) {
      if (projectId === project.metadata.id) continue;
      controller.abort(new DOMException('Active project changed.', 'AbortError'));
    }
  }, [project.metadata.id]);

  function getEditorExecutionCache(projectId: string) {
    let cache = editorExecutionCachesByProjectId.current.get(projectId);

    if (!cache) {
      cache = new Map<string, unknown>();
      editorExecutionCachesByProjectId.current.set(projectId, cache);
    }

    return cache;
  }

  function routeLocalProcessEvent<K extends keyof ProcessEventMessageMap>(
    runProjectId: ProjectId,
    message: K,
    data: ProcessEventMessageMap[K],
    dispatchActive: () => void,
  ) {
    const activeProjectId = store.get(projectState).metadata.id as ProjectId | undefined;
    const openedProjectsState = store.get(projectsState).openedProjects;

    if (activeProjectId === runProjectId) {
      dispatchActive();
      return;
    }

    if (
      !shouldRouteProjectEventToSnapshot({
        activeProjectId,
        isProjectOpen: Boolean(openedProjectsState[runProjectId]),
        projectId: runProjectId,
      })
    ) {
      return;
    }

    store.set(projectExecutionSnapshotsState, (previousSnapshots) =>
      applyProcessEventToProjectExecutionSnapshots({
        data,
        message,
        projectId: runProjectId,
        refStore: dataRefs,
        snapshots: previousSnapshots,
      }),
    );
  }

  function setLastRecordingForProject(runProjectId: ProjectId, recording: string) {
    if (store.get(projectState).metadata.id === runProjectId) {
      setLastRecordingState(recording);
      return;
    }

    if (!store.get(projectsState).openedProjects[runProjectId]) {
      return;
    }

    store.set(projectExecutionSnapshotsState, (previousSnapshots) => ({
      ...previousSnapshots,
      [runProjectId]: {
        ...(previousSnapshots[runProjectId] ?? createEmptyProjectExecutionSnapshot()),
        lastRecording: recording,
      },
    }));
  }

  function markInactiveLocalRunFailed(runProjectId: ProjectId, error: unknown) {
    if (store.get(projectState).metadata.id === runProjectId) {
      return;
    }

    routeLocalProcessEvent(
      runProjectId,
      'error',
      {
        error: error instanceof Error ? error : String(error),
      },
      () => {},
    );
  }

  function attachGraphEvents(processor: GraphProcessor, runProjectId: ProjectId) {
    // nodeStart and nodeFinish use awaited emit in GraphProcessor, so returning
    // a Promise here pauses the processor until the macrotask yield completes,
    // giving the browser a chance to repaint with updated React state.
    processor.on('nodeStart', async (data: ProcessEvents['nodeStart']) => {
      routeLocalProcessEvent(runProjectId, 'nodeStart', data, () => eventDispatcher.nodeStart(data));
      await yieldToMacrotask();
    });
    processor.on('nodeFinish', async (data: ProcessEvents['nodeFinish']) => {
      routeLocalProcessEvent(runProjectId, 'nodeFinish', data, () => eventDispatcher.nodeFinish(data));
      await yieldToMacrotask();
    });
    processor.on('nodeError', (data) => {
      routeLocalProcessEvent(runProjectId, 'nodeError', data, () => eventDispatcher.nodeError(data));
    });

    processor.on('userInput', (data) => {
      routeLocalProcessEvent(runProjectId, 'userInput', data, () => eventDispatcher.userInput(data));
    });
    // start and graphStart are already awaited by GraphProcessor, so yielding
    // here also creates a macrotask boundary before node processing begins.
    processor.on('start', async (data: ProcessEvents['start']) => {
      routeLocalProcessEvent(runProjectId, 'start', data, () => eventDispatcher.start(data));
      await yieldToMacrotask();
    });
    processor.on('done', (data) => {
      routeLocalProcessEvent(runProjectId, 'done', data, () => eventDispatcher.done(data));
    });
    processor.on('abort', (data) => {
      routeLocalProcessEvent(runProjectId, 'abort', data, () => eventDispatcher.abort(data));
    });
    processor.on('graphAbort', (data) => {
      routeLocalProcessEvent(runProjectId, 'graphAbort', data, () => eventDispatcher.graphAbort(data));
    });
    processor.on('graphError', (data) => {
      routeLocalProcessEvent(runProjectId, 'graphError', data, () => eventDispatcher.graphError(data));
    });
    processor.on('partialOutput', (data) => {
      routeLocalProcessEvent(runProjectId, 'partialOutput', data, () => eventDispatcher.partialOutput(data));
    });
    processor.on('progress', (data) => {
      routeLocalProcessEvent(runProjectId, 'progress', data, () => eventDispatcher.progress(data));
    });
    processor.on('llmCallFinished', (data) => {
      routeLocalProcessEvent(runProjectId, 'llmCallFinished', data, () => eventDispatcher.llmCallFinished(data));
    });
    processor.on('llmChatOutputSnapshot', (data) => {
      routeLocalProcessEvent(runProjectId, 'llmChatOutputSnapshot', data, () =>
        eventDispatcher.llmChatOutputSnapshot(data),
      );
    });
    processor.on('llmProfileAttempt', (data) => {
      routeLocalProcessEvent(runProjectId, 'llmProfileAttempt', data, () => eventDispatcher.llmProfileAttempt(data));
    });
    processor.on('toolCallFinished', (data) => {
      routeLocalProcessEvent(runProjectId, 'toolCallFinished', data, () => eventDispatcher.toolCallFinished(data));
    });
    processor.on('graphStart', async (data: ProcessEvents['graphStart']) => {
      routeLocalProcessEvent(runProjectId, 'graphStart', data, () => eventDispatcher.graphStart(data));
      await yieldToMacrotask();
    });
    processor.on('graphFinish', (data) => {
      routeLocalProcessEvent(runProjectId, 'graphFinish', data, () => eventDispatcher.graphFinish(data));
    });
    processor.on('graphOutputsReady', (data) => {
      routeLocalProcessEvent(runProjectId, 'graphOutputsReady', data, () => eventDispatcher.graphOutputsReady(data));
    });
    processor.on('nodeOutputsCleared', (data) => {
      routeLocalProcessEvent(runProjectId, 'nodeOutputsCleared', data, () => eventDispatcher.nodeOutputsCleared(data));
    });
    processor.on('trace', (trace) => logRuntimeDebug('Local graph trace', { trace }));
    processor.on('pause', (data) => {
      routeLocalProcessEvent(runProjectId, 'pause', data, () => eventDispatcher.pause(data));
    });
    processor.on('resume', (data) => {
      routeLocalProcessEvent(runProjectId, 'resume', data, () => eventDispatcher.resume(data));
    });
    processor.on('error', (data) => {
      routeLocalProcessEvent(runProjectId, 'error', data, () => eventDispatcher.error(data));
    });
    processor.on('nodeExcluded', (data) => {
      routeLocalProcessEvent(runProjectId, 'nodeExcluded', data, () => eventDispatcher.nodeExcluded(data));
    });

    processor.onUserEvent('toast', (data: DataValue | undefined) => {
      if (store.get(projectState).metadata.id !== runProjectId) {
        return;
      }

      const stringData = coerceTypeOptional(data, 'string');
      toast(stringData ?? 'Toast called, but no message was provided');
    });

    currentProcessorsByProjectId.current.set(runProjectId, processor);
  }

  /**
   * An evaluation owns many concurrent processors, so routing their events
   * through the regular editor data-flow handlers would let one finished trial
   * clear the canvas state for another. Run Activity is intentionally an
   * observer and already keys every event by root/graph run identity, so feed
   * it the complete stream directly.
   */
  function attachEvaluationRunActivity(processor: GraphProcessor) {
    processor.on('start', (data) => currentExecution.onRunActivityEvent('start', data));
    processor.on('done', (data) => currentExecution.onRunActivityEvent('done', data));
    processor.on('abort', (data) => currentExecution.onRunActivityEvent('abort', data));
    processor.on('error', (data) => currentExecution.onRunActivityEvent('error', data));
    processor.on('graphStart', (data) => currentExecution.onRunActivityEvent('graphStart', data));
    processor.on('graphFinish', (data) => currentExecution.onRunActivityEvent('graphFinish', data));
    processor.on('graphError', (data) => currentExecution.onRunActivityEvent('graphError', data));
    processor.on('graphAbort', (data) => currentExecution.onRunActivityEvent('graphAbort', data));
    processor.on('graphOutputsReady', (data) => currentExecution.onRunActivityEvent('graphOutputsReady', data));
    processor.on('nodeStart', (data) => currentExecution.onRunActivityEvent('nodeStart', data));
    processor.on('nodeFinish', (data) => currentExecution.onRunActivityEvent('nodeFinish', data));
    processor.on('nodeError', (data) => currentExecution.onRunActivityEvent('nodeError', data));
    processor.on('nodeExcluded', (data) => currentExecution.onRunActivityEvent('nodeExcluded', data));
    processor.on('nodeOutputsCleared', (data) => currentExecution.onRunActivityEvent('nodeOutputsCleared', data));
    processor.on('partialOutput', (data) => currentExecution.onRunActivityEvent('partialOutput', data));
    processor.on('progress', (data) => currentExecution.onRunActivityEvent('progress', data));
    processor.on('llmCallFinished', (data) => currentExecution.onRunActivityEvent('llmCallFinished', data));
    processor.on('llmProfileAttempt', (data) => currentExecution.onRunActivityEvent('llmProfileAttempt', data));
    processor.on('toolCallFinished', (data) => currentExecution.onRunActivityEvent('toolCallFinished', data));
  }

  const tryRunGraph = useStableCallback(async (options: EditorGraphRunOptions = {}) => {
    const recordingToReplay = loadedRecording;
    const runProjectId = project.metadata.id;

    if (!runProjectId) {
      return;
    }

    options.abortSignal?.throwIfAborted();

    if (
      currentProcessorsByProjectId.current.get(runProjectId)?.isRunning ||
      (recordingToReplay && recordingPlaybackStartingRef.current)
    ) {
      if (options.throwOnError) {
        throw new Error('A graph is already running for this project.');
      }
      return undefined;
    }

    if (recordingToReplay && options.requireLiveRun) {
      if (options.throwOnError) {
        throw new Error('Web app actions cannot run while a recording is loaded.');
      }
      return undefined;
    }

    if (recordingToReplay) {
      recordingPlaybackStartingRef.current = true;
      setRecordingPlaybackStarting(true);
    }

    let processor: GraphProcessor | undefined;
    let responseTraceCollector: AgentResponseTraceCollector | undefined;
    let finalizeCapturedRecording: (() => Promise<void>) | undefined;
    let localRecordingStatus: 'succeeded' | 'failed' | 'suspicious' = 'succeeded';
    let localRecordingErrorMessage: string | undefined;
    const handleAbort = () => {
      void processor?.abort();
    };

    try {
      if (recordingToReplay) {
        await yieldToMacrotask();
        options.abortSignal?.throwIfAborted();

        // The user can close this tab during the repaint yield. Its recording
        // is released synchronously on close, so do not construct a hidden
        // playback processor from a stale captured selection.
        if (!isCurrentLoadedRecordingForProject(store.get(loadedRecordingState), recordingToReplay, runProjectId)) {
          return undefined;
        }
      }

      const savedGraph = saveGraph() ?? graph;

      const graphToRun = options.graphId ?? graph.metadata!.id!;

      const tempProject = withDerivedProjectPluginSpecs(
        {
          ...project,
          // Include the just-saved version of the currently selected graph, because saveGraph won't update the `project` until next render
          graphs: {
            ...project.graphs,
            [savedGraph.metadata!.id!]: savedGraph,
          },
          data: projectData,
        },
        {
          appPluginStates: pluginStates,
          currentGraph: savedGraph,
          registry: projectNodeRegistry,
        },
      );

      const localRecordingProjectPath =
        recordExecutions && !recordingToReplay && loadedProject.path && localExecutionRecordingPersistence
          ? loadedProject.path
          : undefined;
      const localRecordingProvider =
        localRecordingProjectPath &&
        localExecutionRecordingPersistence &&
        (await localExecutionRecordingPersistence.getCapability().catch(() => false))
          ? localExecutionRecordingPersistence
          : undefined;
      const localRecordingCorrelationId = localRecordingProvider
        ? `rvt-local-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
        : undefined;
      let hasUnhealthyLLMProfileHealthEvidence = false;
      const localRecordingStartedAt = performance.now();

      const recorder = new ExecutionRecorder();
      processor = new GraphProcessor(tempProject, graphToRun, projectNodeRegistry, true, {
        captureNodeTimings: showNodeRunDurations,
      });
      responseTraceCollector = options.onResponseTrace ? new AgentResponseTraceCollector(processor) : undefined;
      for (const [name, externalFunction] of Object.entries(options.externalFunctions ?? {})) {
        processor.setExternalFunction(name, externalFunction);
      }
      processor.setStoredValueStore(options.storedValueStore);
      processor.setKnowledgeStores(options.knowledgeStores);
      if (options.onProgress) {
        processor.on('progress', ({ progress }) => options.onProgress?.(progress));
      }
      options.abortSignal?.addEventListener('abort', handleAbort, { once: true });
      options.abortSignal?.throwIfAborted();
      processor.executor = 'browser';
      processor.recordingPlaybackChatLatency = savedSettings.recordingPlaybackLatency ?? 1000;

      if (options.from) {
        const runFromPlan = getEditorRunFromPlan(tempProject, graphToRun, options.from, projectNodeRegistry);
        processor.runToNodeIds = runFromPlan.runToNodeIds;
        const preloadData = getDependentDataForNodeForPreload(
          runFromPlan.preloadNodeIds,
          lastRunData,
          loadedRecording ? undefined : { frozenNodeOutputs, graphId: graphToRun },
        );
        for (const [nodeId, outputs] of Object.entries(preloadData)) {
          processor.preloadNodeData(nodeId as NodeId, outputs);
        }
        currentExecution.preserveNodeRunDataForNextStart(runFromPlan.preserveNodeIds);
        currentExecution.suppressPreloadedNodeEventsForCurrentRun(runFromPlan.preloadNodeIds);
      } else if (options.to) {
        const runToPlan = getEditorRunToPlan(
          tempProject,
          graphToRun,
          options.to,
          projectNodeRegistry,
          loadedRecording ? undefined : { frozenNodeOutputs },
        );
        processor.runToNodeIds = runToPlan.runToNodeIds;
        currentExecution.preserveNodeRunDataForNextStart(runToPlan.preserveNodeIds);
      }

      if (recordExecutions) {
        recorder.record(processor);
      }

      processor.on('llmProfileAttempt', (event) => {
        if (event.stage === 'health-update' && event.outcome === 'success' && event.healthOutcome === 'unhealthy') {
          hasUnhealthyLLMProfileHealthEvidence = true;
        }
      });
      processor.on('error', (event) => {
        localRecordingStatus = 'failed';
        localRecordingErrorMessage = event.error instanceof Error ? event.error.message : event.error;
      });
      processor.on('abort', (event) => {
        if (event.successful || localRecordingStatus !== 'succeeded') return;
        localRecordingStatus = 'suspicious';
        localRecordingErrorMessage ??= event.error instanceof Error ? event.error.message : event.error;
      });
      finalizeCapturedRecording = async () => {
        if (!recordExecutions) return;

        const recordingSerialized = recorder.serialize();
        setLastRecordingForProject(runProjectId, recordingSerialized);
        if (
          !hasUnhealthyLLMProfileHealthEvidence ||
          !localRecordingProvider ||
          !localRecordingCorrelationId ||
          !localRecordingProjectPath
        ) {
          return;
        }

        try {
          const datasetsContents = serializeDatasets(await datasetProvider.exportDatasetsForProject(runProjectId));
          await localRecordingProvider.persist({
            projectId: runProjectId,
            projectPath: localRecordingProjectPath,
            projectContents: serializeProject(tempProject) as string,
            datasetsContents,
            recordingSerialized,
            status: localRecordingStatus,
            durationMs: Math.max(0, performance.now() - localRecordingStartedAt),
            errorMessage: localRecordingErrorMessage,
            executionIdentity: {
              correlationId: localRecordingCorrelationId,
              graphId: graphToRun,
            },
          });
        } catch (error) {
          await localRecordingProvider.markUnavailable(localRecordingCorrelationId).catch((outcomeError) => {
            logRuntimeDebug('Local LLM-profile replay could not report a failed local recording.', {
              error: outcomeError,
              graphId: graphToRun,
              projectId: runProjectId,
            });
          });
          logRuntimeDebug('Local LLM-profile replay was not retained by the hosted server.', {
            error,
            graphId: graphToRun,
            projectId: runProjectId,
          });
        }
      };

      attachGraphEvents(processor, runProjectId);

      let results: GraphOutputs;

      if (recordingToReplay) {
        results = await processor.replayRecording(recordingToReplay.recorder);
      } else {
        processor.setFrozenNodeOutputResolver(
          createFrozenNodeOutputResolver(cloneFrozenNodeOutputsForExecutor(frozenNodeOutputs)),
        );
        const contextValues = getProjectContextValues(projectContext);

        results = await processor.processGraph(
          {
            settings: await fillMissingSettingsFromEnvironmentVariables(
              savedSettings,
              projectNodeRegistry.getPlugins(),
              {
                environmentProvider,
                extraEnvVarNames: getLLMChatV2ApiKeyEnvVarNames(tempProject),
              },
            ),
            nativeApi: new TauriNativeApi(),
            datasetProvider,
            audioProvider,
            tokenizer: new GptTokenizerTokenizer(),
            projectPath: loadedProject.path ?? undefined,
            projectReferenceLoader: new TauriProjectReferenceLoader(pathPolicy),
            editorExecutionCache: getEditorExecutionCache(tempProject.metadata.id),
            llmProfileHealthStore,
            ...(localRecordingCorrelationId == null
              ? {}
              : { llmProfileHealthExecutionCorrelationId: localRecordingCorrelationId }),
          },
          options.inputs ?? {},
          contextValues,
          { returnWhenGraphOutputsReady: options.returnWhenGraphOutputsReady },
        );
      }

      const responseTrace = responseTraceCollector?.build();
      if (responseTrace) options.onResponseTrace?.(responseTrace);
      return results;
    } catch (e) {
      localRecordingStatus = 'failed';
      localRecordingErrorMessage = e instanceof Error ? e.message : String(e);
      const runProjectIsActive = store.get(projectState).metadata.id === runProjectId;
      if (runProjectIsActive) {
        currentExecution.clearNodeRunDataPreservationForNextStart();
      } else {
        markInactiveLocalRunFailed(runProjectId, e);
      }
      if (options.from) {
        if (options.throwOnError) {
          logRuntimeError('Local run from here failed.', e);
          throw e;
        } else if (runProjectIsActive) {
          handleError(e, 'Failed to start local run from here');
        } else {
          logRuntimeError('Inactive local run from here failed.', e);
        }
        return undefined;
      }

      logRuntimeError('Local graph run failed.', e);
      if (options.throwOnError) {
        throw e;
      }
      return undefined;
    } finally {
      const cleanupProcessorRun = () => {
        responseTraceCollector?.dispose();
        options.abortSignal?.removeEventListener('abort', handleAbort);

        if (processor && runProjectId && store.get(projectState).metadata.id === runProjectId) {
          dispatchGraphExecutionEvent('stop', () => currentExecution.onStop());
        }

        if (processor && runProjectId && currentProcessorsByProjectId.current.get(runProjectId) === processor) {
          currentProcessorsByProjectId.current.delete(runProjectId);
        }
      };

      const completion = processor?.isRunning
        ? processor.waitForRunCompletion().catch(() => undefined)
        : Promise.resolve();
      void completion.finally(cleanupProcessorRun);
      if (finalizeCapturedRecording) {
        void completion.then(() => finalizeCapturedRecording!()).catch(() => undefined);
      }

      if (recordingToReplay) {
        // A closed owner can be replaced by another tab's recording while this
        // stale invocation settles. Only the still-selected recording may
        // clear the shared short pre-start flag.
        if (isCurrentLoadedRecordingForProject(store.get(loadedRecordingState), recordingToReplay, runProjectId)) {
          recordingPlaybackStartingRef.current = false;
          setRecordingPlaybackStarting(false);
        }
      }
    }
  });

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
      if (!suite || !dataset) {
        throw new Error('The selected evaluation suite or its dataset no longer exists.');
      }

      const evaluationBaseProject = projectOverride ?? project;
      // A suite can target any graph, not just the canvas graph that happened
      // to be open when the user pressed Run. Derive plugin requirements from
      // the suite target so the execution project and the runner agree.
      const evaluationGraph = evaluationBaseProject.graphs[suite.targetGraphId];
      if (!evaluationGraph) {
        throw new Error(`Evaluation target graph "${suite.targetGraphId}" no longer exists.`);
      }
      const projectForEvaluation = withDerivedProjectPluginSpecs(evaluationBaseProject, {
        appPluginStates: pluginStates,
        currentGraph: evaluationGraph,
        registry: projectNodeRegistry,
      });
      const runProjectId = projectForEvaluation.metadata.id;
      if (!runProjectId) throw new Error('Cannot run an evaluation without a project id.');

      if (evaluationAbortControllersByProjectId.current.has(runProjectId)) {
        throw new Error('An evaluation is already running for this project.');
      }

      // Register before the first asynchronous preparation step. Project
      // switching must be able to cancel snapshotting/upload work too, rather
      // than only the graph runs that start afterwards.
      const evaluationAbortController = new AbortController();
      evaluationAbortControllersByProjectId.current.set(runProjectId, evaluationAbortController);
      const isActiveEvaluationProject = () => store.get(projectState).metadata.id === runProjectId;
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
        ensureActiveEvaluationProject();
        const runKind = purpose === 'evaluation' ? 'evaluation' : 'execution benchmark';
        runningToastId = toast.info(`Running ${runKind}: ${suite.name}`);
        logRuntimeInfo(`Running local ${runKind}`, { suiteId, suiteName: suite.name });
        currentExecution.onEvaluationStart();
        updateActiveProjectEvaluationState((state) => ({ ...state, runningSuiteId: suiteId, currentRun: undefined }));
        let recordingPersistenceFailureCount = 0;
        const finalizedRun = await executeEvaluationRunLifecycle({
          project: projectForEvaluation,
          projectId: runProjectId,
          evaluationData: evaluations.data,
          dataset,
          suite,
          purpose,
          executionMode: 'browser',
          signal: evaluationAbortController.signal,
          runStore: evaluationRunStore,
          assertActive: ensureActiveEvaluationProject,
          getExistingRun: (runId) => {
            const state = store.get(evaluationsState);
            return state.currentRun?.id === runId
              ? state.currentRun
              : state.runs.find((candidate) => candidate.id === runId);
          },
          getRecordingPersistenceFailureCount: () => recordingPersistenceFailureCount,
          onStorageFault: (kind, error) => {
            logRuntimeDebug(`Evaluation ${kind} persistence failed.`, {
              error,
              suiteId,
              projectId: runProjectId,
            });
          },
          onEvent: (event) => {
            // The terminal runner snapshot is selected immediately. Recording
            // retention and durable persistence continue afterward without a
            // brief fallback to the previously selected history run.
            updateActiveProjectEvaluationState((state) => applyEvaluationRunEvent(state, event));
          },
          runGraph: async ({ project: evaluationProject, graphId, inputs, signal, metadata }) => {
            const startedAt = Date.now();
            const metrics: EvaluationExecutionMetrics = {
              durationMs: 0,
              modelCallCount: 0,
              toolCallCount: 0,
              toolFailureCount: 0,
            };
            const providerAttempts: PortableJson[] = [];
            const processor = new GraphProcessor(evaluationProject, graphId, projectNodeRegistry, true, {
              captureNodeTimings: showNodeRunDurations,
            });
            const recorder = new ExecutionRecorder();
            const recording = createEvaluationRecordingReference();
            processor.executor = 'browser';
            recorder.record(processor);
            attachEvaluationRunActivity(processor);
            processor.on('llmCallFinished', (event) => {
              metrics.modelCallCount = (metrics.modelCallCount ?? 0) + 1;
              metrics.inputTokens = (metrics.inputTokens ?? 0) + (event.normalizedUsage?.promptTokens ?? 0);
              metrics.outputTokens = (metrics.outputTokens ?? 0) + (event.normalizedUsage?.completionTokens ?? 0);
              metrics.cachedInputTokens = (metrics.cachedInputTokens ?? 0) + (event.normalizedUsage?.cachedTokens ?? 0);
              metrics.reasoningTokens = (metrics.reasoningTokens ?? 0) + (event.normalizedUsage?.reasoningTokens ?? 0);
              if (event.pricing.status === 'known')
                metrics.costUsd = (metrics.costUsd ?? 0) + (event.pricing.costUsd ?? 0);
              else metrics.hasUnknownCost = true;
              providerAttempts.push({
                kind: 'provider-call',
                provider: event.provider,
                model: event.model,
                customProviderApi: event.customProviderApi ?? null,
                outcome: event.outcome,
                finishReason: event.finishReason ?? null,
                profileIndex: event.profileIndex ?? null,
                profileName: event.profileName ?? null,
                attemptIndex: event.attemptIndex,
                roundIndex: event.roundIndex ?? null,
                durationMs: event.durationMs ?? null,
              });
            });
            processor.on('llmProfileAttempt', (event) => {
              providerAttempts.push({
                kind: 'profile-decision',
                provider: event.provider,
                model: event.model,
                customProviderApi: event.customProviderApi ?? null,
                stage: event.stage,
                outcome: event.outcome,
                profileIndex: event.profileIndex ?? null,
                profileName: event.profileName ?? null,
                attemptIndex: event.attemptIndex ?? null,
                roundIndex: event.roundIndex,
                status: event.status ?? null,
                healthState: event.healthState ?? null,
                healthDisposition: event.healthDisposition ?? null,
                timeoutKind: event.timeoutKind ?? null,
              });
            });
            processor.on('toolCallFinished', (event) => {
              metrics.toolCallCount = (metrics.toolCallCount ?? 0) + 1;
              if (event.outcome !== 'success') metrics.toolFailureCount = (metrics.toolFailureCount ?? 0) + 1;
            });
            const abort = () => {
              void processor.abort();
            };
            signal?.addEventListener('abort', abort, { once: true });
            const persistRecording = async (): Promise<EvaluationRecordingReference | undefined> => {
              if (recorder.events.length === 0) return undefined;
              try {
                await evaluationRunStore.putRecording({
                  projectId: runProjectId,
                  runId: metadata.evaluationRunId,
                  trialId: `${metadata.caseId}:${metadata.trialIndex}`,
                  reference: recording,
                  serialized: recorder.serialize(),
                  createdAt: new Date().toISOString(),
                });
                return recording;
              } catch (error) {
                // A failed artifact write must not turn a valid model verdict
                // into a broken evaluation. The compact run remains usable.
                recordingPersistenceFailureCount += 1;
                logRuntimeDebug('Evaluation recording was not retained.', {
                  error,
                  graphId,
                  evaluationRunId: metadata.evaluationRunId,
                });
                return undefined;
              }
            };
            try {
              const outputs = await processor.processGraph(
                {
                  settings: await fillMissingSettingsFromEnvironmentVariables(
                    savedSettings,
                    projectNodeRegistry.getPlugins(),
                    {
                      environmentProvider,
                      extraEnvVarNames: getLLMChatV2ApiKeyEnvVarNames(evaluationProject),
                    },
                  ),
                  nativeApi: new TauriNativeApi(),
                  datasetProvider,
                  audioProvider,
                  tokenizer: new GptTokenizerTokenizer(),
                  llmProfileHealthStore,
                  evaluation: metadata,
                },
                evaluationInputsToGraphOutputs(evaluationProject, graphId, inputs),
                getProjectContextValues(projectContext),
              );
              const portableOutputs = Object.fromEntries(
                Object.entries(outputs).map(([key, value]) => [key, value.value as PortableJson]),
              );
              metrics.durationMs = Date.now() - startedAt;
              const persistedRecording = await persistRecording();
              return {
                outputs: portableOutputs,
                metrics,
                ...(persistedRecording === undefined ? {} : { recording: persistedRecording }),
                ...(providerAttempts.length === 0 ? {} : { providerAttempts }),
              };
            } catch (error) {
              metrics.durationMs = Math.max(metrics.durationMs, Date.now() - startedAt);
              const persistedRecording = await persistRecording();
              if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
              throw new EvaluationGraphExecutionError(error instanceof Error ? error.message : String(error), {
                metrics,
                ...(persistedRecording === undefined ? {} : { recording: persistedRecording }),
                ...(providerAttempts.length === 0 ? {} : { providerAttempts }),
              });
            } finally {
              signal?.removeEventListener('abort', abort);
            }
          },
        });
        updateActiveProjectEvaluationState((state) => ({
          ...applyEvaluationRunSnapshot(state, finalizedRun),
          runningSuiteId: undefined,
        }));
        if (store.get(projectState).metadata.id === runProjectId) {
          toast.info(formatEvaluationCompletionToast(finalizedRun));
        }
        return finalizedRun;
      } catch (error) {
        updateActiveProjectEvaluationState((state) => ({ ...state, runningSuiteId: undefined }));
        if (!evaluationAbortController.signal.aborted && isActiveEvaluationProject()) {
          handleError(error, 'Failed to run evaluation');
        }
        return undefined;
      } finally {
        if (runningToastId !== undefined) toast.dismiss(runningToastId);
        if (evaluationAbortControllersByProjectId.current.get(runProjectId) === evaluationAbortController) {
          evaluationAbortControllersByProjectId.current.delete(runProjectId);
        }
      }
    },
  );

  function tryAbortGraph() {
    const evaluationAbortController = evaluationAbortControllersByProjectId.current.get(
      project.metadata.id as ProjectId,
    );
    if (evaluationAbortController) {
      evaluationAbortController.abort(new DOMException('Evaluation canceled.', 'AbortError'));
      return;
    }
    currentProcessorsByProjectId.current.get(project.metadata.id as ProjectId)?.abort();
  }

  function tryPauseGraph() {
    currentProcessorsByProjectId.current.get(project.metadata.id as ProjectId)?.pause();
  }

  function tryResumeGraph() {
    currentProcessorsByProjectId.current.get(project.metadata.id as ProjectId)?.resume();
  }

  const submitUserInput = useStableCallback((nodeId: NodeId, answers: StringArrayDataValue) => {
    const processor = currentProcessorsByProjectId.current.get(project.metadata.id as ProjectId);
    if (!processor?.isRunning) {
      logRuntimeDebug('Local user input skipped because no local processor is running.');
      return;
    }

    processor.userInput(nodeId, answers);
    setUserInputQuestions((q) =>
      produce(q, (draft) => {
        delete draft[nodeId];
      }),
    );
  });

  return {
    tryRunGraph,
    tryAbortGraph,
    tryPauseGraph,
    tryResumeGraph,
    tryRunEvaluation,
    submitUserInput,
  };
}
