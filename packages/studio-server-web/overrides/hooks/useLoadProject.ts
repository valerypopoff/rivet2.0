import { useActivateOpenedProject } from '../../../app/src/hooks/useActivateOpenedProject.js';
import { getOpenedProjectSession, primeOpenedProjectSession } from '../../io/openedProjectSessionCache.js';
import { normalizeHostedProjectExecutorMode } from '../utils/hostedExecutorMode.js';

export function useLoadProject() {
  return useActivateOpenedProject({
    getEvaluation: (info) => (info.fsPath ? getOpenedProjectSession(info.projectId, info.fsPath) : undefined),
    cacheEvaluation: (info, evaluation) => {
      if (info.fsPath) primeOpenedProjectSession(info.projectId, { fsPath: info.fsPath, evaluation });
    },
    normalizeExecutorMode: normalizeHostedProjectExecutorMode,
  });
}
