import { useLatest } from 'ahooks';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { OutgoingMessageMap, ProjectId } from '@valerypopoff/rivet2-core';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
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
  useAtomValue(executorSessionRevisionState);
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
    const unsubscribeConnect = runtime.subscribeLifecycle('connect', (event) => onConnectLatest.current?.(event));
    const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', (event) =>
      onDisconnectLatest.current?.(event),
    );

    return () => {
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [onConnectLatest, onDisconnectLatest, runtime]);

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

      setCurrentProjectExecutorMode(remoteMode);

      void runtime.connectExternalDebugger(remoteMode.url).catch((error) => {
        setCurrentProjectExecutorMode(createLocalProjectExecutorMode(selectedExecutor));
        handleError(error, 'Failed to connect Remote Debugger');
      });
    },
    disconnect: () => {
      runtime.disconnect();
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
