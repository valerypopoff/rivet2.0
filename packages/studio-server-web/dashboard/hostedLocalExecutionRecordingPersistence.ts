import type { LocalExecutionRecordingPersistenceProvider } from '../../app/src/providers/ProvidersContext';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';

function endpoint(path = ''): string {
  return `${RIVET_API_BASE_URL}/workflows/local-editor-recordings${path}`;
}

async function reportPersistenceFailure(correlationId: string): Promise<void> {
  await fetch(endpoint('/outcome'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correlationId, availability: 'persistence-failed' }),
  }).catch(() => undefined);
}

/**
 * Saves only the locally executed recordings that Core marked as unhealthy
 * LLM-profile attempts. The API owns validation, retention, and the durable
 * correlation to the profile-health evidence.
 */
export function createHostedLocalExecutionRecordingPersistence(): LocalExecutionRecordingPersistenceProvider {
  let capability: Promise<boolean> | undefined;

  return {
    getCapability() {
      capability ??= fetch(endpoint('/capability'), { cache: 'no-store' })
        .then(async (response) => {
          if (response.status === 404) return false;
          if (!response.ok) {
            // The dev stack can be briefly unavailable while its API restarts.
            // Keep a definitive compatibility downgrade for 404, but retry a
            // transient server failure on the next editor run.
            if (response.status >= 500) capability = undefined;
            return false;
          }
          const body = (await response.json().catch(() => ({}))) as { supported?: unknown };
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      await parseJsonResponse<{ availability: 'available' | 'disabled'; recordingId?: string }>(response);
    },
  };
}
