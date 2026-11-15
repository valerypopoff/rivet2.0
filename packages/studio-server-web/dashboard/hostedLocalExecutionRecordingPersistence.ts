import type { LocalExecutionRecordingPersistenceProvider } from '../../app/src/providers/ProvidersContext';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';
import { WORKFLOW_RECORDING_CREATED_AT_HEADER } from '../../studio-server-shared/workflow-recording-time';
import type { RunEvidenceHandle, RunEvidenceSummary } from '../../studio-server-shared/workflow-run-evidence';

const durableRuns = new Map<
  string,
  { handle: RunEvidenceHandle; timer?: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> }
>();
export function hostedRecordingEvidenceHandle(correlationId: string | undefined) {
  return correlationId ? durableRuns.get(correlationId)?.handle : undefined;
}
function stopHeartbeat(correlationId: string, remove = false) {
  const entry = durableRuns.get(correlationId);
  if (entry) {
    clearInterval(entry.timer);
    if (remove) {
      clearTimeout(entry.expiry);
      durableRuns.delete(correlationId);
    }
  }
}
async function evidenceOperation(operation: string, handle: RunEvidenceHandle, outcome?: unknown) {
  return parseJsonResponse<RunEvidenceSummary>(
    await fetch(endpoint('/runs/' + operation), {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, ...(outcome ? { outcome } : {}) }),
    }),
  );
}

export async function reportHostedChildRecordingFailure(correlationId: string | undefined): Promise<void> {
  const handle = hostedRecordingEvidenceHandle(correlationId);
  if (handle) await evidenceOperation('child-incomplete', handle).catch(() => undefined);
}

function endpoint(path = ''): string {
  return `${RIVET_API_BASE_URL}/workflows/local-editor-recordings${path}`;
}

async function reportPersistenceFailure(correlationId: string, providedHandle?: RunEvidenceHandle): Promise<void> {
  const handle = providedHandle ?? hostedRecordingEvidenceHandle(correlationId);
  await fetch(endpoint('/outcome'), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      correlationId,
      availability: 'persistence-failed',
      ...(handle ? { evidenceHandle: handle } : {}),
    }),
  }).catch(() => undefined);
}

/**
 * Saves recorded local editor executions, whether or not they contain LLM
 * health evidence. The API owns validation, retention, and any durable
 * correlation to profile-health evidence.
 */
export function createHostedLocalExecutionRecordingPersistence(): LocalExecutionRecordingPersistenceProvider {
  let capability: Promise<boolean> | undefined;
  let durable = false;

  return {
    getCapability() {
      capability ??= fetch(endpoint('/capability'), { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
        .then(async (response) => {
          if (response.status === 404) return false;
          if (!response.ok) {
            // Only 404 is a definitive compatibility downgrade. Authentication,
            // throttling and service failures may recover on the next run.
            capability = undefined;
            throw new Error('Recording capability could not be confirmed.');
          }
          const body = (await response.json()) as { supported?: unknown; durability?: unknown };
          if (typeof body.supported !== 'boolean') throw new Error('Invalid recording capability response.');
          durable = body.durability === 'run-evidence-v1';
          if (body.supported !== true) capability = undefined;
          return body.supported === true;
        })
        .catch(() => {
          // A transient network failure must not make this page treat a
          // subsequently restarted/upgraded server as permanently unsupported.
          capability = undefined;
          throw new Error('Recording capability could not be confirmed. Try again or turn off recording.');
        });
      return capability;
    },
    async begin(input) {
      if (!durable) return undefined;
      const correlationId = input.correlationId.replace(/^rvt-local-/, 'rvt-durable-local-');
      const handle = { id: crypto.randomUUID(), token: crypto.randomUUID() };
      const createdAt = new Date().toISOString();
      try {
        await parseJsonResponse(
          await fetch(endpoint('/runs/begin'), {
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              handle,
              createdAt,
              projectId: input.projectId,
              projectPath: input.projectPath,
              graphId: input.graphId,
              correlationId,
            }),
          }),
        );
      } catch (error) {
        // The registration itself cannot execute a graph. Confirm a possibly committed write.
        try {
          await evidenceOperation('read', handle);
        } catch {
          throw error;
        }
      }
      const expiry = setTimeout(() => stopHeartbeat(correlationId, true), 60 * 60_000);
      const timer =
        input.source === 'browser'
          ? setInterval(() => {
              void evidenceOperation('heartbeat', handle)
                .then(() => {
                  const entry = durableRuns.get(correlationId);
                  if (entry) {
                    clearTimeout(entry.expiry);
                    entry.expiry = setTimeout(() => stopHeartbeat(correlationId, true), 60 * 60_000);
                    entry.expiry.unref?.();
                  }
                })
                .catch(() => undefined);
            }, 30_000)
          : undefined;
      timer?.unref?.();
      expiry.unref?.();
      durableRuns.set(correlationId, { handle, timer, expiry });
      return { handle, correlationId };
    },
    async complete(correlationId, status, durationMs, providedHandle) {
      const handle = providedHandle ?? hostedRecordingEvidenceHandle(correlationId);
      if (!handle) return;
      stopHeartbeat(correlationId);
      await evidenceOperation('outcome', handle, { state: status, durationMs });
    },
    async markUnavailable(correlationId, handle) {
      await reportPersistenceFailure(correlationId, handle);
      stopHeartbeat(correlationId, true);
    },
    async persist(input) {
      const { createdAt, evidenceHandle, ...originalBody } = input;
      const handle = evidenceHandle ?? hostedRecordingEvidenceHandle(input.executionIdentity.correlationId);
      const body = handle ? { ...originalBody, evidenceHandle: handle } : originalBody;
      try {
        for (let attempt = 0; attempt < (handle ? 2 : 1); attempt++) {
          try {
            const response = await fetch(endpoint(), {
              method: 'POST',
              signal: AbortSignal.timeout(60_000),
              headers: {
                'Content-Type': 'application/json',
                ...(createdAt ? { [WORKFLOW_RECORDING_CREATED_AT_HEADER]: createdAt } : {}),
              },
              body: JSON.stringify(body),
            });
            const saved = await parseJsonResponse<{
              availability: 'available' | 'disabled' | 'pending';
              recordingId?: string;
            }>(response);
            if (handle && (saved.recordingId !== handle.id || !['available', 'pending'].includes(saved.availability))) {
              throw new Error('Durable recording handoff could not be confirmed.');
            }
            return;
          } catch (error) {
            if (!handle) throw error;
            const statusCode = (error as { status?: number } | null)?.status;
            if (statusCode && statusCode >= 400 && statusCode < 500 && ![408, 429].includes(statusCode)) throw error;
            const status = await evidenceOperation('read', handle);
            if (status.availability === 'deleted') throw error;
            if (status.availability === 'available' || (status.availability === 'pending' && status.handoffReady))
              return;
            if (attempt === 1) throw error;
            // Only this immutable, handle-bound payload is retried; no run command is sent.
          }
        }
      } finally {
        stopHeartbeat(input.executionIdentity.correlationId, true);
      }
    },
  };
}
