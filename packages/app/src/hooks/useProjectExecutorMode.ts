import { useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { defaultExecutorState, selectedExecutorState } from '../state/settings.js';
import { handleError } from '../utils/errorHandling.js';
import {
  createLocalProjectExecutorMode,
  sanitizeProjectExecutorMode,
  type ProjectExecutorMode,
} from '../utils/projectExecutorMode.js';

export function useApplyProjectExecutorMode() {
  const runtime = useExecutorSessionRuntime();
  const defaultExecutor = useAtomValue(defaultExecutorState);
  const [selectedExecutor, setSelectedExecutor] = useAtom(selectedExecutorState);

  return useCallback(
    (mode: ProjectExecutorMode | undefined) => {
      const nextMode = sanitizeProjectExecutorMode(mode) ?? createLocalProjectExecutorMode(defaultExecutor);

      if (nextMode.type === 'remote-debugger') {
        void runtime.connectExternalDebugger(nextMode.url).catch((error) => {
          handleError(error, 'Failed to restore Remote Debugger for project');
        });
        return;
      }

      if (selectedExecutor !== nextMode.executor) {
        setSelectedExecutor(nextMode.executor);
        if (runtime.getRuntimeState().target?.type === 'external-debugger') {
          runtime.disconnect({ reason: 'replaced' });
        }
        return;
      }

      const sessionState = runtime.getRuntimeState();

      if (nextMode.executor === 'browser' && sessionState.target != null) {
        runtime.disconnect({ reason: 'replaced' });
        return;
      }

      if (nextMode.executor === 'nodejs' && sessionState.target?.type === 'external-debugger') {
        runtime.disconnect();
      }
    },
    [defaultExecutor, runtime, selectedExecutor, setSelectedExecutor],
  );
}
