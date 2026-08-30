import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { recordStudioMetrics } from '../../../metrics.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import type { ManagedWorkflowMaintenanceLease, ManagedWorkflowMaintenanceTask } from './maintenance.js';

const MIN_UNREFERENCED_OBJECT_AGE_MS = 24 * 60 * 60 * 1_000;

export type ManagedReconciliationDomain = 'evaluations' | 'runtime_libraries' | 'workflows';
type ManagedReconciliationPhase = 'metadata' | 'objects';
type ReconciliationFinding = {
  kind: string;
  subjectKey: string;
};
type ReconciliationStateRow = QueryResultRow & {
  active_generation: number | string;
  completed_generation: number | string;
  cursor: string | null;
  domain: ManagedReconciliationDomain;
  phase: ManagedReconciliationPhase;
};
type WorkflowReferenceRow = QueryResultRow & { object_key: string };
type EvaluationReferenceRow = QueryResultRow & { project_id: string; recording_id: string };
type OpenFindingCountRow = QueryResultRow & { count: string };
type OpenFindingCountByDomainRow = QueryResultRow & { count: string; domain: ManagedReconciliationDomain };
type ReconciliationStatusRow = QueryResultRow & {
  active_generation: number | string;
  completed_generation: number | string;
  domain: ManagedReconciliationDomain;
  last_completed_at: Date | string | null;
  last_error_at: Date | string | null;
  last_error_code: string | null;
  phase: ManagedReconciliationPhase;
  scan_started_at: Date | string | null;
};

export type ManagedReconciliationStatus = {
  activeGeneration: number;
  completedGeneration: number;
  domain: ManagedReconciliationDomain;
  lastCompletedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  openFindingCount: number;
  phase: ManagedReconciliationPhase;
  scanStartedAt: string | null;
};

export type ManagedReconciliationFindingSummary = {
  count: number;
  domain: ManagedReconciliationDomain;
  kind: string;
  latestSeenAt: string;
  longestConsecutiveCompleteScans: number;
  oldestFirstSeenAt: string;
  state: 'open' | 'resolved';
};

const RECONCILIATION_DOMAINS: readonly ManagedReconciliationDomain[] = [
  'workflows',
  'runtime_libraries',
  'evaluations',
];

function toFiniteInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Managed reconciliation state contained an invalid generation.');
  }
  return parsed;
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sameState(left: ReconciliationStateRow, right: ReconciliationStateRow): boolean {
  return (
    left.phase === right.phase &&
    left.cursor === right.cursor &&
    toFiniteInteger(left.active_generation) === toFiniteInteger(right.active_generation)
  );
}

async function ensureState(pool: Pool, domain: ManagedReconciliationDomain): Promise<ReconciliationStateRow> {
  await pool.query(
    `
      INSERT INTO managed_reconciliation_state (domain)
      VALUES ($1)
      ON CONFLICT (domain) DO NOTHING
    `,
    [domain],
  );
  const result = await pool.query<ReconciliationStateRow>(
    `
      SELECT domain, phase, cursor, active_generation, completed_generation
      FROM managed_reconciliation_state
      WHERE domain = $1
    `,
    [domain],
  );
  const state = result.rows[0];
  if (!state) throw new Error(`Managed reconciliation state for ${domain} was not created.`);
  return state;
}

function hasObjectScanner(
  store: ManagedWorkflowBlobStore | undefined,
): store is ManagedWorkflowBlobStore & Required<Pick<ManagedWorkflowBlobStore, 'exists' | 'listPage'>> {
  return Boolean(store?.exists && store?.listPage);
}

async function listWorkflowReferencePage(
  pool: Pool,
  cursor: string | null,
  pageSize: number,
): Promise<{ keys: string[]; nextCursor: string | null }> {
  const result = await pool.query<WorkflowReferenceRow>(
    `
      WITH referenced_objects AS (
        SELECT project_blob_key AS object_key FROM workflow_revisions
        UNION
        SELECT dataset_blob_key AS object_key FROM workflow_revisions WHERE dataset_blob_key IS NOT NULL
        UNION
        SELECT recording_blob_key AS object_key FROM workflow_recordings
        UNION
        SELECT replay_project_blob_key AS object_key FROM workflow_recordings
        UNION
        SELECT replay_dataset_blob_key AS object_key FROM workflow_recordings WHERE replay_dataset_blob_key IS NOT NULL
      )
      SELECT object_key
      FROM referenced_objects
      WHERE $1::text IS NULL OR object_key > $1::text
      ORDER BY object_key ASC
      LIMIT $2
    `,
    [cursor, pageSize],
  );
  const keys = result.rows.map((row) => row.object_key);
  return { keys, nextCursor: keys.length === pageSize ? keys.at(-1) ?? null : null };
}

