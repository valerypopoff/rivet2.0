import { createContext, useContext, useEffect, useMemo, type FC, type ReactNode } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { type ProcessEventMessageMap, type ProjectId, type RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import {
  createExecutorSessionRuntime,
  type ExecutorSessionLifecycleEvent,
  type ExecutorSessionRuntime,
} from '../hooks/executorSession.js';
import { releaseRuntimeExecutorResources } from '../hooks/executorSessionRuntimeResources.js';
import { executorSessionRevisionState } from '../state/execution.js';
import { projectsState, projectState } from '../state/savedGraphs.js';
import { useDataRefs, useDatasetProvider, type AppDatasetProvider } from './ProvidersContext.js';
import { projectExecutionSnapshotsState } from '../state/dataFlow.js';
import {
  createUnscopedRemoteExecutionRoutingState,
  getRemoteExecutionEventDispatchDecision,
} from '../hooks/remoteExecutorRunRequest.js';
import { shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent } from '../hooks/remoteExecutorHelpers.js';
import {
  applyExecutorDisconnectToProjectExecutionSnapshots,
  applyProcessEventToProjectExecutionSnapshots,
  shouldRouteProjectEventToSnapshot,
} from '../hooks/projectExecutionSnapshotRouting.js';

const FALLBACK_EXECUTOR_SESSION_PROJECT_ID = '__rivet_fallback_project__' as ProjectId;

export type ExecutorSessionRegistry = {
  disconnectAll(): void;
  getRuntime(projectId?: ProjectId): ExecutorSessionRuntime;
  removeProject(projectId: ProjectId): void;
  setDatasetProvider(datasetProvider: AppDatasetProvider | null): void;
  subscribeDisconnectsForAllProjects(handler: ProjectExecutorDisconnectHandler): () => void;
  subscribeMessagesForAllProjects(handler: ProjectExecutorMessageHandler): () => void;
};

type ProjectExecutorMessageHandler = <K extends keyof ProcessEventMessageMap>(
  projectId: ProjectId,
  runtime: ExecutorSessionRuntime,
  message: K,
  data: ProcessEventMessageMap[K],
  requestId?: RemoteRunRequestId,
) => void;
type ProjectExecutorDisconnectHandler = (
  projectId: ProjectId,
  runtime: ExecutorSessionRuntime,
  event: Extract<ExecutorSessionLifecycleEvent, { type: 'disconnected' }>,
) => void;

const ExecutorSessionRuntimeContext = createContext<ExecutorSessionRegistry | null>(null);
const ExecutorSessionHostConfigContext = createContext<ExecutorSessionHostConfig | undefined>(undefined);

export type ExecutorSessionHostConfig = {
  /**
   * Hosted wrappers can provide the editor executor websocket URL here. When
   * set, Node executor mode connects to this URL instead of starting a Tauri
   * sidecar, so browser-hosted Rivet shells can use the same executor hooks as
   * the desktop app.
   */
  internalExecutorUrl?: string;
};

export function useExecutorSessionRegistry(): ExecutorSessionRegistry {
  const context = useContext(ExecutorSessionRuntimeContext);

  if (!context) {
    throw new Error('useExecutorSessionRegistry must be used within an ExecutorSessionProvider');
  }

  return context;
}

export function useExecutorSessionRuntime(projectId?: ProjectId): ExecutorSessionRuntime {
  const registry = useExecutorSessionRegistry();
  const activeProject = useAtomValue(projectState);

  return registry.getRuntime(projectId ?? activeProject.metadata.id ?? FALLBACK_EXECUTOR_SESSION_PROJECT_ID);
}

export function useExecutorSessionHostConfig(): ExecutorSessionHostConfig | undefined {
  return useContext(ExecutorSessionHostConfigContext);
}

export function createExecutorSessionRegistry(options: { onStateChange: () => void }): ExecutorSessionRegistry {
  const runtimes = new Map<ProjectId, ExecutorSessionRuntime>();
  const disconnectSubscribers = new Set<ProjectExecutorDisconnectHandler>();
  const messageSubscribers = new Set<ProjectExecutorMessageHandler>();
  let currentDatasetProvider: AppDatasetProvider | null = null;

  function createRuntime(projectId: ProjectId) {
    const runtime = createExecutorSessionRuntime({
      onStateChange: options.onStateChange,
    });
    runtime.setDatasetProvider(currentDatasetProvider);
    runtime.subscribeMessages((message, data, requestId) => {
      for (const subscriber of [...messageSubscribers]) {
        subscriber(projectId, runtime, message, data, requestId);
      }
    });
    runtime.subscribeLifecycle('disconnect', (event) => {
      for (const subscriber of [...disconnectSubscribers]) {
        subscriber(projectId, runtime, event as Extract<ExecutorSessionLifecycleEvent, { type: 'disconnected' }>);
      }
    });
    runtimes.set(projectId, runtime);
    return runtime;
  }

  return {
    disconnectAll() {
      for (const runtime of runtimes.values()) {
        releaseRuntimeExecutorResources(runtime);
      }
      runtimes.clear();
    },
    getRuntime(projectId = FALLBACK_EXECUTOR_SESSION_PROJECT_ID) {
      return runtimes.get(projectId) ?? createRuntime(projectId);
    },
    removeProject(projectId) {
      const runtime = runtimes.get(projectId);
      if (!runtime) {
        return;
      }

      releaseRuntimeExecutorResources(runtime);
      runtimes.delete(projectId);
    },
    setDatasetProvider(datasetProvider) {
      currentDatasetProvider = datasetProvider;
      for (const runtime of runtimes.values()) {
        runtime.setDatasetProvider(datasetProvider);
      }
    },
    subscribeDisconnectsForAllProjects(handler) {
      disconnectSubscribers.add(handler);
      return () => {
        disconnectSubscribers.delete(handler);
      };
    },
    subscribeMessagesForAllProjects(handler) {
      messageSubscribers.add(handler);
      return () => {
        messageSubscribers.delete(handler);
      };
    },
  };
}

export const ExecutorSessionProvider: FC<{ children: ReactNode; hostConfig?: ExecutorSessionHostConfig }> = ({
  children,
  hostConfig,
}) => {
  const datasetProvider = useDatasetProvider();
  const dataRefs = useDataRefs();
  const store = useStore();
  const bumpExecutorSessionRevision = useSetAtom(executorSessionRevisionState);

  const registry = useMemo(
    () =>
      createExecutorSessionRegistry({
        onStateChange: () => {
          bumpExecutorSessionRevision((revision) => revision + 1);
        },
      }),
    [bumpExecutorSessionRevision],
  );

  useEffect(() => {
    registry.setDatasetProvider(datasetProvider);

    return () => {
      registry.setDatasetProvider(null);
    };
  }, [datasetProvider, registry]);

  useEffect(() => {
    const routingStatesByProjectId = new Map<ProjectId, ReturnType<typeof createUnscopedRemoteExecutionRoutingState>>();
    const shouldRouteInactiveProjectEvent = (projectId: ProjectId) =>
      shouldRouteProjectEventToSnapshot({
        activeProjectId: store.get(projectState).metadata.id as ProjectId | undefined,
        isProjectOpen: Boolean(store.get(projectsState).openedProjects[projectId]),
        projectId,
      });

    const unsubscribeMessages = registry.subscribeMessagesForAllProjects((projectId, runtime, message, data, requestId) => {
      if (!shouldRouteInactiveProjectEvent(projectId)) {
        return;
      }

      const runtimeState = runtime.getRuntimeState();

      const routingState =
        routingStatesByProjectId.get(projectId) ?? createUnscopedRemoteExecutionRoutingState();
      routingStatesByProjectId.set(projectId, routingState);

      const dispatchDecision = getRemoteExecutionEventDispatchDecision({
        activeRequestId: runtime.getActiveGraphRunRequestId(),
        currentProjectId: projectId,
        data,
        message,
        requestId,
        unscopedRoutingState: routingState,
      });
      const shouldFlushFrozenOutputs = shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
        alreadyFlushed: false,
        message,
        shouldDispatchExecutionEvent: dispatchDecision.shouldDispatch,
        target: runtimeState.target,
      });

      const shouldSettlePendingRequest = requestId != null || dispatchDecision.shouldDispatch;
      if (shouldSettlePendingRequest) {
        if (message === 'done') {
          runtime.resolvePendingGraphExecution(requestId, (data as { results: unknown }).results as any);
        } else if (message === 'abort') {
          runtime.rejectPendingGraphExecution(requestId, new Error('graph execution aborted'));
        } else if (message === 'error') {
          runtime.rejectPendingGraphExecution(requestId, (data as { error: Error }).error);
        }
      }

      if (shouldSettlePendingRequest && (message === 'done' || message === 'abort' || message === 'error')) {
        if (requestId === runtime.getActiveGraphRunRequestId()) {
          runtime.setActiveGraphRunRequestId(null);
        }
      }

      if (!dispatchDecision.shouldDispatch) {
        return;
      }

      store.set(projectExecutionSnapshotsState, (previousSnapshots) =>
        applyProcessEventToProjectExecutionSnapshots({
          data,
          mapSnapshot: shouldFlushFrozenOutputs ? (snapshot) => ({ ...snapshot, frozenNodeOutputs: {} }) : undefined,
          message,
          projectId,
          refStore: dataRefs,
          snapshots: previousSnapshots,
        }),
      );
    });
    const unsubscribeDisconnects = registry.subscribeDisconnectsForAllProjects((projectId) => {
      if (!shouldRouteInactiveProjectEvent(projectId)) {
        return;
      }

      store.set(projectExecutionSnapshotsState, (previousSnapshots) =>
        applyExecutorDisconnectToProjectExecutionSnapshots({
          errorMessage: 'Executor session disconnected',
          projectId,
          refStore: dataRefs,
          snapshots: previousSnapshots,
        }),
      );
    });

    return () => {
      unsubscribeMessages();
      unsubscribeDisconnects();
    };
  }, [dataRefs, registry, store]);

  useEffect(() => {
    return () => {
      registry.disconnectAll();
    };
  }, [registry]);

  return (
    <ExecutorSessionHostConfigContext.Provider value={hostConfig}>
      <ExecutorSessionRuntimeContext.Provider value={registry}>{children}</ExecutorSessionRuntimeContext.Provider>
    </ExecutorSessionHostConfigContext.Provider>
  );
};
