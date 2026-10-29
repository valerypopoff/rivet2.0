import { useAtomValue, useStore } from 'jotai';
import { getManagedLatestControlState } from './managedLatestControlState.js';
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

export function useManagedLatestControlState() {
  const store = useStore();
  const runtime = useExecutorSessionRuntime();
  const registry = useExecutorSessionRegistry();
  const project = useAtomValue(projectState);
  return getManagedLatestControlState(store, registry, runtime, project.metadata.id);
}

/** Persistence describes the tab's own executor, not its transient bundle observer. */
export function useOwnExecutorSessionState() {
  const registry = useExecutorSessionRegistry();
  const project = useAtomValue(projectState);
  useAtomValue(executorSessionRevisionState);
  return registry.getRuntime(project.metadata.id).buildSessionState();
}
