import assert from 'node:assert/strict';
import test from 'node:test';

import { configureStudioMetrics, getStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';
import { InMemoryManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import {
  createManagedReconciliationTask,
  getManagedReconciliationStatus,
} from '../routes/workflows/managed/reconciliation.js';

const domains = ['workflows', 'runtime_libraries', 'evaluations'] as const;
type Domain = (typeof domains)[number];
type State = {
  active_generation: number;
  active_object_bytes: number;
  completed_generation: number;
  cursor: string | null;
  domain: Domain;
  last_completed_object_bytes: number;
  phase: 'metadata' | 'objects';
};
type Finding = {
  consecutive: number;
  domain: Domain;
  generation: number;
  lastCompletedGeneration: number | null;
  kind: string;
  resolved: boolean;
  subject: string;
};

function createReconciliationPool() {
  const states = new Map<Domain, State>();
  const findings = new Map<string, Finding>();
  const deleted: string[] = [];
  const workflowReferences = ['missing/project.rivet-project', 'present/project.rivet-project'];
  let staleNextCommit = false;

  const ensure = (domain: Domain): State => {
    const existing = states.get(domain);
    if (existing) return existing;
    const created: State = {
      active_generation: 1,
      active_object_bytes: 0,
      completed_generation: 0,
      cursor: null,
      domain,
      last_completed_object_bytes: 0,
      phase: 'metadata',
    };
    states.set(domain, created);
    return created;
  };

  const query = async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes('INSERT INTO managed_reconciliation_state')) {
      ensure(parameters[0] as Domain);
      return { rows: [] };
    }
    if (sql.includes('FROM managed_reconciliation_state') && sql.includes('WHERE domain = $1')) {
      const state = ensure(parameters[0] as Domain);
      if (sql.includes('FOR UPDATE') && staleNextCommit) {
        staleNextCommit = false;
        return { rows: [{ ...state, cursor: 'newer-page' }] };
      }
      return { rows: [state] };
    }
    if (sql.includes("to_regclass('runtime_library_releases')")) {
      return { rows: [{ present: false }] };
    }
    if (sql.includes('FROM evaluation_recordings AS recording')) {
      return { rows: [] };
    }
    if (sql.includes('WITH referenced_objects') && sql.includes('ORDER BY object_key')) {
      const cursor = parameters[0] as string | null;
      const keys = workflowReferences.filter((key) => cursor == null || key > cursor).slice(0, parameters[1] as number);
      return { rows: keys.map((object_key) => ({ object_key })) };
    }
    if (sql.includes('WITH referenced_objects') && sql.includes('ANY($1::text[])')) {
      const keys = parameters[0] as string[];
      return {
        rows: keys
          .filter((object_key) => workflowReferences.includes(object_key))
          .map((object_key) => ({ object_key })),
      };
    }
    if (sql.includes('INSERT INTO managed_reconciliation_findings')) {
      const [domain, kind, subject, generation] = parameters as [Domain, string, string, number];
      const key = `${domain}\u0000${kind}\u0000${subject}`;
      const current = findings.get(key);
      findings.set(key, {
        consecutive: current?.consecutive ?? 0,
        domain,
        generation,
        kind,
        lastCompletedGeneration: current?.lastCompletedGeneration ?? null,
        resolved: false,
        subject,
      });
      return { rows: [] };
    }
    if (sql.includes('SET consecutive_complete_scans = CASE')) {
      const [domain, generation] = parameters as [Domain, number];
      for (const finding of findings.values()) {
        if (finding.domain !== domain || finding.generation !== generation) continue;
        finding.consecutive = finding.lastCompletedGeneration === generation - 1 ? finding.consecutive + 1 : 1;
        finding.lastCompletedGeneration = generation;
      }
      return { rows: [] };
    }
    if (sql.includes('SET resolved_at = NOW()')) {
      const [domain, generation] = parameters as [Domain, number];
      for (const finding of findings.values()) {
        if (finding.domain === domain && finding.generation < generation) finding.resolved = true;
      }
      return { rows: [] };
    }
    if (sql.includes('UPDATE managed_reconciliation_state') && sql.includes('SET phase = $2')) {
      const [domain, phase, cursor, completion, scannedObjectBytes] = parameters as [
        Domain,
        State['phase'],
        string | null,
        boolean,
        number,
      ];
      const state = ensure(domain);
      state.phase = phase;
      state.cursor = cursor;
      if (completion) {
        state.last_completed_object_bytes = state.active_object_bytes + scannedObjectBytes;
        state.active_object_bytes = 0;
        state.completed_generation = state.active_generation;
        state.active_generation += 1;
      } else {
        state.active_object_bytes += scannedObjectBytes;
      }
      return { rows: [] };
    }
    if (sql.includes('UPDATE managed_reconciliation_state') && sql.includes("last_error_code = 'scan_failed'")) {
      return { rows: [] };
    }
    if (sql.includes('COUNT(*)::text AS count')) {
      const domain = parameters[0] as Domain;
      return {
        rows: [
          {
            count: String(
              [...findings.values()].filter((finding) => finding.domain === domain && !finding.resolved).length,
            ),
          },
        ],
      };
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql.trim())) return { rows: [] };
    throw new Error(`Unexpected reconciliation test query: ${sql}`);
  };

  const pool = {
    connect: async () => ({ query, release: () => {} }),
    query,
  } as never;
  const workflowBlobStore = {
    getText: async () => '',
    putText: async () => {},
    delete: async (key: string) => {
      deleted.push(key);
    },
    exists: async (key: string) => key === 'present/project.rivet-project',
    listPage: async () => ({
      objects: [
        {
          key: 'orphan/old.rivet-project',
          lastModified: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
          size: 42,
        },
      ],
    }),
  };
  return {
    deleted,
    findings,
    makeNextCommitStale: () => {
      staleNextCommit = true;
    },
    pool,
    states,
    workflowBlobStore,
  };
}

