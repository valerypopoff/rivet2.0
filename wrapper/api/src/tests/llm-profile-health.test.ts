import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Pool } from 'pg';

import type {
  RivetLLMProfileCircuitBreakerPolicy,
  RivetLLMProfileHealthIdentity,
} from '@valerypopoff/rivet2-node';

import { createApiApp } from '../app.js';
import { getExpectedProxyAuthToken } from '../auth.js';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';
import { PostgresRivetLLMProfileHealthStore } from '../llm-profile-health/managed-store.js';
import {
  beginLLMProfileHealthAttempt,
  finishLLMProfileHealthAttempt,
  LLM_PROFILE_CLOSED_PERMIT_RETENTION_FLOOR_MS,
  renewLLMProfileHealthPermit,
} from '../llm-profile-health/state.js';
import {
  createHttpLLMProfileHealthAdminProvider,
  createHttpRivetLLMProfileHealthStore,
} from '../../../shared/llmProfileHealthHttpStore.js';
import {
  disposeWorkflowStorage,
  getLLMProfileHealthStore,
} from '../routes/workflows/storage-backend.js';

const policy: RivetLLMProfileCircuitBreakerPolicy = {
  failureThreshold: 2,
  failureWindowMs: 1_000,
  openDurationMs: 10,
  halfOpenLeaseMs: 100,
};

