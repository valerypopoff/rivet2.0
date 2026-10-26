import type {
  WorkflowNamespaceCommand,
  WorkflowNamespaceMutation,
} from '../../studio-server-shared/workflow-namespace-types';
import type { WorkflowFolderItem, WorkflowProjectItem } from './types';
import { parseJsonResponse } from './apiRequest';
import {
  mutationRequestText,
  type StructuralCommand,
  type StructuralMutation,
} from '../../studio-server-shared/workflow-mutation-contract';

const recoveredResults = new WeakSet<object>();
export class MutationOutcomeUnknownError extends Error {
  constructor() {
    super('The operation outcome is unknown. No write was retried. Refresh the library before another action.');
    this.name = 'MutationOutcomeUnknownError';
  }
}
export function isRecoveredMutationResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && recoveredResults.has(value);
}
function markRecovered<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    recoveredResults.add(value);
    for (const key of ['project', 'folder'] as const) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== null && typeof nested === 'object') recoveredResults.add(nested);
    }
  }
  return value;
}

export async function requestStructuralMutation<T>(options: {
  api: string;
  url: string;
  command: StructuralCommand | { operation: 'save-as'; input: unknown };
  input: object;
  preconditions: Omit<StructuralMutation, 'operationId' | 'expiresAt'>;
  headers?: Record<string, string>;
}): Promise<T> {
  const mutation: StructuralMutation = {
    ...options.preconditions,
    operationId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  // Capture wire bytes and logical hash input together, before WebCrypto yields.
  // Callers may continue editing their objects while this request is in flight.
  const mutateUrl = options.url;
  const recoverUrl = `${options.api}/workflows/namespace/receipt`;
  const headers = { ...options.headers, 'X-Rivet-Namespace-Intent': '1', 'Content-Type': 'application/json' };
  const body = JSON.stringify({ ...options.input, mutation });
  const hashInput = new TextEncoder().encode(mutationRequestText(mutation, options.command));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', hashInput));
  const requestHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return sendRecoverableMutation<T>({
    mutateUrl,
    recoverUrl,
    body,
    recoveryBody: JSON.stringify({ operationId: mutation.operationId, requestHash }),
    headers,
  });
}

export function namespaceIdentity(
  item: WorkflowFolderItem | WorkflowProjectItem,
): WorkflowNamespaceMutation['expectedSource'] | undefined {
  if ('namespaceId' in item && item.namespaceId) return { id: item.namespaceId };
  if ('namespaceProtocol' in item && item.namespaceProtocol === 1) {
    if (!item.projectMetadataId) throw new Error('Project identity is unavailable. Refresh the library.');
    return { id: item.projectMetadataId, revisionId: item.revisionId };
  }
  return undefined; // Historical filesystem fixtures/compatibility adapters only.
}

/** No write retries. A lost acknowledgement can only trigger a receipt lookup. */
export async function requestNamespaceMutation<T>(options: {
  api: string;
  headers: Record<string, string>;
  command: WorkflowNamespaceCommand;
  expectedSource: WorkflowNamespaceMutation['expectedSource'];
  expectedDestinationId?: string | null;
}): Promise<T> {
  const input: WorkflowNamespaceMutation = {
    operationId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    command: options.command,
    expectedSource: options.expectedSource,
    ...(options.expectedDestinationId !== undefined ? { expectedDestinationId: options.expectedDestinationId } : {}),
  };
  return requestRecoverableMutation<T>({
    mutateUrl: `${options.api}/workflows/namespace/mutate`,
    recoverUrl: `${options.api}/workflows/namespace/recover`,
    input,
    headers: { ...options.headers, 'X-Rivet-Namespace-Intent': '1' },
  });
}

export async function requestRecoverableMutation<T>(options: {
  mutateUrl: string;
  recoverUrl: string;
  input: unknown;
  recoveryInput?: unknown;
  headers: Record<string, string>;
}): Promise<T> {
  const body = JSON.stringify(options.input);
  return sendRecoverableMutation<T>({
    mutateUrl: options.mutateUrl,
    recoverUrl: options.recoverUrl,
    headers: { ...options.headers, 'Content-Type': 'application/json' },
    body,
    recoveryBody: options.recoveryInput == null ? body : JSON.stringify(options.recoveryInput),
  });
}

/** Prepared once: neither request is rebuilt from caller-owned mutable state. */
async function sendRecoverableMutation<T>(options: {
  mutateUrl: string;
  recoverUrl: string;
  body: string | undefined;
  recoveryBody: string | undefined;
  headers: Record<string, string>;
}): Promise<T> {
  const request = (url: string, body: string | undefined) =>
    fetch(url, {
      method: 'POST',
      headers: options.headers,
      body,
    });
  try {
    return await parseJsonResponse<T>(await request(options.mutateUrl, options.body));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) throw error;
    try {
      const receipt = await parseJsonResponse<{ state: 'unknown' | 'committed'; result?: T }>(
        await request(options.recoverUrl, options.recoveryBody),
      );
      if (receipt.state === 'committed' && Object.hasOwn(receipt, 'result')) return markRecovered(receipt.result as T);
    } catch {
      /* A failed lookup is not permission to replay a write. */
    }
    throw new MutationOutcomeUnknownError();
  }
}