async function listRuntimeLibraryReferencePage(
  pool: Pool,
  cursor: string | null,
  pageSize: number,
): Promise<{ keys: string[]; nextCursor: string | null; schemaPresent: boolean }> {
  const schemaResult = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('runtime_library_releases') IS NOT NULL AS present",
  );
  if (!schemaResult.rows[0]?.present) {
    return { keys: [], nextCursor: null, schemaPresent: false };
  }
  const result = await pool.query<WorkflowReferenceRow>(
    `
      SELECT artifact_blob_key AS object_key
      FROM runtime_library_releases
      WHERE $1::text IS NULL OR artifact_blob_key > $1::text
      ORDER BY artifact_blob_key ASC
      LIMIT $2
    `,
    [cursor, pageSize],
  );
  const keys = result.rows.map((row) => row.object_key);
  return { keys, nextCursor: keys.length === pageSize ? keys.at(-1) ?? null : null, schemaPresent: true };
}

async function listEvaluationReferencePage(
  pool: Pool,
  cursor: string | null,
  pageSize: number,
): Promise<{ findings: ReconciliationFinding[]; nextCursor: string | null }> {
  let parsedCursor: unknown = null;
  try {
    parsedCursor = cursor ? JSON.parse(cursor) : null;
  } catch {
    // A state cursor is only an optimization checkpoint. Recovering from a
    // malformed persisted value by restarting this bounded scan is safer than
    // leaving the domain permanently stuck until manual database repair.
  }
  const projectCursor = Array.isArray(parsedCursor) && typeof parsedCursor[0] === 'string' ? parsedCursor[0] : null;
  const recordingCursor = Array.isArray(parsedCursor) && typeof parsedCursor[1] === 'string' ? parsedCursor[1] : null;
  const result = await pool.query<EvaluationReferenceRow>(
    `
      SELECT recording.project_id, recording.recording_id
      FROM evaluation_recordings AS recording
      LEFT JOIN evaluation_runs AS run
        ON run.project_id = recording.project_id AND run.run_id = recording.run_id
      WHERE run.run_id IS NULL
        AND (
          $1::text IS NULL
          OR recording.project_id > $1::text
          OR (recording.project_id = $1::text AND recording.recording_id > $2::text)
        )
      ORDER BY recording.project_id ASC, recording.recording_id ASC
      LIMIT $3
    `,
    [projectCursor, recordingCursor, pageSize],
  );
  const last = result.rows.at(-1);
  return {
    findings: result.rows.map((row) => ({
      kind: 'recording-without-run',
      // Durable finding subjects are operator-only database data, never metric
      // labels or log fields. JSON avoids collisions between composite IDs.
      subjectKey: JSON.stringify([row.project_id, row.recording_id]),
    })),
    nextCursor: result.rows.length === pageSize && last ? JSON.stringify([last.project_id, last.recording_id]) : null,
  };
}

async function workflowKeysStillReferenced(client: PoolClient, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await client.query<WorkflowReferenceRow>(
    `
      WITH referenced_objects AS (
        SELECT project_blob_key AS object_key FROM workflow_revisions
        UNION
        SELECT dataset_blob_key AS object_key FROM workflow_revisions WHERE dataset_blob_key IS NOT NULL
        UNION
        SELECT recording_blob_key AS object_key FROM workflow_recordings
        UNION
        SELECT replay_project_blob_key AS object_key FROM workflow_recordings
        UNION
        SELECT replay_dataset_blob_key AS object_key FROM workflow_recordings WHERE replay_dataset_blob_key IS NOT NULL
      )
      SELECT object_key FROM referenced_objects WHERE object_key = ANY($1::text[])
    `,
    [keys],
  );
  return new Set(result.rows.map((row) => row.object_key));
}

async function runtimeLibraryKeysStillReferenced(client: PoolClient, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const schemaResult = await client.query<{ present: boolean }>(
    "SELECT to_regclass('runtime_library_releases') IS NOT NULL AS present",
  );
  if (!schemaResult.rows[0]?.present) return new Set();
  const result = await client.query<WorkflowReferenceRow>(
    `SELECT artifact_blob_key AS object_key FROM runtime_library_releases WHERE artifact_blob_key = ANY($1::text[])`,
    [keys],
  );
  return new Set(result.rows.map((row) => row.object_key));
}