test('managed reconciliation is bounded, reports missing and two-pass orphan evidence, and never deletes objects', async () => {
  const driver = createReconciliationPool();
  const task = createManagedReconciliationTask({
    pageSize: 100,
    pool: driver.pool,
    workflowBlobStore: driver.workflowBlobStore,
  });
  const lease = { assertCurrent: async () => {}, fencingToken: 1, holderId: 'test' };

  // Metadata and object scans alternate. A finding observed during metadata
  // is still provisional until the object phase commits that generation.
  await task(lease);
  const provisionalMissing = [...driver.findings.values()].find(
    (finding) => finding.kind === 'missing-referenced-object',
  );
  assert.equal(provisionalMissing?.consecutive, 0);

  // Two completed object scans are the earliest point a later deletion policy
  // may even consider this candidate.
  await task(lease);
  await task(lease);
  await task(lease);

  assert.deepEqual(driver.deleted, []);
  const byKind = [...driver.findings.values()].map((finding) => [finding.kind, finding] as const);
  const missing = byKind.find(([kind]) => kind === 'missing-referenced-object')?.[1];
  const orphan = byKind.find(([kind]) => kind === 'unreferenced-object-candidate')?.[1];
  assert.equal(missing?.consecutive, 2);
  assert.equal(orphan?.consecutive, 2);
  assert.equal(orphan?.resolved, false);
  assert.equal(
    driver.states.get('workflows')?.last_completed_object_bytes,
    42,
    'only the completed object-prefix page contributes its returned inventory size',
  );
  assert.equal(driver.states.get('workflows')?.active_object_bytes, 0);
});
test('managed reconciliation status is aggregate-only and never selects raw object keys', async () => {

  const queries: string[] = [];
  const pool = {
    query: async (sql: string, parameters: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes('FROM managed_reconciliation_state')) {
        return {
          rows: [
            {
              domain: 'workflows',
              phase: 'objects',
              active_generation: 3,
              active_object_bytes: 420,
              completed_generation: 2,
              last_completed_object_bytes: 84,
              scan_started_at: '2026-08-30T12:00:00.000Z',
              last_completed_at: '2026-08-30T11:59:00.000Z',
              last_error_at: null,
              last_error_code: null,
            },
            {
              domain: 'evaluations',
              phase: 'metadata',
              active_generation: 1,
              active_object_bytes: 0,
              completed_generation: 0,
              last_completed_object_bytes: 0,
              scan_started_at: null,
              last_completed_at: null,
              last_error_at: null,
              last_error_code: null,
            },
          ],
        };
      }
      if (sql.includes('GROUP BY domain, kind')) {
        return {
          rows: [
            {
              domain: 'workflows',
              kind: 'missing-referenced-object',
              state: 'open',
              count: '2',
              oldest_first_seen_at: '2026-08-29T12:00:00.000Z',
              latest_seen_at: '2026-08-30T11:59:00.000Z',
              longest_consecutive_complete_scans: '2',
            },
          ],
        };
      }
      if (sql.includes('WHERE resolved_at IS NULL') && sql.includes('GROUP BY domain')) {
        return { rows: [{ domain: 'workflows', count: '2' }] };
      }
      throw new Error(`Unexpected reconciliation status query: ${sql}`);
    },
  } as never;

  const status = await getManagedReconciliationStatus(pool);

  assert.deepEqual(status.findings, [
    {
      count: 2,
      domain: 'workflows',
      kind: 'missing-referenced-object',
      latestSeenAt: '2026-08-30T11:59:00.000Z',
      longestConsecutiveCompleteScans: 2,
      oldestFirstSeenAt: '2026-08-29T12:00:00.000Z',
      state: 'open',
    },
  ]);
  assert.equal(status.states.find((state) => state.domain === 'workflows')?.openFindingCount, 2);
  assert.equal(status.states.find((state) => state.domain === 'workflows')?.activeObjectBytes, 420);
  assert.equal(status.states.find((state) => state.domain === 'workflows')?.lastCompletedObjectBytes, 84);
  assert.equal(status.states.find((state) => state.domain === 'workflows')?.scanStatus, 'running');
  assert.equal(status.states.find((state) => state.domain === 'evaluations')?.scanStatus, 'not-started');
  assert.deepEqual(
    status.states.find((state) => state.domain === 'runtime_libraries'),
    {
      activeGeneration: 1,
      activeObjectBytes: 0,
      completedGeneration: 0,
      domain: 'runtime_libraries',
      lastCompletedAt: null,
      lastCompletedObjectBytes: 0,
      lastErrorAt: null,
      lastErrorCode: null,
      openFindingCount: 0,
      phase: 'metadata',
      scanStartedAt: null,
      scanStatus: 'not-started',
    },
    'fresh databases report every reconciliation domain without creating state rows',
  );
  assert.equal(
    queries.some((sql) => /subject_key/i.test(sql)),
    false,
    'operator status must aggregate findings without reading raw object identifiers',
  );
});
test('evaluation reconciliation recovers from a malformed persisted cursor', async () => {
  const driver = createReconciliationPool();
  const task = createManagedReconciliationTask({
    pageSize: 100,
    pool: driver.pool,
    workflowBlobStore: driver.workflowBlobStore,
  });
  const lease = { assertCurrent: async () => {}, fencingToken: 1, holderId: 'test' };

  await task(lease);
  const state = driver.states.get('evaluations');
  assert.ok(state);
  state.cursor = '{not-json';

  await task(lease);

  assert.equal(state.cursor, null);
  assert.equal(state.completed_generation, 2);
});
test('a stale fenced reconciliation page does not advance durable byte accounting or successful metrics', async () => {
  resetStudioMetricsForTests();
  configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  const driver = createReconciliationPool();
  const task = createManagedReconciliationTask({
    pageSize: 100,
    pool: driver.pool,
    workflowBlobStore: driver.workflowBlobStore,
  });
  const lease = { assertCurrent: async () => {}, fencingToken: 1, holderId: 'test' };

  try {
    await task(lease); // Complete the workflow metadata half of the generation.
    driver.makeNextCommitStale();
    await task(lease); // The object listing is observed but its fenced commit loses the race.

    assert.equal(driver.states.get('workflows')?.active_object_bytes, 0);
    assert.equal(driver.states.get('workflows')?.last_completed_object_bytes, 0);
    const rendered = getStudioMetrics().render();
    assert.doesNotMatch(
      rendered,
      /rivet_managed_reconciliation_scanned_object_bytes_total\{domain="workflows",outcome="skipped",phase="objects",profile="control"\}/,
    );
    assert.doesNotMatch(
      rendered,
      /rivet_managed_reconciliation_scanned_object_bytes_total\{domain="workflows",outcome="success",phase="objects",profile="control"\}/,
    );
  } finally {
    resetStudioMetricsForTests();
  }
});
test('in-memory reconciliation pages do not invent a terminal cursor', async () => {
  const store = new InMemoryManagedWorkflowBlobStore();
  await store.putText('a', 'one');
  await store.putText('b', 'two');

  const completePage = await store.listPage({ pageSize: 2 });
  assert.deepEqual(
    completePage.objects.map((object) => object.key),
    ['a', 'b'],
  );
  assert.equal(completePage.nextCursor, undefined);

  const staleCursorPage = await store.listPage({ cursor: 'z', pageSize: 1 });
  assert.deepEqual(staleCursorPage.objects, []);
  assert.equal(staleCursorPage.nextCursor, undefined);
});
test('object reconciliation treats an empty marker cursor as a continuation', async () => {
  const driver = createReconciliationPool();
  const cursors: Array<string | undefined> = [];
  let objectPage = 0;
  const workflowBlobStore = {
    ...driver.workflowBlobStore,
    listPage: async (input: { cursor?: string; pageSize: number }) => {
      cursors.push(input.cursor);
      objectPage += 1;
      return objectPage === 1 ? { objects: [], nextCursor: '' } : { objects: [] };
    },
  };
  const task = createManagedReconciliationTask({
    pageSize: 100,
    pool: driver.pool,
    workflowBlobStore,
  });
  const lease = { assertCurrent: async () => {}, fencingToken: 1, holderId: 'test' };

  await task(lease); // workflow metadata
  await task(lease); // prefix marker page: still in the object phase

  assert.deepEqual(cursors, [undefined]);
  assert.equal(driver.states.get('workflows')?.completed_generation, 0);

  await task(lease); // terminal object page

  assert.deepEqual(cursors, [undefined, '']);
  assert.equal(driver.states.get('workflows')?.completed_generation, 1);
});
