import assert from 'node:assert/strict';
import test from 'node:test';
import { runOperator } from './qualification-operator.mjs';

const sha = 'e'.repeat(40),
  stepName = 'Run approved provider operation and compile evidence after cleanup';
function fixture(options = {}) {
  let time = Date.parse('2026-11-07T00:00:00Z'),
    dispatched = false,
    polls = 0;
  const scope = {
    approved: true,
    operationId: 'local-simulation',
    sourceSha: sha,
    actorId: 1234,
    applicationBuildRunId: 1001,
    toolingRunId: 1002,
    requestSha256: 'a'.repeat(64),
    allowanceUsd: 30,
    testSeconds: 7200,
    attempts: 1,
    deployProduction: false,
    latestTestStart: '2026-11-07T00:10:00Z',
    cleanupDeadline: '2026-11-07T03:10:00Z',
  };
  const records = new Map(),
    writes = [],
    events = [];
  const flags = new Map(
    ['actions/variables', 'environments/rivet-managed-staging/variables'].map((prefix) => [
      prefix + '/RIVET_AUTOMATED_QUALIFICATION_ENABLED',
      { name: 'RIVET_AUTOMATED_QUALIFICATION_ENABLED', value: 'false', updated_at: 'old' },
    ]),
  );
  const run = () => ({
    id: 71,
    head_sha: sha,
    run_attempt: 1,
    workflow_id: 9,
    event: 'workflow_dispatch',
    actor: { id: 1234 },
    head_branch: 'main',
    created_at: options.laterRun ? '2026-11-07T00:05:00Z' : '2026-11-07T00:00:01Z',
    status: polls >= 3 ? 'completed' : 'in_progress',
    conclusion: polls >= 3 ? (options.earlyFailure ? 'failure' : 'success') : null,
  });
  let interruptedClose = false,
    failedRead = false;
  const store = {
    async exists(name) {
      return records.has(name);
    },
    async read(name) {
      assert.ok(records.has(name), name + ' missing');
      return structuredClone(records.get(name));
    },
    async create(name, value) {
      if (options.interruptClose && !interruptedClose && name === 'ADMISSION-CLOSE-0-ACK.private.json') {
        interruptedClose = true;
        throw Error('Simulated closure interruption');
      }
      assert.ok(!records.has(name), name + ' already exists');
      records.set(name, structuredClone(value));
    },
    async update(name, value) {
      records.set(name, structuredClone(value));
    },
  };
  const api = async (method, resource, body) => {
    events.push({ method, resource });
    if (method === 'PATCH') {
      writes.push({ method, resource, body });
      if (
        options.transientEnable &&
        resource.startsWith('actions/') &&
        body.value === 'true' &&
        writes.filter((w) => w.resource === resource && w.body.value === 'true').length === 1
      )
        return { status: 500, value: { message: 'Internal Server Error' }, diagnostics: { requestId: 'ABCD:1234' } };
      if (options.partialEnable && resource.startsWith('environments/') && body.value === 'true')
        return { status: 502 };
      if (options.rejectClose && body.value === 'false') return { status: 502 };
      flags.set(resource, { ...flags.get(resource), value: body.value, updated_at: String(time++) });
      if (options.uncertainAppliedClose && resource.startsWith('actions/') && body.value === 'false')
        return { status: 502 };
      return { status: 204 };
    }
    if (method === 'POST') {
      assert.ok(
        [...flags.values()].every((flag) => flag.value === 'true'),
        'Dispatch requires both enabled flags',
      );
      writes.push({ method, resource, body });
      dispatched = true;
      if (options.interruptPost) throw Error('Simulated operator interruption');
      return { status: options.uncertainPost ? 502 : 204 };
    }
    assert.equal(method, 'GET');
    if (flags.has(resource)) return { status: 200, value: structuredClone(flags.get(resource)) };
    if (resource.endsWith('RIVET_QUALIFICATION_MAX_USD')) return { status: 200, value: { value: '30' } };
    if (resource.endsWith('RIVET_QUALIFICATION_MAX_SECONDS')) return { status: 200, value: { value: '7200' } };
    if (resource === 'git/ref/heads/main') {
      if (options.readFailure && !failedRead) {
        failedRead = true;
        throw options.readFailure;
      }
      return { status: 200, value: { object: { sha: options.mainAdvances && dispatched ? 'f'.repeat(40) : sha } } };
    }
    if (resource === 'actions/workflows/studio-server-qualify-release.yml') return { status: 200, value: { id: 9 } };
    if (resource.includes('/runs?') && options.olderActive && resource.includes('status=queued'))
      return { status: 200, value: { total_count: 1, workflow_runs: [{ id: 8, status: 'queued' }] } };
    if (
      resource.includes('/runs?') &&
      options.competingOnRecovery &&
      writes.length &&
      resource.includes('status=queued')
    )
      return { status: 200, value: { total_count: 1, workflow_runs: [{ id: 8, status: 'queued' }] } };
    if (resource.includes('/runs?'))
      return {
        status: 200,
        value: {
          total_count: dispatched ? 1 : 0,
          workflow_runs:
            dispatched && !options.hiddenRun ? (options.ambiguous ? [run(), { ...run(), id: 72 }] : [run()]) : [],
        },
      };
    if (resource === 'actions/runs/71') {
      polls++;
      if (options.interruptMonitor && polls === 1) throw Error('Simulated operator interruption');
      return { status: 200, value: run() };
    }
    if (resource.startsWith('actions/runs/71/jobs?'))
      return {
        status: 200,
        value: {
          total_count: 1,
          jobs: [
            {
              name: options.earlyFailure ? 'Built' : 'Staging — observe candidate and verify cleanup',
              conclusion: options.earlyFailure && polls >= 3 ? 'failure' : null,
              steps: options.earlyFailure ? [] : [{ name: stepName, status: polls >= 2 ? 'in_progress' : 'queued' }],
            },
          ],
        },
      };
    throw Error('Unexpected fake resource: ' + resource);
  };
  return {
    scope,
    store,
    api,
    records,
    writes,
    flags,
    events,
    now: () => time,
    sleep: async () => {
      time += 1000;
    },
    preflight: async () => ({
      activationReady: !options.blockedPreflight,
      sourceSha: sha,
      applicationBuildRunId: scope.applicationBuildRunId,
      toolingRunId: scope.toolingRunId,
    }),
    progress: () => {},
    discoveryPolls: 2,
  };
}

