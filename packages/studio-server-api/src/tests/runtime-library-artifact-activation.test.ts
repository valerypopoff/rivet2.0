import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedRuntimeLibrariesArtifactActivation,
} from '../runtime-libraries/managed/artifact-activation.js';
import { createManagedRuntimeLibrariesJobStore } from '../runtime-libraries/managed/job-store.js';
import type { RuntimeLibraryJobRow } from '../runtime-libraries/managed/schema.js';

type Scenario =
  | 'commit-acknowledgement-lost'
  | 'activation-rolled-back'
  | 'outcome-commit-acknowledgement-lost'
  | 'outcome-unavailable';

type Fixture = ReturnType<typeof createFixture>;

function createJob(status: RuntimeLibraryJobRow['status'] = 'running'): RuntimeLibraryJobRow {
  return {
    job_id: 'job-1',
    type: 'install',
    status,
    packages_json: [],
    error: null,
    claimed_by: 'worker-1',
    created_at: '2026-09-09T00:00:00.000Z',
    started_at: '2026-09-09T00:00:00.000Z',
    finished_at: null,
    progress_at: '2026-09-09T00:00:00.000Z',
    cancel_requested_at: null,
    release_id: null,
  };
}

function queryResult<T>(rows: T[] = []) {
  return { rows, rowCount: rows.length };
}

