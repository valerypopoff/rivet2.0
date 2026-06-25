import { useAtomValue } from 'jotai';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';

export {
  shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect,
  useExecutorSessionCoordinator,
} from './useExecutorSessionCoordinator.js';

export function useExecutorSessionState(projectId?: ProjectId) {
  const runtime = useExecutorSessionRuntime(projectId);
  useAtomValue(executorSessionRevisionState);
  return runtime.buildSessionState();
}