test('the whole command enables both flags, dispatches once, waits for capture and closes both', async () => {
  const f = fixture();
  const result = await runOperator(f);
  assert.equal(result.conclusion, 'success');
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  assert.deepEqual(
    f.writes.map((w) => w.method),
    ['PATCH', 'PATCH', 'POST', 'PATCH', 'PATCH'],
  );
  assert.ok([...f.flags.values()].every((flag) => flag.value === 'false'));
  assert.ok(f.records.has('OPERATOR-COMPLETED.private.json'));
});
test('blocked preflight performs no mutation', async () => {
  const f = fixture({ blockedPreflight: true });
  await assert.rejects(runOperator(f), /preflight/i);
  assert.equal(f.writes.length, 0);
});
test('partial enable cannot dispatch or replay activation', async () => {
  const f = fixture({ partialEnable: true });
  await assert.rejects(runOperator(f), /Uncertain/);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 0);
  const count = f.writes.length;
  await assert.rejects(runOperator(f), /intent|existing/i);
  assert.equal(f.writes.length, count);
});
test('uncertain dispatch observes the existing run without repeating POST', async () => {
  const f = fixture({ uncertainPost: true });
  assert.equal((await runOperator(f)).runId, 71);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
});
test('interrupted dispatch resumes discovery and monitoring without re-enabling or posting', async () => {
  const f = fixture({ interruptPost: true });
  await assert.rejects(runOperator(f), /interruption/);
  const before = f.writes.length;
  const result = await runOperator({ ...f, observeOnly: true });
  assert.equal(result.runId, 71);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  assert.equal(f.writes.slice(before).filter((w) => w.body.value === 'true').length, 0);
});
test('interrupted monitor resumes the bound run and closes admission', async () => {
  const f = fixture({ interruptMonitor: true });
  await assert.rejects(runOperator(f), /interruption/);
  assert.equal((await runOperator({ ...f, observeOnly: true })).conclusion, 'success');
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
});
test('interruption after the first close write observes it and closes only the untouched scope', async () => {
  const f = fixture({ interruptClose: true });
  await assert.rejects(runOperator(f), /closure interruption/);
  const result = await runOperator({ ...f, observeOnly: true });
  assert.equal(result.conclusion, 'success');
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  for (const resource of f.flags.keys())
    assert.equal(f.writes.filter((w) => w.resource === resource && w.body.value === 'false').length, 1);
});
test('an uncertain applied close is confirmed by readback without replay', async () => {
  const f = fixture({ uncertainAppliedClose: true });
  assert.equal((await runOperator(f)).conclusion, 'success');
  for (const resource of f.flags.keys())
    assert.equal(f.writes.filter((w) => w.resource === resource && w.body.value === 'false').length, 1);
});
test('an uncertain close still reading true cannot replay its command', async () => {
  const f = fixture({ rejectClose: true });
  await assert.rejects(runOperator(f), /Uncertain/);
  const count = f.writes.length;
  await assert.rejects(runOperator({ ...f, observeOnly: true }), /recovery exhausted/);
  assert.equal(f.writes.length, count);
});
test('preflight for another candidate cannot authorize this dispatch', async () => {
  const f = fixture();
  await assert.rejects(
    runOperator({ ...f, preflight: async () => ({ activationReady: true, sourceSha: 'f'.repeat(40) }) }),
    /Preflight binding/,
  );
  assert.equal(f.writes.length, 0);
});
test('early failure closes admission without waiting for an execution step', async () => {
  const f = fixture({ earlyFailure: true });
  assert.equal((await runOperator(f)).conclusion, 'failure');
  assert.ok([...f.flags.values()].every((flag) => flag.value === 'false'));
});
test('unobserved or ambiguous dispatch outcomes never produce another POST', async () => {
  for (const options of [{ hiddenRun: true }, { ambiguous: true }]) {
    const f = fixture(options);
    await assert.rejects(runOperator(f), /observ|ambiguous/i);
    await assert.rejects(runOperator({ ...f, observeOnly: true }), /observ|ambiguous/i);
    assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  }
});
test('observation cannot attach to a much later same-source run', async () => {
  const f = fixture({ laterRun: true });
  await assert.rejects(runOperator(f), /not observed/);
  await assert.rejects(runOperator({ ...f, observeOnly: true }), /not observed/);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  assert.ok(!f.records.has('OPERATOR-RUN.private.json'));
});
test('an older queued run outside the latest-history page blocks activation', async () => {
  const f = fixture({ olderActive: true });
  await assert.rejects(runOperator(f), /active/);
  assert.equal(f.writes.length, 0);
});
test('a truncated JSON read or read timeout is retried without replaying dispatch', async () => {
  for (const readFailure of [
    new SyntaxError('Truncated response'),
    new DOMException('Read timed out', 'TimeoutError'),
  ]) {
    const f = fixture({ readFailure });
    assert.equal((await runOperator(f)).conclusion, 'success');
    assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  }
});
test('closed, expired or altered approval cannot activate', async () => {
  for (const kind of ['closed', 'expired', 'production']) {
    const f = fixture();
    if (kind === 'closed') await f.store.create('CAMPAIGN-CLOSED.private.json', { closed: true });
    if (kind === 'expired') f.scope.latestTestStart = '2026-11-06T00:00:00Z';
    if (kind === 'production') f.scope.deployProduction = true;
    await assert.rejects(runOperator(f));
    assert.equal(f.writes.length, 0);
  }
});

