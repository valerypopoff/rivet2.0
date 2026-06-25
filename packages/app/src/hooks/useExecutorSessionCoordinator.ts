import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { useExecutorSessionHostConfig, useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { selectedExecutorState } from '../state/settings.js';
import { isInTauri } from '../utils/platform/core.js';
import {
  attachAndStartExecutorSidecar,
  detachAndStopExecutorSidecar,
  executorSidecarRuntime,
} from './useExecutorSidecar';
import {
  attachAndStartDesktopSidecarForRuntime,
  createExecutorRuntimeStartupToken,
  invalidateExecutorRuntimeStartup,
  isExecutorRuntimeStartupTokenCurrent,
  releaseDesktopSidecarForRuntime,
  type ExecutorRuntimeSidecar,
} from './executorSessionRuntimeResources.js';
import type { DefaultExecutor } from '../state/settings.js';
import type { ExecutorSessionLifecycleEvent, ExecutorSessionRuntime } from './executorSession.js';
import { handleError } from '../utils/errorHandling.js';

export type ExecutorSessionStartupAction =
  | { type: 'connect-desktop-internal' }
  | { type: 'connect-hosted-internal'; url: string }
  | { type: 'disconnect' }
  | { type: 'fallback-browser' };

export function getExecutorSessionStartupAction(options: {
  internalExecutorUrl?: string;
  isTauri: boolean;
  selectedExecutor: DefaultExecutor;
}): ExecutorSessionStartupAction {
  if (options.selectedExecutor !== 'nodejs') {
    return { type: 'disconnect' };
  }

  if (options.internalExecutorUrl) {
    return { type: 'connect-hosted-internal', url: options.internalExecutorUrl };
  }

  if (!options.isTauri) {
    return { type: 'fallback-browser' };
  }

  return { type: 'connect-desktop-internal' };
}

export function shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect(options: {
  event: ExecutorSessionLifecycleEvent;
  hasInternalExecutorUrl: boolean;
  isTauri: boolean;
  selectedExecutor: DefaultExecutor;
}) {
  return (
    options.selectedExecutor === 'nodejs' &&
    options.event.type === 'disconnected' &&
    (options.event.reason === 'manual-disconnect' || options.event.reason === 'unexpected-disconnect') &&
    options.event.target?.type === 'external-debugger' &&
    (options.hasInternalExecutorUrl || options.isTauri)
  );
}

type CoordinatorRuntime = Pick<
  ExecutorSessionRuntime,
  'connectInternalDesktopExecutor' | 'connectInternalHostedExecutor' | 'disconnect'
>;

type RuntimeWithOptionalState = CoordinatorRuntime & Partial<Pick<ExecutorSessionRuntime, 'getRuntimeState'>>;

type CoordinatorSidecar = ExecutorRuntimeSidecar;

const defaultCoordinatorSidecar: CoordinatorSidecar = {
  attachAndStart: attachAndStartExecutorSidecar,
  detachAndStop: detachAndStopExecutorSidecar,
  isStarted: () => executorSidecarRuntime.started,
};

function handleCoordinatorError(error: unknown, context: string) {
  handleError(error, context, {
    toastError: false,
  });
}

function connectInternalNodeExecutor(
  runtime: RuntimeWithOptionalState,
  options: {
    internalExecutorUrl?: string;
    sidecar?: CoordinatorSidecar;
  } = {},
) {
  const { internalExecutorUrl, sidecar = defaultCoordinatorSidecar } = options;

  if (!internalExecutorUrl) {
    const startupToken = createExecutorRuntimeStartupToken(runtime);

    void (async () => {
      try {
        await attachAndStartDesktopSidecarForRuntime(runtime, sidecar);

        if (
          isExecutorRuntimeStartupTokenCurrent(runtime, startupToken) &&
          sidecar.isStarted() &&
          !hasExternalDebuggerTarget(runtime)
        ) {
          await runtime.connectInternalDesktopExecutor();
        }
      } catch (error) {
        handleCoordinatorError(error, 'Executor session coordinator startup failed');
      }
    })();
    return;
  }

  invalidateExecutorRuntimeStartup(runtime);
  releaseDesktopSidecarForRuntime(runtime, sidecar);
  void runtime.connectInternalHostedExecutor(internalExecutorUrl).catch((error) => {
    handleCoordinatorError(error, 'Executor session coordinator connect failed');
  });
}

export function handleExecutorSessionCoordinatorDisconnect(options: {
  event: ExecutorSessionLifecycleEvent;
  getInternalExecutorUrl: () => string | undefined;
  getSelectedExecutor: () => DefaultExecutor;
  isTauri: boolean;
  runtime: CoordinatorRuntime;
  sidecar?: CoordinatorSidecar;
}) {
  const internalExecutorUrl = options.getInternalExecutorUrl();
  const selectedExecutor = options.getSelectedExecutor();

  if (
    !shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect({
      event: options.event,
      hasInternalExecutorUrl: !!internalExecutorUrl,
      isTauri: options.isTauri,
      selectedExecutor,
    })
  ) {
    return;
  }

  connectInternalNodeExecutor(options.runtime, {
    internalExecutorUrl,
    sidecar: options.sidecar,
  });
}

function hasExternalDebuggerTarget(runtime: RuntimeWithOptionalState) {
  return runtime.getRuntimeState?.().target?.type === 'external-debugger';
}

export function runExecutorSessionStartupAction(options: {
  action: ExecutorSessionStartupAction;
  runtime: RuntimeWithOptionalState;
  setSelectedExecutor: (executor: DefaultExecutor) => void;
  sidecar?: CoordinatorSidecar;
}) {
  const { action, runtime, setSelectedExecutor, sidecar = defaultCoordinatorSidecar } = options;

  if (hasExternalDebuggerTarget(runtime)) {
    return () => {
      // Startup effects may mount while a project is already connected to an
      // external debugger. Leave that runtime alone even if it later restores
      // to an internal executor; explicit mode changes perform cleanup.
    };
  }

  if (action.type === 'disconnect') {
    invalidateExecutorRuntimeStartup(runtime);
    releaseDesktopSidecarForRuntime(runtime, sidecar);
    runtime.disconnect();

    return () => {
      // Already disconnected by the action itself.
    };
  }

  if (action.type === 'connect-hosted-internal') {
    connectInternalNodeExecutor(runtime, { internalExecutorUrl: action.url, sidecar });

    return () => {
      // Project switches unmount the active coordinator for the previous project.
      // Keep that runtime alive; explicit Browser-mode selection and project
      // close/replacement perform destructive cleanup.
    };
  }

  if (action.type === 'fallback-browser') {
    setSelectedExecutor('browser');
    invalidateExecutorRuntimeStartup(runtime);
    releaseDesktopSidecarForRuntime(runtime, sidecar);
    runtime.disconnect();
    return;
  }

  connectInternalNodeExecutor(runtime, { sidecar });

  return () => {
    // Project switches unmount the active coordinator for the previous project.
    // Keep that runtime and its sidecar ownership alive; explicit Browser-mode
    // selection and project close/replacement perform destructive cleanup.
  };
}

export function useExecutorSessionCoordinator(selectedExecutor: DefaultExecutor) {
  const runtime = useExecutorSessionRuntime();
  const hostConfig = useExecutorSessionHostConfig();
  const setSelectedExecutor = useSetAtom(selectedExecutorState);
  const internalExecutorUrlRef = useRef(hostConfig?.internalExecutorUrl);
  const selectedExecutorRef = useRef(selectedExecutor);

  internalExecutorUrlRef.current = hostConfig?.internalExecutorUrl;
  selectedExecutorRef.current = selectedExecutor;

  useEffect(() => {
    return runtime.subscribeLifecycle('disconnect', (event) => {
      handleExecutorSessionCoordinatorDisconnect({
        event,
        getInternalExecutorUrl: () => internalExecutorUrlRef.current,
        getSelectedExecutor: () => selectedExecutorRef.current,
        isTauri: isInTauri(),
        runtime,
      });
    });
  }, [runtime]);

  useEffect(() => {
    const startupAction = getExecutorSessionStartupAction({
      internalExecutorUrl: hostConfig?.internalExecutorUrl,
      isTauri: isInTauri(),
      selectedExecutor,
    });

    return runExecutorSessionStartupAction({
      action: startupAction,
      runtime,
      setSelectedExecutor,
    });
  }, [hostConfig?.internalExecutorUrl, runtime, selectedExecutor, setSelectedExecutor]);
}