async function findMissingKeys(
  store: Required<Pick<ManagedWorkflowBlobStore, 'exists'>>,
  keys: string[],
): Promise<string[]> {
  const missing: string[] = [];
  let index = 0;
  const workerCount = Math.min(4, keys.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const nextIndex = index;
        index += 1;
        const key = keys[nextIndex];
        if (!key) return;
        if (!(await store.exists(key))) missing.push(key);
      }
    }),
  );
  return missing;
}

async function upsertFindings(
  client: PoolClient,
  domain: ManagedReconciliationDomain,
  generation: number,
  findings: ReconciliationFinding[],
): Promise<void> {
  for (const finding of findings) {
    await client.query(
      `
        INSERT INTO managed_reconciliation_findings (
          domain, kind, subject_key, last_observed_generation
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (domain, kind, subject_key) DO UPDATE
          SET last_seen_at = NOW(),
              last_observed_generation = EXCLUDED.last_observed_generation,
              resolved_at = NULL
      `,
      [domain, finding.kind, finding.subjectKey, generation],
    );
  }
}

/**
 * A finding becomes durable scan evidence only after its complete generation
 * commits under the maintenance fence. Pages may be retried or interrupted,
 * so updating this count while they are in flight would overstate evidence.
 */
async function markCompletedFindingGenerations(
  client: PoolClient,
  domain: ManagedReconciliationDomain,
  generation: number,
): Promise<void> {
  await client.query(
    `
      UPDATE managed_reconciliation_findings
      SET consecutive_complete_scans = CASE
            WHEN last_observed_generation = $2 THEN
              CASE
                WHEN last_completed_observed_generation = $2 - 1
                  THEN consecutive_complete_scans + 1
                ELSE 1
              END
            ELSE consecutive_complete_scans
          END,
          last_completed_observed_generation = CASE
            WHEN last_observed_generation = $2 THEN $2
            ELSE last_completed_observed_generation
          END
      WHERE domain = $1
    `,
    [domain, generation],
  );
}