function identity(key: string, projectId = 'project-a'): RivetLLMProfileHealthIdentity {
  return {
    key,
    projectId: projectId as never,
    profileNodeId: 'profile-node' as never,
    provider: 'custom',
    model: 'fast-model',
    customProviderApi: 'completions',
    configurationFingerprint: 'sha256:configuration',
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type FakeManagedHealthRow = {
  key: string;
  projectId: string | null;
  entryJson: unknown;
  updatedAt: number;
};

class FakeManagedHealthPool {
  readonly rows = new Map<string, FakeManagedHealthRow>();
  readonly queries: string[] = [];

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push(normalized);
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [] as T[], rowCount: null };
    }

    if (normalized.startsWith('select (extract(epoch from clock_timestamp()) * 1000)::bigint as now_ms')) {
      return { rows: [{ now_ms: Date.now() } as T], rowCount: 1 };
    }

    if (normalized.startsWith('select pg_advisory_xact_lock(')) {
      return { rows: [] as T[], rowCount: 1 };
    }

    if (normalized.startsWith('insert into llm_profile_health')) {
      const key = String(values[0]);
      if (!this.rows.has(key)) {
        this.rows.set(key, { key, projectId: null, entryJson: null, updatedAt: Date.now() });
      }
      return { rows: [] as T[], rowCount: 1 };
    }

    if (normalized.startsWith('select key, entry_json from llm_profile_health where key = $1 for update')) {
      const row = this.rows.get(String(values[0]));
      return {
        rows: row == null ? [] as T[] : [{ key: row.key, entry_json: row.entryJson } as T],
        rowCount: row == null ? 0 : 1,
      };
    }

    if (normalized.startsWith('update llm_profile_health set project_id')) {
      const row = this.rows.get(String(values[0]));
      if (row != null) {
        row.projectId = values[1] == null ? null : String(values[1]);
        row.entryJson = JSON.parse(String(values[2]));
        row.updatedAt = Number(values[3]);
      }
      return { rows: [] as T[], rowCount: row == null ? 0 : 1 };
    }

    if (normalized.startsWith('delete from llm_profile_health where project_id = $1 and key = $2')) {
      const row = this.rows.get(String(values[1]));
      const deleted = row?.projectId === String(values[0]) && this.rows.delete(row.key);
      return { rows: [] as T[], rowCount: deleted ? 1 : 0 };
    }

    if (normalized.startsWith('delete from llm_profile_health where project_id = $1')) {
      let deleted = 0;
      for (const row of this.rows.values()) {
        if (row.projectId === String(values[0]) && this.rows.delete(row.key)) deleted += 1;
      }
      return { rows: [] as T[], rowCount: deleted };
    }

    if (normalized.startsWith('delete from llm_profile_health where key = $1')) {
      const deleted = this.rows.delete(String(values[0]));
      return { rows: [] as T[], rowCount: deleted ? 1 : 0 };
    }

    if (normalized.startsWith('select key, entry_json from llm_profile_health where entry_json is not null')) {
      const projectId = normalized.includes('and project_id = $1') ? String(values[0]) : undefined;
      const rows = [...this.rows.values()]
        .filter((row) => row.entryJson != null && (projectId == null || row.projectId === projectId))
        .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
        .map((row) => ({ key: row.key, entry_json: row.entryJson }) as T);
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Unexpected fake Postgres query: ${normalized}`);
  }
}

test('health transitions track closed permits, renew only the owning probe, and ignore stale completions', () => {
  const healthIdentity = identity('profile-key');
  const first = beginLLMProfileHealthAttempt(null, { identity: healthIdentity, policy }, 1_000);
  assert.equal(first.result.state, 'closed');
  assert.ok(first.result.permitId);

  const firstFailure = finishLLMProfileHealthAttempt(first.entry, {
    identity: healthIdentity,
    policy,
    permitId: first.result.permitId!,
    outcome: 'unhealthy',
  }, 1_001);
  assert.equal(firstFailure.snapshot.failureCount, 1);

  const second = beginLLMProfileHealthAttempt(firstFailure.entry, { identity: healthIdentity, policy }, 1_002);
  const opened = finishLLMProfileHealthAttempt(second.entry, {
    identity: healthIdentity,
    policy,
    permitId: second.result.permitId!,
    outcome: 'unhealthy',
  }, 1_003);
  assert.equal(opened.snapshot.state, 'open');

  const probe = beginLLMProfileHealthAttempt(opened.entry, { identity: healthIdentity, policy }, 1_014);
  assert.equal(probe.result.state, 'half-open');
  const leaseBeforeRenewal = probe.result.snapshot.halfOpenLeaseUntil!;
  const staleRenewal = renewLLMProfileHealthPermit(probe.entry, {
    identity: healthIdentity,
    permitId: 'not-the-probe',
    leaseDurationMs: 1_000,
  }, 1_015);
  assert.equal(staleRenewal.snapshot.halfOpenLeaseUntil, leaseBeforeRenewal);

  const renewed = renewLLMProfileHealthPermit(staleRenewal.entry, {
    identity: healthIdentity,
    permitId: probe.result.permitId!,
    leaseDurationMs: 1_000,
  }, 1_016);
  assert.equal(renewed.snapshot.halfOpenLeaseUntil, 2_016);

  const recovered = finishLLMProfileHealthAttempt(renewed.entry, {
    identity: healthIdentity,
    policy,
    permitId: probe.result.permitId!,
    outcome: 'healthy',
  }, 1_017);
  assert.equal(recovered.snapshot.state, 'closed');
  assert.equal(recovered.snapshot.failureCount, 0);

  const staleFinish = finishLLMProfileHealthAttempt(null, {
    identity: healthIdentity,
    policy,
    permitId: probe.result.permitId!,
    outcome: 'unhealthy',
  }, 1_018);
  assert.equal(staleFinish.entry, null);
  assert.equal(staleFinish.snapshot.failureCount, 0);
});

test('permit renewal is monotonic, refreshes closed attempts, and recovery invalidates pre-open attempts', () => {
  const healthIdentity = identity('renew-and-recovery-key');
  const first = beginLLMProfileHealthAttempt(null, { identity: healthIdentity, policy }, 1_000);
  const second = beginLLMProfileHealthAttempt(first.entry, { identity: healthIdentity, policy }, 1_001);
  const late = beginLLMProfileHealthAttempt(second.entry, { identity: healthIdentity, policy }, 1_002);
  const originalClosedExpiry = late.entry.closedPermits[late.result.permitId!];
  const refreshedClosed = renewLLMProfileHealthPermit(late.entry, {
    identity: healthIdentity,
    permitId: late.result.permitId!,
    leaseDurationMs: 1,
  }, 2_000);
  assert.ok(refreshedClosed.entry!.closedPermits[late.result.permitId!] > originalClosedExpiry);

  const firstFailure = finishLLMProfileHealthAttempt(refreshedClosed.entry, {
    identity: healthIdentity,
    policy,
    permitId: first.result.permitId!,
    outcome: 'unhealthy',
  }, 2_001);
  const opened = finishLLMProfileHealthAttempt(firstFailure.entry, {
    identity: healthIdentity,
    policy,
    permitId: second.result.permitId!,
    outcome: 'unhealthy',
  }, 2_002);
  const probe = beginLLMProfileHealthAttempt(opened.entry, { identity: healthIdentity, policy }, 2_013);
  const originalLease = probe.result.snapshot.halfOpenLeaseUntil!;
  const shorterRenewal = renewLLMProfileHealthPermit(probe.entry, {
    identity: healthIdentity,
    permitId: probe.result.permitId!,
    leaseDurationMs: 1,
  }, 2_014);
  assert.equal(shorterRenewal.snapshot.halfOpenLeaseUntil, originalLease);

  const recovered = finishLLMProfileHealthAttempt(shorterRenewal.entry, {
    identity: healthIdentity,
    policy,
    permitId: probe.result.permitId!,
    outcome: 'healthy',
  }, 2_015);
  assert.deepEqual(recovered.entry?.closedPermits, {});

  const stalePreOpenFailure = finishLLMProfileHealthAttempt(recovered.entry, {
    identity: healthIdentity,
    policy,
    permitId: late.result.permitId!,
    outcome: 'unhealthy',
  }, 2_016);
  assert.equal(stalePreOpenFailure.snapshot.state, 'closed');
  assert.equal(stalePreOpenFailure.snapshot.failureCount, 0);
});

test('an existing health key cannot be rebound to a different project', () => {
  const originalIdentity = identity('project-bound-key', 'project-a');
  const existing = beginLLMProfileHealthAttempt(null, { identity: originalIdentity, policy }, 1_000);
  assert.throws(
    () => beginLLMProfileHealthAttempt(existing.entry, {
      identity: identity(originalIdentity.key, 'project-b'),
      policy,
    }, 1_001),
    /belongs to a different project scope/,
  );
  assert.equal(existing.entry.identity.projectId, originalIdentity.projectId);
});

test('durable health stores reject unscoped runtime identities', async () => {
  const unscopedIdentity = { ...identity('unscoped-key'), projectId: undefined };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-llm-health-scope-'));
  const filesystem = new FilesystemRivetLLMProfileHealthStore(path.join(tempRoot, 'health.sqlite'));
  const managed = new PostgresRivetLLMProfileHealthStore(new FakeManagedHealthPool() as unknown as Pool);

  try {
    await assert.rejects(
      async () => filesystem.begin({ identity: unscopedIdentity, policy }),
      /require a projectId/,
    );
    await assert.rejects(
      async () => managed.begin({ identity: unscopedIdentity, policy }),
      /require a projectId/,
    );
  } finally {
    await filesystem.dispose();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('a late closed failure cannot extend an already-open circuit', () => {
  const healthIdentity = identity('profile-key');
  const first = beginLLMProfileHealthAttempt(null, { identity: healthIdentity, policy }, 1_000);
  const second = beginLLMProfileHealthAttempt(first.entry, { identity: healthIdentity, policy }, 1_001);
  const late = beginLLMProfileHealthAttempt(second.entry, { identity: healthIdentity, policy }, 1_002);
  const oneFailure = finishLLMProfileHealthAttempt(late.entry, {
    identity: healthIdentity,
    policy,
    permitId: first.result.permitId!,
    outcome: 'unhealthy',
  }, 1_003);
  const opened = finishLLMProfileHealthAttempt(oneFailure.entry, {
    identity: healthIdentity,
    policy,
    permitId: second.result.permitId!,
    outcome: 'unhealthy',
  }, 1_004);
  const originalOpenUntil = opened.snapshot.openUntil;
  const lateFailure = finishLLMProfileHealthAttempt(opened.entry, {
    identity: healthIdentity,
    policy,
    permitId: late.result.permitId!,
    outcome: 'unhealthy',
  }, 1_005);

  assert.equal(lateFailure.snapshot.state, 'open');
  assert.equal(lateFailure.snapshot.openUntil, originalOpenUntil);
});

test('abandoned closed permits expire without letting a stale finish mutate health', () => {
  const healthIdentity = identity('abandoned-permit-key');
  const abandoned = beginLLMProfileHealthAttempt(null, { identity: healthIdentity, policy }, 1_000);
  const abandonedPermitId = abandoned.result.permitId!;
  const afterRetention = 1_000 + LLM_PROFILE_CLOSED_PERMIT_RETENTION_FLOOR_MS + 1;
  const current = beginLLMProfileHealthAttempt(
    abandoned.entry,
    { identity: healthIdentity, policy },
    afterRetention,
  );

  assert.deepEqual(Object.keys(current.entry.closedPermits), [current.result.permitId]);

  const staleFinish = finishLLMProfileHealthAttempt(current.entry, {
    identity: healthIdentity,
    policy,
    permitId: abandonedPermitId,
    outcome: 'unhealthy',
  }, afterRetention + 1);
  assert.equal(staleFinish.snapshot.failureCount, 0);
  assert.equal(staleFinish.snapshot.state, 'closed');
});

test('filesystem health store serializes half-open probes and resets exact projects without resurrection', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-llm-health-'));
  const store = new FilesystemRivetLLMProfileHealthStore(path.join(tempRoot, 'health.sqlite'));
  const healthIdentity = identity('profile-key');
  const neighboringIdentity = identity('profile-key-neighbor', 'project-aa');

  try {
    for (let index = 0; index < policy.failureThreshold; index += 1) {
      const attempt = await store.begin({ identity: healthIdentity, policy });
      await store.finish({
        identity: healthIdentity,
        policy,
        permitId: attempt.permitId!,
        outcome: 'unhealthy',
      });
    }
    const neighboringAttempt = await store.begin({ identity: neighboringIdentity, policy });
    await store.finish({
      identity: neighboringIdentity,
      policy,
      permitId: neighboringAttempt.permitId!,
      outcome: 'healthy',
    });

    await delay(policy.openDurationMs + 5);
    const probes = await Promise.all([
      store.begin({ identity: healthIdentity, policy }),
      store.begin({ identity: healthIdentity, policy }),
    ]);
    assert.equal(probes.filter((probe) => probe.disposition === 'allow').length, 1);
    assert.equal(probes.filter((probe) => probe.disposition === 'deny').length, 1);

    await assert.rejects(
      store.begin({ identity: identity(healthIdentity.key, 'project-b'), policy }),
      /belongs to a different project scope/,
    );

    const allowedProbe = probes.find((probe) => probe.disposition === 'allow')!;
    const renewed = await store.renew({
      identity: healthIdentity,
      permitId: allowedProbe.permitId!,
      leaseDurationMs: 5_000,
    });
    assert.ok(renewed.halfOpenLeaseUntil! > Date.now());

    assert.equal((await store.list({ projectId: 'project-a' as never })).length, 1);
    assert.equal((await store.list({ projectId: 'project-aa' as never })).length, 1);
    assert.equal(await store.resetProjectKey('project-aa' as never, healthIdentity.key), false);
    assert.equal((await store.list({ projectId: 'project-a' as never })).length, 1);
    await store.reset({ projectId: 'project-a' as never });
    assert.equal((await store.list({ projectId: 'project-a' as never })).length, 0);
    assert.equal((await store.list({ projectId: 'project-aa' as never })).length, 1);

    await store.finish({
      identity: healthIdentity,
      policy,
      permitId: allowedProbe.permitId!,
      outcome: 'unhealthy',
    });
    assert.equal((await store.list({ projectId: 'project-a' as never })).length, 0);
  } finally {
    await store.dispose();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('managed health store preserves transition, lease, project, and reset semantics', async () => {
  const pool = new FakeManagedHealthPool();
  const store = new PostgresRivetLLMProfileHealthStore(pool as unknown as Pool);
  const healthIdentity = identity('managed-profile-key');
  const neighboringIdentity = identity('managed-neighbor-key', 'project-aa');

  const first = await store.begin({ identity: healthIdentity, policy });
  const second = await store.begin({ identity: healthIdentity, policy });
  const late = await store.begin({ identity: healthIdentity, policy });
  await store.finish({
    identity: healthIdentity,
    policy,
    permitId: first.permitId!,
    outcome: 'unhealthy',
  });
  const opened = await store.finish({
    identity: healthIdentity,
    policy,
    permitId: second.permitId!,
    outcome: 'unhealthy',
  });
  const originalOpenUntil = opened.openUntil;
  const lateFailure = await store.finish({
    identity: healthIdentity,
    policy,
    permitId: late.permitId!,
    outcome: 'unhealthy',
  });
  assert.equal(lateFailure.openUntil, originalOpenUntil);

  const neighbor = await store.begin({ identity: neighboringIdentity, policy });
  await store.finish({
    identity: neighboringIdentity,
    policy,
    permitId: neighbor.permitId!,
    outcome: 'healthy',
  });

  await delay(policy.openDurationMs + 5);
  const probe = await store.begin({ identity: healthIdentity, policy });
  assert.equal(probe.state, 'half-open');
  const denied = await store.begin({ identity: healthIdentity, policy });
  assert.equal(denied.disposition, 'deny');
  await assert.rejects(
    store.begin({ identity: identity(healthIdentity.key, 'project-b'), policy }),
    /belongs to a different project scope/,
  );
  const renewed = await store.renew({
    identity: healthIdentity,
    permitId: probe.permitId!,
    leaseDurationMs: 5_000,
  });
  assert.ok(renewed.halfOpenLeaseUntil! > Date.now());

  assert.equal((await store.list({ projectId: 'project-a' as never })).length, 1);
  assert.equal((await store.list({ projectId: 'project-aa' as never })).length, 1);
  await store.reset({ projectId: 'project-a' as never });
  assert.equal((await store.list({ projectId: 'project-a' as never })).length, 0);
  assert.equal((await store.list({ projectId: 'project-aa' as never })).length, 1);

  await store.finish({
    identity: healthIdentity,
    policy,
    permitId: probe.permitId!,
    outcome: 'unhealthy',
  });
  assert.equal((await store.list({ projectId: 'project-a' as never })).length, 0);
  assert.ok(
    pool.queries.some((query) => query.startsWith('select pg_advisory_xact_lock(')),
    'managed transitions and project resets must share the project advisory lock',
  );
});

test('HTTP health clients preserve runtime requests and scope administration by project', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    if (url.includes('projectId=')) return Response.json([]);
    if (url.endsWith('/reset')) return new Response(null, { status: 204 });
    if (url.endsWith('/begin')) {
      const request = JSON.parse(String(init.body));
      return Response.json({
        disposition: 'allow',
        state: 'closed',
        permitId: 'permit',
        snapshot: { identity: request.identity, state: 'closed', failureCount: 0, updatedAt: 1 },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const baseUrl = 'https://rivet.example/api/workflows/llm-profile-health/';
  const store = createHttpRivetLLMProfileHealthStore({ baseUrl, fetch: fetchMock });
  const admin = createHttpLLMProfileHealthAdminProvider({ baseUrl, fetch: fetchMock });

  const healthIdentity = identity('profile-key');
  await store.begin({ identity: healthIdentity, policy });
  await admin.list({ projectId: 'project a' as never });
  await admin.reset({ projectId: 'project a' as never });

  await assert.rejects(() => Promise.resolve(store.list()), /requires a projectId/);
  await assert.rejects(
    () => Promise.resolve(store.reset({ key: healthIdentity.key })),
    /requires a projectId/,
  );

  assert.equal(requests[0]?.url, 'https://rivet.example/api/workflows/llm-profile-health/begin');
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), { identity: healthIdentity, policy });
  assert.equal(requests[1]?.url, 'https://rivet.example/api/workflows/llm-profile-health/?projectId=project%20a');
  assert.deepEqual(JSON.parse(String(requests[2]?.init.body)), { projectId: 'project a' });
});

test('authenticated health API scopes resets by exact project and rejects caller timestamps', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-llm-health-api-'));
  const previousAppDataRoot = process.env.RIVET_APP_DATA_ROOT;
  const previousKey = process.env.RIVET_KEY;
  process.env.RIVET_APP_DATA_ROOT = tempRoot;
  process.env.RIVET_KEY = 'llm-health-api-test-key';

  const server = http.createServer(createApiApp('control'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/workflows/llm-profile-health`;
  const headers = {
    'content-type': 'application/json',
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  };
  const healthIdentity = identity('api-profile-key');

  try {
    assert.equal(
      await getLLMProfileHealthStore(),
      await getLLMProfileHealthStore(),
      'workflow runs must reuse the backend-owned health store',
    );

    const unauthorized = await fetch(`${baseUrl}/`);
    assert.equal(unauthorized.status, 403);

    const callerTimestamp = await fetch(`${baseUrl}/begin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ identity: healthIdentity, policy, now: 1 }),
    });
    assert.equal(callerTimestamp.status, 400);

    const unscopedBegin = await fetch(`${baseUrl}/begin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identity: { ...healthIdentity, projectId: undefined },
        policy,
      }),
    });
    assert.equal(unscopedBegin.status, 400);

    const unscopedList = await fetch(`${baseUrl}/`, { headers });
    assert.equal(unscopedList.status, 400);

    const unscopedReset = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: healthIdentity.key }),
    });
    assert.equal(unscopedReset.status, 400);

    const beginResponse = await fetch(`${baseUrl}/begin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ identity: healthIdentity, policy }),
    });
    assert.equal(beginResponse.status, 200);
    const begin = await beginResponse.json() as { permitId: string };

    const wrongProjectReset = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'project-aa', key: healthIdentity.key }),
    });
    assert.equal(wrongProjectReset.status, 404);

    const projectEntries = await fetch(`${baseUrl}/?projectId=project-a`, { headers });
    assert.equal(projectEntries.status, 200);
    assert.equal((await projectEntries.json() as unknown[]).length, 1);

    const resetResponse = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'project-a' }),
    });
    assert.equal(resetResponse.status, 204);

    const lateFinish = await fetch(`${baseUrl}/finish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identity: healthIdentity,
        policy,
        permitId: begin.permitId,
        outcome: 'unhealthy',
      }),
    });
    assert.equal(lateFinish.status, 200);
    assert.equal((await lateFinish.json() as { failureCount: number }).failureCount, 0);

    const emptyProjectEntries = await fetch(`${baseUrl}/?projectId=project-a`, { headers });
    assert.equal((await emptyProjectEntries.json() as unknown[]).length, 0);
  } finally {
    server.close();
    await once(server, 'close');
    await disposeWorkflowStorage();
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (previousAppDataRoot == null) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousAppDataRoot;
    if (previousKey == null) delete process.env.RIVET_KEY;
    else process.env.RIVET_KEY = previousKey;
  }
});