test('authorized admission recovery retries one flag and dispatches exactly once', async () => {
  const f = fixture({ transientEnable: true });
  f.scope.admissionRecovery = { maxAttempts: 2, deadline: '2026-11-07T00:01:00Z' };
  assert.equal((await runOperator(f)).conclusion, 'success');
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
  assert.equal(
    f.writes.filter((w) => w.method === 'PATCH' && w.resource.startsWith('actions/') && w.body.value === 'true').length,
    2,
  );
  assert.equal(f.records.get('ADMISSION-ENABLE-0-ACK.private.json').requestId, 'ABCD:1234');
});
test('without retry permission a 500 never dispatches or replays', async () => {
  const f = fixture({ transientEnable: true });
  await assert.rejects(runOperator(f), /recovery exhausted/);
  assert.equal(f.writes.filter((w) => w.method === 'PATCH').length, 1);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 0);
});

test('main advancing after dispatch cannot prevent closing the owned admission flags', async () => {
  const f = fixture({ mainAdvances: true });
  assert.equal((await runOperator(f)).conclusion, 'success');
  assert.ok([...f.flags.values()].every((flag) => flag.value === 'false'));
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 1);
});

test('a competing release discovered during recovery prevents another PATCH or dispatch', async () => {
  const f = fixture({ transientEnable: true, competingOnRecovery: true });
  f.scope.admissionRecovery = { maxAttempts: 2, deadline: '2026-11-07T00:01:00Z' };
  await assert.rejects(runOperator(f), /Another release is active/);
  assert.equal(f.writes.filter((w) => w.method === 'PATCH').length, 1);
  assert.equal(f.writes.filter((w) => w.method === 'POST').length, 0);
});