function createFixture(scenario: Scenario) {
  const state = {
    job: createJob(),
    release: null as null | { releaseId: string; artifactBlobKey: string; artifactSha256: string },
    activeReleaseId: null as string | null,
    uploadedKeys: [] as string[],
    activationTimeoutConfigurations: 0,
    failedJobCalls: 0,
    logs: [] as string[],
    localCacheResets: 0,
    syncCalls: 0,
  };
  let activationConnectionUsed = false;

  const createClient = (role: 'activation' | 'outcome') => ({
    async query(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return queryResult();
      }
      if (sql.startsWith('SELECT set_config')) {
        if (role === 'activation') {
          state.activationTimeoutConfigurations += 1;
        }
        return queryResult();
      }
      if (sql === 'COMMIT') {
        if (role === 'activation' && scenario !== 'activation-rolled-back') {
          if (scenario === 'outcome-unavailable') {
            state.job = createJob('activating');
            state.release = null;
            state.activeReleaseId = null;
            throw new Error('simulated lost COMMIT acknowledgement');
          }
          if (scenario === 'commit-acknowledgement-lost' || scenario === 'outcome-commit-acknowledgement-lost') {
            throw new Error('simulated lost COMMIT acknowledgement');
          }
        }
        if (role === 'outcome' && scenario === 'outcome-commit-acknowledgement-lost') {
          throw new Error('simulated lost outcome COMMIT acknowledgement');
        }
        return queryResult();
      }
      if (sql.includes('FROM runtime_library_jobs AS job')) {
        return queryResult([{
          ...state.job,
          committed_release_id: state.release?.releaseId ?? null,
          committed_artifact_blob_key: state.release?.artifactBlobKey ?? null,
          committed_artifact_sha256: state.release?.artifactSha256 ?? null,
        }]);
      }
      if (sql.includes('FROM runtime_library_jobs') && sql.includes('FOR UPDATE')) {
        return queryResult([state.job]);
      }
      if (sql.includes('INSERT INTO runtime_library_releases')) {
        if (scenario === 'activation-rolled-back') {
          throw new Error('simulated release insert failure');
        }
        state.release = {
          releaseId: params[0] as string,
          artifactBlobKey: params[2] as string,
          artifactSha256: params[3] as string,
        };
        return queryResult();
      }
      if (sql.includes('UPDATE runtime_library_activation')) {
        state.activeReleaseId = params[0] as string;
        return queryResult([{ slot: 'default' }]);
      }
      if (sql.includes("SET status = 'succeeded'")) {
        state.job = {
          ...state.job,
          status: 'succeeded',
          release_id: params[1] as string,
          claimed_by: null,
          cancel_requested_at: null,
        };
        return queryResult([{ job_id: state.job.job_id }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  });

  const context = {
    instanceId: 'worker-1',
    pool: {
      async connect() {
        if (!activationConnectionUsed) {
          activationConnectionUsed = true;
          return createClient('activation');
        }
        if (scenario === 'outcome-unavailable') {
          throw new Error('simulated outcome-resolution database outage');
        }
        return createClient('outcome');
      },
    },
    blobStore: {
      async putBuffer(key: string) {
        state.uploadedKeys.push(key);
      },
    },
    localCache: {
      jobsRoot: () => '/tmp/runtime-library-artifact-activation-test',
      reset: () => {
        state.localCacheResets += 1;
      },
    },
    async syncForLocalUse() {
      state.syncCalls += 1;
    },
  };
  const jobStore = {
    async appendJobLog(_jobId: string, message: string) {
      state.logs.push(message);
    },
    async updateJobStatus(_jobId: string, status: 'validating' | 'activating') {
      state.job = { ...state.job, status };
    },
    async failJob() {
      state.failedJobCalls += 1;
      state.job = { ...state.job, status: 'failed', claimed_by: null };
      return true;
    },
    async throwIfCancellationRequested() {},
    async isCancellationRequested() {
      return false;
    },
  };
  const activation = createManagedRuntimeLibrariesArtifactActivation({
    context: context as never,
    jobStore,
    processRegistry: {
      registerRunningProcess() {},
      terminateRunningProcess() {},
    },
    async buildCandidatePackages() {
      return {};
    },
    async buildReleaseArtifact() {
      return { archiveBuffer: Buffer.from('fixture'), archiveSha256: 'fixture-sha256' };
    },
  });

  return { activation, state };
}

test('a lost activation commit acknowledgement keeps the committed artifact and reports success', async () => {
  const fixture: Fixture = createFixture('commit-acknowledgement-lost');

  const outcome = await fixture.activation.processJob(createJob());

  assert.equal(outcome, 'succeeded');
  assert.equal(fixture.state.job.status, 'succeeded');
  assert.equal(fixture.state.failedJobCalls, 0);
  assert.equal(fixture.state.uploadedKeys.length, 1);
  assert.equal(fixture.state.release?.artifactBlobKey, fixture.state.uploadedKeys[0]);
  assert.equal(fixture.state.activationTimeoutConfigurations, 1);
  assert.equal(fixture.state.localCacheResets, 1);
  assert.equal(fixture.state.syncCalls, 1);
});

test('a lost outcome-resolution commit acknowledgement keeps a proven activation successful', async () => {
  const fixture: Fixture = createFixture('outcome-commit-acknowledgement-lost');

  const outcome = await fixture.activation.processJob(createJob());

  assert.equal(outcome, 'succeeded');
  assert.equal(fixture.state.job.status, 'succeeded');
  assert.equal(fixture.state.failedJobCalls, 0);
  assert.equal(fixture.state.uploadedKeys.length, 1);
  assert.equal(fixture.state.release?.artifactBlobKey, fixture.state.uploadedKeys[0]);
});

test('a rolled-back activation preserves its uploaded artifact for audited cleanup', async () => {
  const fixture: Fixture = createFixture('activation-rolled-back');

  const outcome = await fixture.activation.processJob(createJob());

  assert.equal(outcome, 'failed');
  assert.equal(fixture.state.job.status, 'failed');
  assert.equal(fixture.state.failedJobCalls, 1);
  assert.equal(fixture.state.release, null);
  assert.equal(fixture.state.uploadedKeys.length, 1);
});

test('an unavailable outcome resolver leaves the active job and uploaded artifact untouched', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture: Fixture = createFixture('outcome-unavailable');

  const outcome = await fixture.activation.processJob(createJob());

  assert.equal(outcome, 'unresolved');
  assert.equal(fixture.state.job.status, 'activating');
  assert.equal(fixture.state.failedJobCalls, 0);
  assert.equal(fixture.state.release, null);
  assert.equal(fixture.state.uploadedKeys.length, 1);
});

test('late failure handling cannot overwrite a successful managed runtime-library job', async () => {
  const queries: string[] = [];
  const jobStore = createManagedRuntimeLibrariesJobStore({
    context: {
      instanceId: 'worker-1',
      pool: {
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("SET status = 'failed'")) {
            return queryResult();
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      },
    } as never,
    terminateRunningProcess() {},
  });

  const changed = await jobStore.failJob('job-already-succeeded', new Error('late worker failure'));

  assert.equal(changed, false);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /status IN \('queued', 'running', 'validating', 'activating'\)/);
  assert.match(queries[0], /claimed_by = \$3/);
});

test('a cancellation request that loses the activation race returns the committed success unchanged', async () => {
  let jobReads = 0;
  let terminated = 0;
  const jobStore = createManagedRuntimeLibrariesJobStore({
    context: {
      instanceId: 'worker-1',
      pool: {
        async query(sql: string) {
          if (sql.includes('FROM runtime_library_job_logs')) {
            return queryResult();
          }
          if (sql.includes('FROM runtime_library_jobs')) {
            jobReads += 1;
            return queryResult([jobReads === 1
              ? createJob('activating')
              : { ...createJob('succeeded'), claimed_by: null, release_id: 'release-committed' },
            ]);
          }
          if (sql.includes('SET cancel_requested_at = NOW()')) {
            return queryResult();
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      },
    } as never,
    terminateRunningProcess() {
      terminated += 1;
    },
  });

  const result = await jobStore.cancelJob('job-1');

  assert.equal(result?.status, 'succeeded');
  assert.equal(result?.cancelRequestedAt, undefined);
  assert.equal(terminated, 0);
});
