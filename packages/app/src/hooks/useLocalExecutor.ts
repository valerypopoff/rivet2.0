import {
  GraphProcessor,
  type NodeId,
  type StringArrayDataValue,
  type DataValue,
  coerceTypeOptional,
  ExecutionRecorder,
  createFrozenNodeOutputResolver,
  type GraphOutputs,
  type GraphId,
  type ProcessEventMessageMap,
  type ProcessEvents,
  type ProjectId,
  GptTokenizerTokenizer,
  logRuntimeDebug,
  logRuntimeError,
  logRuntimeInfo,
} from '@valerypopoff/rivet2-core';
import { produce } from 'immer';
import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
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
import { lastRecordingState, loadedRecordingState, recordingPlaybackStartingState } from '../state/execution';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { getLLMChatV2CustomProviderApiKeyEnvVarNames } from '../utils/chatV2CustomProviderEnv';
import { trivetState } from '../state/trivet';
import { runTrivet } from '@valerypopoff/trivet';
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
  const pathPolicy = usePathPolicyProvider();
  const projectNodeRegistry = useProjectNodeRegistry();
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const store = useStore();
  const currentProcessorsByProjectId = useRef(new Map<ProjectId, GraphProcessor>());
  const saveGraph = useSaveCurrentGraph();
  const currentExecution = useCurrentExecution();
  const eventDispatcher = createProcessEventDispatcher(currentExecution);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const savedSettings = useAtomValue(settingsState);
  const loadedRecording = useAtomValue(loadedRecordingState);
  const recordingPlaybackStarting = useAtomValue(recordingPlaybackStartingState);
  const setRecordingPlaybackStarting = useSetAtom(recordingPlaybackStartingState);
  const setLastRecordingState = useSetAtom(lastRecordingState);
  const [{ testSuites }, setTrivetState] = useAtom(trivetState);
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
      editorExecutionCachesByProjectId.current.delete(projectId);
    }
  }, [openedProjects]);

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
    processor.on('graphStart', async (data: ProcessEvents['graphStart']) => {
      routeLocalProcessEvent(runProjectId, 'graphStart', data, () => eventDispatcher.graphStart(data));
      await yieldToMacrotask();
    });
    processor.on('graphFinish', (data) => {
      routeLocalProcessEvent(runProjectId, 'graphFinish', data, () => eventDispatcher.graphFinish(data));
    });
    processor.on('nodeOutputsCleared', (data) => {
      routeLocalProcessEvent(runProjectId, 'nodeOutputsCleared', data, () => eventDispatcher.nodeOutputsCleared(data));
    });
    processor.on('trace', (trace) => logRuntimeDebug('Local graph trace', { trace }));
    processor.on('pause', () => {
      routeLocalProcessEvent(runProjectId, 'pause', undefined, () => eventDispatcher.pause());
    });
    processor.on('resume', () => {
      routeLocalProcessEvent(runProjectId, 'resume', undefined, () => eventDispatcher.resume());
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
    const handleAbort = () => {
      void processor?.abort();
    };

    try {
      if (recordingToReplay) {
        await yieldToMacrotask();
        options.abortSignal?.throwIfAborted();
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

      const recorder = new ExecutionRecorder();
      processor = new GraphProcessor(tempProject, graphToRun, projectNodeRegistry, true, {
        captureNodeTimings: showNodeRunDurations,
      });
      for (const [name, externalFunction] of Object.entries(options.externalFunctions ?? {})) {
        processor.setExternalFunction(name, externalFunction);
      }
      processor.setStoredValueStore(options.storedValueStore);
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
                extraEnvVarNames: getLLMChatV2CustomProviderApiKeyEnvVarNames(tempProject),
              },
            ),
            nativeApi: new TauriNativeApi(),
            datasetProvider,
            audioProvider,
            tokenizer: new GptTokenizerTokenizer(),
            projectPath: loadedProject.path ?? undefined,
            projectReferenceLoader: new TauriProjectReferenceLoader(pathPolicy),
            editorExecutionCache: getEditorExecutionCache(tempProject.metadata.id),
          },
          options.inputs ?? {},
          contextValues,
          { returnWhenGraphOutputsReady: options.returnWhenGraphOutputsReady },
        );
      }

      if (recordExecutions) {
        if (processor.isRunning) {
          void processor
            .waitForRunCompletion()
            .then(() => setLastRecordingForProject(runProjectId, recorder.serialize()))
            .catch(() => undefined);
        } else {
          setLastRecordingForProject(runProjectId, recorder.serialize());
        }
      }

      return results;
    } catch (e) {
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
        options.abortSignal?.removeEventListener('abort', handleAbort);

        if (processor && runProjectId && store.get(projectState).metadata.id === runProjectId) {
          dispatchGraphExecutionEvent('stop', () => currentExecution.onStop());
        }

        if (processor && runProjectId && currentProcessorsByProjectId.current.get(runProjectId) === processor) {
          currentProcessorsByProjectId.current.delete(runProjectId);
        }
      };

      if (processor?.isRunning) {
        void processor
          .waitForRunCompletion()
          .catch(() => undefined)
          .finally(cleanupProcessorRun);
      } else {
        cleanupProcessorRun();
      }

      if (recordingToReplay) {
        recordingPlaybackStartingRef.current = false;
        setRecordingPlaybackStarting(false);
      }
    }
  });

  const tryRunTests = useStableCallback(
    async (options: { testSuiteIds?: string[]; testCaseIds?: string[]; iterationCount?: number } = {}) => {
      toast.info(
        (options.iterationCount ?? 1) > 1 ? `Running Tests (${options.iterationCount!} iterations)` : 'Running Tests',
      );
      logRuntimeInfo('Running local Trivet tests', {
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
      const testSuitesToRun = options.testSuiteIds
        ? testSuites
            .filter((t) => options.testSuiteIds!.includes(t.id))
            .map((t) => ({
              ...t,
              testCases: options.testCaseIds
                ? t.testCases.filter((tc) => options.testCaseIds?.includes(tc.id))
                : t.testCases,
            }))
        : testSuites;
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
            const runProjectId = project.metadata.id;
            if (!runProjectId) {
              throw new Error('Cannot run local Trivet graph without a project id.');
            }

            const processor = new GraphProcessor(project, graphId, projectNodeRegistry, true, {
              captureNodeTimings: showNodeRunDurations,
            });
            processor.executor = 'browser';
            attachGraphEvents(processor, runProjectId);
            const contextValues = getProjectContextValues(projectContext);
            try {
              return await processor.processGraph(
                {
                  settings: await fillMissingSettingsFromEnvironmentVariables(
                    savedSettings,
                    projectNodeRegistry.getPlugins(),
                    {
                      environmentProvider,
                      extraEnvVarNames: getLLMChatV2CustomProviderApiKeyEnvVarNames(project),
                    },
                  ),
                  nativeApi: new TauriNativeApi(),
                  datasetProvider,
                  audioProvider,
                  tokenizer: new GptTokenizerTokenizer(),
                },
                inputs,
                contextValues,
              );
            } finally {
              if (currentProcessorsByProjectId.current.get(runProjectId) === processor) {
                currentProcessorsByProjectId.current.delete(runProjectId);
              }
            }
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
        logRuntimeInfo('Finished local Trivet tests', {
          testSuiteCount: result.testSuiteResults.length,
          passingTestSuiteCount: result.testSuiteResults.filter((testSuite) => testSuite.passing).length,
          iterationCount: result.iterationCount,
        });
      } catch (e) {
        setTrivetState((s) => ({
          ...s,
          runningTests: false,
        }));
        handleError(e, 'Failed to run local tests');
      }
    },
  );

  function tryAbortGraph() {
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
    tryRunTests,
    submitUserInput,
  };
}
