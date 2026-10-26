import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkflowMutationReceipt } from '../../../../../studio-server-shared/workflow-namespace-types.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { mutationRequestText } from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import type { CatalogTransaction } from './structural-admission.js';

function requestHash(receipt: WorkflowMutationReceipt, payload: unknown): string {
  return createHash('sha256').update(mutationRequestText(receipt, payload)).digest('hex');
}
const captured = new WeakSet<object>();
export type CapturedReceipt = Readonly<WorkflowMutationReceipt & { requestHash: string }>;

/** Plain DTOs only. Execution and hashing share this private snapshot. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function captureOperation<T>(
  input: T,
  receipt: (snapshot: T) => WorkflowMutationReceipt | undefined,
  payload: (snapshot: T) => unknown,
) {
  const snapshot = freeze(structuredClone(input));
  const selected = receipt(snapshot);
  const admission: CapturedReceipt | undefined = selected
    ? Object.freeze({ ...selected, requestHash: requestHash(selected, payload(snapshot)) })
    : undefined;
  if (admission) captured.add(admission);
  return { input: snapshot, admission };
}
export function recoverCapturedReceipt<T>(client: Pool | PoolClient, receipt: CapturedReceipt) {
  if (!captured.has(receipt)) throw new Error('A server-captured receipt is required.');
  return recoverMutationByHash<T>(client, receipt.operationId, receipt.requestHash);
}
export function assertMutationAdmission(receipt: WorkflowMutationReceipt): void {
  const expires = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now())
    throw createHttpError(410, 'This operation expired. Refresh the library before starting another action.');
  if (expires > Date.now() + 15 * 60_000) throw createHttpError(400, 'Operation admission exceeds 15 minutes.');
}
/** Observational only: absence never grants permission to replay a write. */
export async function recoverMutationReceipt<T>(
  client: Pool | PoolClient,
  receipt: WorkflowMutationReceipt,
  payload: unknown,
): Promise<{ state: 'unknown' } | { state: 'committed'; result: T }> {
  return recoverMutationByHash(client, receipt.operationId, requestHash(receipt, payload));
}

export async function recoverMutationByHash<T>(
  client: Pool | PoolClient,
  operationId: string,
  hash: string,
): Promise<{ state: 'unknown' } | { state: 'committed'; result: T }> {
  const previous = await client.query<{ request_hash: string; result: T }>(
    'SELECT request_hash,result FROM workflow_namespace_receipts WHERE operation_id=$1',
    [operationId],
  );
  if (!previous.rows[0]) return { state: 'unknown' };
  if (previous.rows[0].request_hash !== hash) throw conflict('This operation ID belongs to a different request.');
  return { state: 'committed', result: previous.rows[0].result };
}
/** Caller supplies its already owned transaction. No connection or work owner is created. */
export async function withMutationReceipt<T>(
  tx: CatalogTransaction,
  admitted: CapturedReceipt | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!tx.topologyOwned) throw new Error('A topology-owned transaction is required.');
  const { client } = tx;
  if (!admitted) return run(); // Explicit trusted internal call, never an HTTP fallback.
  await client.query(`DELETE FROM workflow_namespace_receipts WHERE operation_id IN (
    SELECT operation_id FROM workflow_namespace_receipts WHERE expires_at < NOW() - INTERVAL '24 hours'
    ORDER BY expires_at LIMIT 100)`);
  const previous = await recoverCapturedReceipt<T>(client, admitted);
  if (previous.state === 'committed') return previous.result;
  assertMutationAdmission(admitted);
  const result = await run();
  await client.query(
    'INSERT INTO workflow_namespace_receipts(operation_id,request_hash,expires_at,result) VALUES($1,$2,$3,$4::jsonb)',
    [admitted.operationId, admitted.requestHash, admitted.expiresAt, JSON.stringify(result)],
  );
  return result;
}
