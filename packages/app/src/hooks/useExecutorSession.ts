import { useAtomValue } from 'jotai';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useExecutorSessionRegistry, useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { projectState } from '../state/savedGraphs.js';
import { executorSessionRevisionState } from '../state/execution.js';

export {
  shouldRestoreInternalNodeExecutorAfterExternalDebuggerDisconnect,
  useExecutorSessionCoordinator,
} from './useExecutorSessionCoordinator.js';

export function useExecutorSessionState(projectId?: ProjectId) {
  const runtime = useExecutorSessionRuntime(projectId);
  return runtime.buildSessionState();
}

/** Persistence describes the tab's own executor, not its transient bundle observer. */
export function useOwnExecutorSessionState() {
  const registry = useExecutorSessionRegistry();
  const project = useAtomValue(projectState);
  useAtomValue(executorSessionRevisionState);
  return registry.getRuntime(project.metadata.id).buildSessionState();
}