async function countOpenFindings(client: PoolClient, domain: ManagedReconciliationDomain): Promise<number> {
  const result = await client.query<OpenFindingCountRow>(
    `SELECT COUNT(*)::text AS count FROM managed_reconciliation_findings WHERE domain = $1 AND resolved_at IS NULL`,
    [domain],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function commitPage(input: {
  completion: boolean;
  domain: ManagedReconciliationDomain;
  expected: ReconciliationStateRow;
  findings: ReconciliationFinding[];
  lease: ManagedWorkflowMaintenanceLease;
  nextCursor: string | null;
  nextPhase: ManagedReconciliationPhase;
  pool: Pool;
}): Promise<{ committed: boolean; completedGeneration: number; openFindings: number }> {
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await input.lease.assertCurrent(client);
    const currentResult = await client.query<ReconciliationStateRow>(
      `
        SELECT domain, phase, cursor, active_generation, completed_generation
        FROM managed_reconciliation_state
        WHERE domain = $1
        FOR UPDATE
      `,
      [input.domain],
    );
    const current = currentResult.rows[0];
    if (!current || !sameState(current, input.expected)) {
      await client.query('ROLLBACK');
      return {
        committed: false,
        completedGeneration: toFiniteInteger(input.expected.completed_generation),
        openFindings: 0,
      };
    }
    const activeGeneration = toFiniteInteger(current.active_generation);
    await upsertFindings(client, input.domain, activeGeneration, input.findings);
    if (input.completion) {
      await markCompletedFindingGenerations(client, input.domain, activeGeneration);
      await client.query(
        `
          UPDATE managed_reconciliation_findings
          SET resolved_at = NOW()
          WHERE domain = $1
            AND resolved_at IS NULL
            AND last_observed_generation < $2
        `,
        [input.domain, activeGeneration],
      );
    }
    await client.query(
      `
        UPDATE managed_reconciliation_state
        SET phase = $2,
            cursor = $3,
            scan_started_at = CASE
              WHEN $4 THEN NULL
              WHEN scan_started_at IS NULL THEN NOW()
              ELSE scan_started_at
            END,
            completed_generation = CASE WHEN $4 THEN active_generation ELSE completed_generation END,
            active_generation = CASE WHEN $4 THEN active_generation + 1 ELSE active_generation END,
            last_completed_at = CASE WHEN $4 THEN NOW() ELSE last_completed_at END,
            last_error_at = NULL,
            last_error_code = NULL,
            updated_at = NOW()
        WHERE domain = $1
      `,
      [input.domain, input.nextPhase, input.nextCursor, input.completion],
    );
    const openFindings = await countOpenFindings(client, input.domain);
    await client.query('COMMIT');
    return {
      committed: true,
      completedGeneration: input.completion ? activeGeneration : toFiniteInteger(current.completed_generation),
      openFindings,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markDomainFailure(
  pool: Pool,
  lease: ManagedWorkflowMaintenanceLease,
  domain: ManagedReconciliationDomain,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lease.assertCurrent(client);
    await client.query(
      `
        UPDATE managed_reconciliation_state
        SET last_error_at = NOW(), last_error_code = 'scan_failed', updated_at = NOW()
        WHERE domain = $1
      `,
      [domain],
    );
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    client.release();
  }
}

async function runObjectBackedDomain(input: {
  domain: 'runtime_libraries' | 'workflows';
  listReferencePage: (
    cursor: string | null,
    pageSize: number,
  ) => Promise<{ keys: string[]; nextCursor: string | null; schemaPresent?: boolean }>;
  recheckReferences: (client: PoolClient, keys: string[]) => Promise<Set<string>>;
  store: ManagedWorkflowBlobStore | undefined;
  lease: ManagedWorkflowMaintenanceLease;
  pageSize: number;
  pool: Pool;
}): Promise<'skipped' | 'success'> {
  if (!hasObjectScanner(input.store)) return 'skipped';
  const state = await ensureState(input.pool, input.domain);
  if (state.phase === 'metadata') {
    const page = await input.listReferencePage(state.cursor, input.pageSize);
    if (page.schemaPresent === false) return 'skipped';
    const missing = await findMissingKeys(input.store, page.keys);
    await commitPage({
      completion: false,
      domain: input.domain,
      expected: state,
      findings: missing.map((subjectKey) => ({ kind: 'missing-referenced-object', subjectKey })),
      lease: input.lease,
      nextCursor: page.nextCursor,
      nextPhase: page.nextCursor == null ? 'objects' : 'metadata',
      pool: input.pool,
    });
    return 'success';
  }

  const page = await input.store.listPage({ cursor: state.cursor ?? undefined, pageSize: input.pageSize });
  const nowMs = Date.now();
  const oldEnoughKeys = page.objects
    .filter(
      (object) =>
        object.lastModified != null &&
        new Date(object.lastModified).getTime() <= nowMs - MIN_UNREFERENCED_OBJECT_AGE_MS,
    )
    .map((object) => object.key);
  const client = await input.pool.connect();
  let referenced = new Set<string>();
  try {
    referenced = await input.recheckReferences(client, oldEnoughKeys);
  } finally {
    client.release();
  }
  const completion = page.nextCursor == null;
  await commitPage({
    completion,
    domain: input.domain,
    expected: state,
    findings: oldEnoughKeys
      .filter((key) => !referenced.has(key))
      .map((subjectKey) => ({ kind: 'unreferenced-object-candidate', subjectKey })),
    lease: input.lease,
    nextCursor: page.nextCursor ?? null,
    nextPhase: completion ? 'metadata' : 'objects',
    pool: input.pool,
  });
  return 'success';
}

async function runEvaluationDomain(input: {
  lease: ManagedWorkflowMaintenanceLease;
  pageSize: number;
  pool: Pool;
}): Promise<'success'> {
  const state = await ensureState(input.pool, 'evaluations');
  const page = await listEvaluationReferencePage(input.pool, state.cursor, input.pageSize);
  const completion = page.nextCursor == null;
  await commitPage({
    completion,
    domain: 'evaluations',
    expected: state,
    findings: page.findings,
    lease: input.lease,
    nextCursor: page.nextCursor,
    nextPhase: 'metadata',
    pool: input.pool,
  });
  return 'success';
}

/**
 * Creates the audit-only reconciliation task that runs under the existing
 * fenced maintenance owner. It never deletes objects, never enqueues the
 * deletion outbox, and treats object listings only as candidates. Deletion is
 * deliberately deferred to a later reviewed maintenance phase.
 */
export function createManagedReconciliationTask(options: {
  pageSize: number;
  pool: Pool;
  runtimeLibrariesBlobStore?: ManagedWorkflowBlobStore;
  workflowBlobStore: ManagedWorkflowBlobStore;
}): ManagedWorkflowMaintenanceTask {
  const requestedPageSize = Number.isFinite(options.pageSize) ? Math.trunc(options.pageSize) : 100;
  const pageSize = Math.max(1, Math.min(requestedPageSize, 500));
  return async (lease) => {
    for (const domain of RECONCILIATION_DOMAINS) {
      const stateBeforePage = await ensureState(options.pool, domain);
      const phase = stateBeforePage.phase;
      try {
        const result =
          domain === 'workflows'
            ? await runObjectBackedDomain({
                domain,
                lease,
                listReferencePage: (cursor, limit) => listWorkflowReferencePage(options.pool, cursor, limit),
                pageSize,
                pool: options.pool,
                recheckReferences: workflowKeysStillReferenced,
                store: options.workflowBlobStore,
              })
            : domain === 'runtime_libraries'
              ? await runObjectBackedDomain({
                  domain,
                  lease,
                  listReferencePage: (cursor, limit) => listRuntimeLibraryReferencePage(options.pool, cursor, limit),
                  pageSize,
                  pool: options.pool,
                  recheckReferences: runtimeLibraryKeysStillReferenced,
                  store: options.runtimeLibrariesBlobStore,
                })
              : await runEvaluationDomain({ lease, pageSize, pool: options.pool });
        recordStudioMetrics((metrics) => metrics.recordManagedReconciliationPage({ domain, outcome: result, phase }));
      } catch {
        await markDomainFailure(options.pool, lease, domain);
        // Do not include raw object keys or provider exceptions in logs: those
        // values can contain tenant data. Operators inspect bounded summaries
        // and authorized database findings instead.
        console.warn(`[managed-reconciliation] ${domain} audit page failed; a later fenced pass will retry.`);
        recordStudioMetrics((metrics) => metrics.recordManagedReconciliationPage({ domain, outcome: 'error', phase }));
      }
      const state = await ensureState(options.pool, domain);
      const client = await options.pool.connect();
      try {
        const openFindings = await countOpenFindings(client, domain);
        recordStudioMetrics((metrics) =>
          metrics.setManagedReconciliationState({
            completedGeneration: toFiniteInteger(state.completed_generation),
            domain,
            openFindings,
          }),
        );
      } finally {
        client.release();
      }
    }
  };
}

/**
 * Operator-facing status intentionally omits raw subject keys. Detailed keys
 * remain in PostgreSQL for an authenticated operator workflow rather than
 * becoming HTTP/Prometheus/log data by accident.
 */
export async function getManagedReconciliationStatus(pool: Pool): Promise<{
  findings: ManagedReconciliationFindingSummary[];
  states: ManagedReconciliationStatus[];
}> {
  const [statesResult, findingsResult, openCountsResult] = await Promise.all([
    pool.query<ReconciliationStatusRow>(`
      SELECT domain, phase, active_generation, completed_generation,
             scan_started_at, last_completed_at, last_error_at, last_error_code
      FROM managed_reconciliation_state
      ORDER BY domain ASC
    `),
    pool.query<
      QueryResultRow & {
        count: string;
        domain: ManagedReconciliationDomain;
        kind: string;
        latest_seen_at: Date | string;
        longest_consecutive_complete_scans: number | string;
        oldest_first_seen_at: Date | string;
        state: 'open' | 'resolved';
      }
    >(`
      SELECT domain,
             kind,
             CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS state,
             COUNT(*)::text AS count,
             MIN(first_seen_at) AS oldest_first_seen_at,
             MAX(last_seen_at) AS latest_seen_at,
             MAX(consecutive_complete_scans) AS longest_consecutive_complete_scans
      FROM managed_reconciliation_findings
      GROUP BY domain, kind, CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END
      ORDER BY domain ASC, kind ASC, state ASC
    `),
    pool.query<OpenFindingCountByDomainRow>(`
      SELECT domain, COUNT(*)::text AS count
      FROM managed_reconciliation_findings
      WHERE resolved_at IS NULL
      GROUP BY domain
    `),
  ]);
  const countByDomain = new Map(openCountsResult.rows.map((row) => [row.domain, Number(row.count)]));
  return {
    states: statesResult.rows.map((state) => ({
      activeGeneration: toFiniteInteger(state.active_generation),
      completedGeneration: toFiniteInteger(state.completed_generation),
      domain: state.domain,
      lastCompletedAt: toIso(state.last_completed_at),
      lastErrorAt: toIso(state.last_error_at),
      lastErrorCode: state.last_error_code,
      openFindingCount: countByDomain.get(state.domain) ?? 0,
      phase: state.phase,
      scanStartedAt: toIso(state.scan_started_at),
    })),
    findings: findingsResult.rows.map((finding) => ({
      count: toFiniteInteger(finding.count),
      domain: finding.domain,
      kind: finding.kind,
      latestSeenAt: toIso(finding.latest_seen_at) ?? new Date(0).toISOString(),
      longestConsecutiveCompleteScans: toFiniteInteger(finding.longest_consecutive_complete_scans),
      oldestFirstSeenAt: toIso(finding.oldest_first_seen_at) ?? new Date(0).toISOString(),
      state: finding.state,
    })),
  };
}
