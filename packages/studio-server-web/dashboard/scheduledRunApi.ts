import { parseJsonResponse } from './apiRequest';

const endpoint = '/api/workflows/scheduled-runs';
const uncertainMessage =
  'The server returned an invalid acknowledgement. Check schedules and history before retrying; the action may have been accepted.';
const statuses = new Set([
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'skipped',
  'cancelled',
]);

/** One page-owned ledger survives modal disposal, but never stores inputs on disk. */
export function createScheduledRunRequester(
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    createId?: () => string;
  } = {},
) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const uncertainActions = new Map<string, { id: string; at: number }>();
  return async function request<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const intent =
      method === 'POST' && (path === '' || /\/(?:run|retry)$/.test(path)) ? JSON.stringify({ path, body }) : undefined;
    let requestId: string | undefined;
    if (intent !== undefined) {
      let pending = uncertainActions.get(intent);
      if (pending && now() - pending.at >= 86400_000)
        throw new Error(
          'This action is too old to retry safely. Review schedules and history before starting a new action.',
        );
      if (!pending) {
        if (uncertainActions.size >= 100)
          throw new Error('Too many unresolved actions. Review schedules and history before reloading.');
        pending = { id: createId(), at: now() };
        uncertainActions.set(intent, pending);
      }
      requestId = pending.id;
      body = { ...(body as object), requestId };
    }
    // Another modal/request may already own a newer key for this same intent.
    const acknowledge = () => {
      if (intent !== undefined && uncertainActions.get(intent)?.id === requestId) uncertainActions.delete(intent);
    };
    const response = await send(endpoint + path, {
      method,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) acknowledge();
    if (response.status === 204) {
      if (intent !== undefined) throw new Error(uncertainMessage);
      return undefined as T;
    }
    const result = await parseJsonResponse<T>(response);
    if (intent !== undefined) {
      const value = result as Record<string, unknown> | null;
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.id !== 'string' ||
        !value.id ||
        (path === ''
          ? !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
          : typeof value.scheduleId !== 'string' || !value.scheduleId || !statuses.has(String(value.status)))
      )
        throw new Error(uncertainMessage);
      acknowledge();
    }
    return result;
  };
}

export const requestScheduledRuns = createScheduledRunRequester();
