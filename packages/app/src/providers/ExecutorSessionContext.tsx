import { createContext, useContext, useEffect, useMemo, useRef, type FC, type ReactNode } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useBundleExecutionRouting } from '../hooks/useBundleExecutionRouting.js';
import { useRemoteExecutionObservations } from '../hooks/useRemoteExecutionObservations.js';
import { type ProcessEventMessageMap, type ProjectId, type RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import {
  createExecutorSessionRuntime,
  type ExecutorSessionLifecycleEvent,
  type ExecutorSessionRuntime,
  type RemoteEventAdmission,
} from '../hooks/executorSession.js';
import { releaseRuntimeExecutorResources } from '../hooks/executorSessionRuntimeResources.js';
import { executorSessionRevisionState, getLoadedRecordingForTab, loadedRecordingState } from '../state/execution.js';
import { projectsState, projectState, openedProjectSnapshotsState } from '../state/savedGraphs.js';
import { getRemoteDebuggerBundleProjects } from '../hooks/remoteDebuggerBundle.js';
import { useDataRefs, useDatasetProvider, type AppDatasetProvider } from './ProvidersContext.js';
import { graphRunningState, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent } from '../hooks/remoteExecutorHelpers.js';
import {
  applyExecutorDisconnectToProjectExecutionSnapshots,
  applyProcessEventToProjectExecutionSnapshots,
  shouldRouteProjectEventToSnapshot,
} from '../hooks/projectExecutionSnapshotRouting.js';

const FALLBACK_EXECUTOR_SESSION_PROJECT_ID = '__rivet_fallback_project__' as ProjectId;

export type ExecutorSessionRegistry = {
  connectBundleDebugger(projectId: ProjectId, members: ProjectId[], url?: string): Promise<void>;
  getRemoteDebuggerRuntime(projectId: ProjectId): ExecutorSessionRuntime | undefined;
  isBundleDebuggerRuntime(runtime: ExecutorSessionRuntime): boolean;
  refreshDebuggerBundles(getMembers: (projectId: ProjectId) => ProjectId[]): void;
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
  admission?: RemoteEventAdmission,
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
  resolveInternalHostedExecutorUrl?: () => Promise<string>;
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
  useAtomValue(executorSessionRevisionState);

  const id = projectId ?? activeProject.metadata.id ?? FALLBACK_EXECUTOR_SESSION_PROJECT_ID;
  return registry.getRemoteDebuggerRuntime(id) ?? registry.getRuntime(id);
}

export function useExecutorSessionHostConfig(): ExecutorSessionHostConfig | undefined {
  return useContext(ExecutorSessionHostConfigContext);
}

export function createExecutorSessionRegistry(options: {
  onStateChange: () => void;
  resolveInternalHostedExecutorUrl?: () => Promise<string>;
}): ExecutorSessionRegistry {
  const runtimes = new Map<ProjectId, ExecutorSessionRuntime>();
  type DebuggerBundle = {
    members: Map<ProjectId, number>;
    sourceProjects: Set<ProjectId>;
    runtime: ExecutorSessionRuntime;
  };
  let nextMembership = 0;
  const debuggerBundles = new Map<ProjectId, DebuggerBundle>();
  const bundleRuntimes = new WeakSet<ExecutorSessionRuntime>();
  const disconnectSubscribers = new Set<ProjectExecutorDisconnectHandler>();
  const messageSubscribers = new Set<ProjectExecutorMessageHandler>();
  let currentDatasetProvider: AppDatasetProvider | null = null;

  function createRuntime(projectId: ProjectId, bundle?: DebuggerBundle) {
    const getProjectLifetime = bundle ? (id: ProjectId) => bundle.members.get(id)?.toString() : undefined;
    const runtime = createExecutorSessionRuntime({
      projectId,
      acceptsProject: bundle ? (id) => bundle.members.has(id) : undefined,
      getProjectLifetime,
      onStateChange: options.onStateChange,
      resolveInternalHostedExecutorUrl: options.resolveInternalHostedExecutorUrl,
    });
    runtime.setDatasetProvider(currentDatasetProvider);
    runtime.subscribeMessages((message, data, requestId, admission) => {
      if (
        bundle &&
        admission?.decision.shouldDispatch &&
        admission.sourceDisplayAllowed !== false &&
        admission.projectId
      )
        bundle.sourceProjects.add(admission.projectId);
      for (const subscriber of [...messageSubscribers]) {
        subscriber(projectId, runtime, message, data, requestId, admission);
      }
    });
    runtime.subscribeLifecycle('disconnect', (event) => {
      if (bundle && !event.target) return;
      const members = bundle ? [...bundle.members.keys()] : [projectId];
      if (bundle) {
        for (const id of members) if (debuggerBundles.get(id) === bundle) debuggerBundles.delete(id);
        options.onStateChange();
      }
      const sourceProjects = bundle ? [...bundle.sourceProjects] : [projectId];
      for (const subscriber of [...disconnectSubscribers]) {
        for (const id of sourceProjects.length ? sourceProjects : [FALLBACK_EXECUTOR_SESSION_PROJECT_ID])
          subscriber(id, runtime, event as Extract<ExecutorSessionLifecycleEvent, { type: 'disconnected' }>);
      }
    });
    if (!bundle) runtimes.set(projectId, runtime);
    return runtime;
  }

  return {
    async connectBundleDebugger(projectId, members, url) {
      const ids = new Set([projectId, ...members]);
      const existing = [...ids].map((id) => debuggerBundles.get(id)).find(Boolean);
      if (existing) {
        if ([...ids].some((id) => debuggerBundles.get(id) !== existing))
          throw new Error('A project already belongs to another Remote Debugger session. Stop it before reconnecting.');
        if (url && existing.runtime.getRuntimeState().url !== url)
          throw new Error('Stop the shared Remote Debugger before changing its address.');
        await existing.runtime.connectExternalDebugger(url);
        return;
      }
      for (const id of ids) {
        const own = runtimes.get(id);
        if (own?.getActiveGraphRunRequestId() || own?.getRuntimeState().target?.type === 'external-debugger')
          throw new Error('Stop the existing project execution or debugger before connecting the bundle.');
      }
      const bundle: DebuggerBundle = {
        members: new Map([...ids].map((id) => [id, ++nextMembership])),
        sourceProjects: new Set(),
        runtime: undefined!,
      };
      bundle.runtime = createRuntime(projectId, bundle);
      bundleRuntimes.add(bundle.runtime);
      for (const id of ids) debuggerBundles.set(id, bundle);
      try {
        await bundle.runtime.connectExternalDebugger(url);
      } catch (error) {
        bundle.runtime.disconnect();
        for (const id of ids) if (debuggerBundles.get(id) === bundle) debuggerBundles.delete(id);
        options.onStateChange();
        throw error;
      }
    },
    getRemoteDebuggerRuntime(projectId) {
      return debuggerBundles.get(projectId)?.runtime;
    },
    isBundleDebuggerRuntime(runtime) {
      return bundleRuntimes.has(runtime);
    },
    refreshDebuggerBundles(getMembers) {
      let changed = false;
      for (const bundle of new Set(debuggerBundles.values()))
        for (const id of [...bundle.members.keys()])
          for (const member of getMembers(id)) {
            if (bundle.members.has(member) || debuggerBundles.has(member)) continue;
            const own = runtimes.get(member);
            if (own?.getActiveGraphRunRequestId() || own?.getRuntimeState().target?.type === 'external-debugger')
              continue;
            bundle.members.set(member, ++nextMembership);
            debuggerBundles.set(member, bundle);
            changed = true;
          }
      if (changed) options.onStateChange();
    },
    disconnectAll() {
      for (const bundle of new Set(debuggerBundles.values())) bundle.runtime.disconnect();
      debuggerBundles.clear();
      for (const runtime of runtimes.values()) {
        releaseRuntimeExecutorResources(runtime);
      }
      runtimes.clear();
    },
    getRuntime(projectId = FALLBACK_EXECUTOR_SESSION_PROJECT_ID) {
      return runtimes.get(projectId) ?? createRuntime(projectId);
    },
    removeProject(projectId) {
      const bundle = debuggerBundles.get(projectId);
      if (bundle) {
        bundle.members.delete(projectId);
        bundle.sourceProjects.delete(projectId);
        debuggerBundles.delete(projectId);
        if (!bundle.members.size) bundle.runtime.disconnect();
        options.onStateChange();
      }
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
      for (const bundle of new Set(debuggerBundles.values())) bundle.runtime.setDatasetProvider(datasetProvider);
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
  const routeBundleExecution = useBundleExecutionRouting();
  const bumpExecutorSessionRevision = useSetAtom(executorSessionRevisionState);
  const hostConfigRef = useRef(hostConfig);
  hostConfigRef.current = hostConfig;

  const registry = useMemo(
    () =>
      createExecutorSessionRegistry({
        resolveInternalHostedExecutorUrl: async () => {
          const resolve = hostConfigRef.current?.resolveInternalHostedExecutorUrl;
          if (!resolve) throw new Error('Fresh hosted executor discovery is unavailable.');
          return resolve();
        },
        onStateChange: () => {
          bumpExecutorSessionRevision((revision) => revision + 1);
        },
      }),
    [bumpExecutorSessionRevision, store],
  );
  const observations = useRemoteExecutionObservations(registry);
  const opened = useAtomValue(projectsState).openedProjects;
  const snapshots = useAtomValue(openedProjectSnapshotsState);
  const activeProject = useAtomValue(projectState);
  useEffect(() => {
    const components = new Map<ProjectId, ProjectId[]>();
    registry.refreshDebuggerBundles((id) => {
      let members = components.get(id);
      if (!members) {
        members = getRemoteDebuggerBundleProjects(id, opened, snapshots, activeProject);
        for (const member of members) components.set(member, members);
      }
      return members.filter(
        (member) =>
          registry.getRemoteDebuggerRuntime(member) ||
          !(member === activeProject.metadata.id
            ? store.get(graphRunningState)
            : store.get(projectExecutionSnapshotsState)[member]?.graphRunning),
      );
    });
  }, [registry, opened, snapshots, activeProject, store]);

  useEffect(() => {
    registry.setDatasetProvider(datasetProvider);

    return () => {
      registry.setDatasetProvider(null);
    };
  }, [datasetProvider, registry]);

  useEffect(() => {
    const shouldRouteInactiveProjectEvent = (projectId: ProjectId) =>
      shouldRouteProjectEventToSnapshot({
        activeProjectId: store.get(projectState).metadata.id as ProjectId | undefined,
        isProjectOpen: Boolean(store.get(projectsState).openedProjects[projectId]),
        projectId,
      });

    const unsubscribeMessages = registry.subscribeMessagesForAllProjects(
      (projectId, runtime, message, data, requestId, admission) => {
        const runtimeState = runtime.getRuntimeState();

        if (!admission) return;
        projectId = admission.projectId ?? projectId;
        const dispatchDecision = admission.decision;
        if (runtimeState.target?.type === 'external-debugger')
          observations.receive(
            runtime,
            projectId,
            store.get(projectsState).openedProjects[projectId]?.title ?? 'Source project',
            message,
            data,
            dispatchDecision.shouldDispatch,
          );
        if (admission.sourceDisplayAllowed === false) return;
        if (
          registry.isBundleDebuggerRuntime(runtime) &&
          getLoadedRecordingForTab(
            store.get(loadedRecordingState),
            projectId,
            store.get(projectsState).openedProjects[projectId]?.fsPath,
          )
        )
          return;
        if (dispatchDecision.shouldDispatch && runtimeState.target?.type === 'internal-desktop')
          routeBundleExecution(projectId, message, data);
        if (!shouldRouteInactiveProjectEvent(projectId)) return;
        const shouldFlushFrozenOutputs = shouldFlushFrozenNodeOutputsForRemoteDebuggerEvent({
          alreadyFlushed: false,
          message,
          shouldDispatchExecutionEvent: dispatchDecision.shouldDispatch,
          target: runtimeState.target,
        });

        const shouldSettlePendingRequest = requestId != null || dispatchDecision.shouldDispatch;
        if (message === 'progress') {
          runtime.reportPendingGraphProgress(requestId, (data as ProcessEventMessageMap['progress']).progress);
        }
        if (shouldSettlePendingRequest) {
          if (message === 'graphOutputsReady') {
            runtime.resolvePendingGraphExecution(requestId, (data as { outputs: unknown }).outputs as any);
          } else if (message === 'done') {
            runtime.resolvePendingGraphExecution(requestId, (data as { results: unknown }).results as any);
          } else if (message === 'error') {
            runtime.rejectPendingGraphExecution(requestId, (data as { error: Error }).error);
          }
        }

        // Abort announces cancellation, but nodes can still be unwinding and
        // producing their terminal diagnostics. Keep request routing alive
        // until the root done/error event closes the invocation.
        if (shouldSettlePendingRequest && (message === 'done' || message === 'error')) {
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
            previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
          }),
        );
      },
    );
    const unsubscribeDisconnects = registry.subscribeDisconnectsForAllProjects((projectId, runtime) => {
      observations.disconnect(runtime);
      if (
        registry.isBundleDebuggerRuntime(runtime) &&
        getLoadedRecordingForTab(
          store.get(loadedRecordingState),
          projectId,
          store.get(projectsState).openedProjects[projectId]?.fsPath,
        )
      )
        return;
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
  }, [dataRefs, registry, store, routeBundleExecution, observations]);

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
