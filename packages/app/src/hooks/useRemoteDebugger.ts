import { useLatest } from 'ahooks';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { OutgoingMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { useExecutorSessionRegistry, useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { getLoadedRecordingForTab, loadedRecordingState } from '../state/execution.js';
import { projectState, projectsState, openedProjectSnapshotsState } from '../state/savedGraphs.js';
import { graphRunningState, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import { getRemoteDebuggerBundleProjects } from './remoteDebuggerBundle.js';
import { selectedExecutorState } from '../state/settings.js';
import { handleError } from '../utils/errorHandling.js';
import { updateOpenedProjectExecutorMode } from '../utils/openedProjects.js';
import {
  createLocalProjectExecutorMode,
  sanitizeProjectExecutorMode,
  type ProjectExecutorMode,
} from '../utils/projectExecutorMode.js';
import { type ExecutorSessionLifecycleEvent, type ExecutorSessionState } from './executorSession';

export function useRemoteDebugger(
  options: {
    onConnect?: (event: ExecutorSessionLifecycleEvent) => void | Promise<void>;
    onDisconnect?: (event: ExecutorSessionLifecycleEvent) => void | Promise<void>;
  } = {},
) {
  const runtime = useExecutorSessionRuntime();
  const registry = useExecutorSessionRegistry();
  const store = useStore();
  const currentProject = useAtomValue(projectState);
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const setProjects = useSetAtom(projectsState);
  const onConnectLatest = useLatest(options.onConnect ?? (() => {}));
  const onDisconnectLatest = useLatest(options.onDisconnect ?? (() => {}));

  const setCurrentProjectExecutorMode = useCallback(
    (mode: ProjectExecutorMode) => {
      const projectId = currentProject.metadata.id as ProjectId | undefined;
      if (!projectId) {
        return;
      }

      setProjects((previousProjects) => updateOpenedProjectExecutorMode(previousProjects, projectId, mode));
    },
    [currentProject.metadata.id, setProjects],
  );

  useEffect(() => {
    const projectId = currentProject.metadata.id;
    const unsubscribeConnect = runtime.subscribeLifecycle('connect', (event) => {
      if (store.get(projectState).metadata.id === projectId) return onConnectLatest.current?.(event);
    });
    const handleDisconnect = (event: ExecutorSessionLifecycleEvent) => {
      if (store.get(projectState).metadata.id !== projectId) return;
      if (
        registry.isBundleDebuggerRuntime(runtime) &&
        (!store.get(graphRunningState) ||
          getLoadedRecordingForTab(
            store.get(loadedRecordingState),
            projectId,
            store.get(projectsState).openedProjects[projectId]?.fsPath,
          ))
      )
        return;
      return onDisconnectLatest.current?.(event);
    };
    // The registry fences shared source cleanup by tab lifetime. A raw
    // socket disconnect alone cannot authorize writes to a replacement tab.
    const unsubscribeDisconnect = registry.isBundleDebuggerRuntime(runtime)
      ? registry.subscribeDisconnectsForAllProjects((id, disconnectedRuntime, event) => {
          if (id === projectId && disconnectedRuntime === runtime) return handleDisconnect(event);
        })
      : runtime.subscribeLifecycle('disconnect', handleDisconnect);

    return () => {
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [onConnectLatest, onDisconnectLatest, runtime, currentProject.metadata.id, store, registry]);

  const sessionState: ExecutorSessionState = runtime.buildSessionState();

  return {
    sessionState,
    connect: (url?: string) => {
      const remoteMode = sanitizeProjectExecutorMode({
        type: 'remote-debugger',
        url,
      });
      if (remoteMode?.type !== 'remote-debugger') {
        return;
      }

      const project = store.get(projectState);
      const members = getRemoteDebuggerBundleProjects(
        project.metadata.id,
        store.get(projectsState).openedProjects,
        store.get(openedProjectSnapshotsState),
        project,
      );
      const busy = members.some((id) =>
        id === project.metadata.id
          ? store.get(graphRunningState)
          : store.get(projectExecutionSnapshotsState)[id]?.graphRunning,
      );
      if (busy) {
        handleError(
          new Error('Stop active project executions before connecting the bundle Remote Debugger.'),
          'Failed to connect Remote Debugger',
        );
        return;
      }
      void registry.connectBundleDebugger(project.metadata.id, members, remoteMode.url).catch((error) => {
        handleError(error, 'Failed to connect Remote Debugger');
      });
    },
    disconnect: () => {
      runtime.disconnect();
      if (!registry.isBundleDebuggerRuntime(runtime))
        setCurrentProjectExecutorMode(createLocalProjectExecutorMode(selectedExecutor));
    },
    send<T extends keyof OutgoingMessageMap>(type: T, data: OutgoingMessageMap[T]) {
      return runtime.sendMessage(type, data);
    },
    sendRaw(data: string) {
      return runtime.sendRaw(data);
    },
  };
}
