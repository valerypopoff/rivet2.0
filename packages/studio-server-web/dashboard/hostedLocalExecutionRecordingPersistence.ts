import type { LocalExecutionRecordingPersistenceProvider } from '../../app/src/providers/ProvidersContext';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';

function endpoint(path = ''): string {
  return `${RIVET_API_BASE_URL}/workflows/local-editor-recordings${path}`;
}

async function reportPersistenceFailure(correlationId: string): Promise<void> {
  await fetch(endpoint('/outcome'), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correlationId, availability: 'persistence-failed' }),
  }).catch(() => undefined);
}

/**
 * Saves recorded local editor executions, whether or not they contain LLM
 * health evidence. The API owns validation, retention, and any durable
 * correlation to profile-health evidence.
 */
export function createHostedLocalExecutionRecordingPersistence(): LocalExecutionRecordingPersistenceProvider {
  let capability: Promise<boolean> | undefined;

  return {
    getCapability() {
      capability ??= fetch(endpoint('/capability'), { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
        .then(async (response) => {
          if (response.status === 404) return false;
          if (!response.ok) {
            // Only 404 is a definitive compatibility downgrade. Authentication,
            // throttling and service failures may recover on the next run.
            capability = undefined;
            return false;
          }
          const body = (await response.json().catch(() => ({}))) as { supported?: unknown };
          if (body.supported !== true) capability = undefined;
          return body.supported === true;
        })
        .catch(() => {
          // A transient network failure must not make this page treat a
          // subsequently restarted/upgraded server as permanently unsupported.
          capability = undefined;
          return false;
        });
      return capability;
    },
    async markUnavailable(correlationId) {
      await reportPersistenceFailure(correlationId);
    },
    async persist(input) {
      const response = await fetch(endpoint(), {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      await parseJsonResponse<{ availability: 'available' | 'disabled'; recordingId?: string }>(response);
    },
  };
}
