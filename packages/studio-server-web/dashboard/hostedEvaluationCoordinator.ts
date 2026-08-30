import { normalizeEvaluationRun } from '@valerypopoff/rivet2-evaluations';
import type { HostedEvaluationCoordinatorProvider } from '../../app/src/providers/ProvidersContext';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';

function endpoint(path = ''): string {
  return `${RIVET_API_BASE_URL}/workflows/evaluation-runs${path}`;
}

/**
 * The hosted editor submits an immutable snapshot then observes the normal
 * shared Evaluation store. It never runs a queued hosted trial itself.
 */
export function createHostedEvaluationCoordinator(): HostedEvaluationCoordinatorProvider {
  return {
    async getCapability() {
      const response = await fetch(endpoint('/hosted/capability'));
      // A hosted editor can be served briefly during a rolling API upgrade.
      // Treat a missing new route as disabled and retain the regular executor.
      if (response.status === 404) return { enabled: false, workerEnabled: false, workerConcurrency: 0 };
      return parseJsonResponse<{ enabled: boolean; workerEnabled: boolean; workerConcurrency: number }>(response);
    },
    async submit(input) {
      const response = await fetch(endpoint('/hosted'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return normalizeEvaluationRun(await parseJsonResponse<unknown>(response));
    },
    async requestCancel(input) {
      const response = await fetch(endpoint(`/${encodeURIComponent(input.runId)}/cancel-hosted`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (response.status === 404) return undefined;
      return normalizeEvaluationRun(await parseJsonResponse<unknown>(response));
    },
  };
}
