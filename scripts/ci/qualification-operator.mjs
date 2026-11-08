import assert from 'node:assert/strict';
import { inspectAdmission, setAdmission, canCloseAdmission } from './qualification-admission.mjs';
import { githubFailureDetails } from './qualification-github-api.mjs';

const workflow = 'studio-server-qualify-release.yml';
const workflowPath = 'actions/workflows/' + workflow;
const transient = new Set([429, 500, 502, 503, 504]);

// Only reads are repeated. This also covers truncated error responses and
// AbortSignal.timeout failures from the existing GitHub transport.
export const createOperatorApi = (api, sleep) => async (method, resource, body) => {
  for (let pass = 0; ; pass++) {
    let response;
    try {
      response = await api(method, resource, body);
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        ['TimeoutError', 'AbortError'].includes(error.name) ||
        ['ECONNRESET', 'ETIMEDOUT'].includes(error.code);
      if (method !== 'GET' || pass >= 2 || !retryable) throw error;
      await sleep(500 * (pass + 1));
      continue;
    }
    if (method !== 'GET' || pass >= 2 || !transient.has(response.status)) return response;
    await sleep(500 * (pass + 1));
  }
};

// Query active states directly: a queued/waiting run can be older than the
// latest history page. Pagination visits active runs, not the whole history.
export async function activeReleaseRuns(get) {
  const results = await Promise.allSettled(
    ['in_progress', 'queued', 'requested', 'waiting', 'pending'].map(async (status) => {
      const runs = [];
      for (let page = 1; ; page++) {
        const value = await get(`${workflowPath}/runs?status=${status}&per_page=100&page=${page}`);
        assert.ok(value.total_count < 1000, 'Active run search exceeds provider limit');
        runs.push(...value.workflow_runs);
        if (runs.length >= value.total_count) return runs;
        assert.ok(value.workflow_runs.length, 'Incomplete active run inventory');
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return [
    ...new Map(
      results
        .flatMap((result) => result.value)
        .filter((run) => run.status !== 'completed')
        .map((run) => [run.id, run]),
    ).values(),
  ];
}

export async function runOperator({
  api,
  store,
  scope,
  preflight,
  now = Date.now,
  sleep,
  progress = () => {},
  observeOnly = false,
  discoveryPolls = 12,
}) {
  const stamp = () => new Date(now()).toISOString();
  const limits = { allowanceUsd: scope.allowanceUsd, testSeconds: scope.testSeconds };
  const persist = (name, value) => store.create(name, { at: stamp(), ...value });
  const request = createOperatorApi(api, sleep);
  const get = async (resource) => {
    const response = await request('GET', resource);
    assert.equal(response.status, 200, 'Required operator read failed: ' + resource);
    return response.value;
  };
  const listRuns = async () => (await get(workflowPath + '/runs?per_page=100')).workflow_runs;
  const assertNoOtherRun = (runs) =>
    assert.ok(
      runs.every((run) => run.status === 'completed'),
      'Another release is active',
    );
  const ownership = { operationId: scope.operationId, sourceSha: scope.sourceSha, requestSha256: scope.requestSha256 };
  const setFlags = (enabled) =>
    setAdmission({
      api: request,
      persist,
      limits,
      enabled,
      store,
      ownership,
      now,
      sleep,
      recovery: enabled ? scope.admissionRecovery ?? { maxAttempts: 1 } : { maxAttempts: 1 },
      checkOwnership: async () => {
        assert.ok(!(await store.exists('CAMPAIGN-CLOSED.private.json')), 'Campaign is closed');
        assert.ok(
          now() < Date.parse(enabled ? scope.latestTestStart : scope.cleanupDeadline),
          'Admission window expired',
        );
        assert.deepEqual((await store.read('OPERATOR-INTENT.private.json')).scope, scope, 'Operation scope changed');
        if (enabled) {
          assert.equal((await get('git/ref/heads/main')).object.sha, scope.sourceSha, 'Main changed');
          assert.ok(!(await store.exists('DISPATCH-COMMAND-INTENT.private.json')), 'Dispatch may already exist');
          if (scope.admissionRecovery?.deadline)
            assert.ok(Date.parse(scope.admissionRecovery.deadline) <= Date.parse(scope.latestTestStart));
        }
        assertNoOtherRun((await activeReleaseRuns(get)).filter((run) => !(!enabled && run.id === binding?.runId)));
      },
    });
  let dispatchWindow;
  const assertRun = (run, intent) => {
    assert.equal(run.head_sha, scope.sourceSha);
    assert.equal(run.run_attempt, 1);
    assert.equal(run.workflow_id, intent.workflowId);
    assert.equal(run.event, 'workflow_dispatch');
    assert.equal(run.head_branch, 'main');
    assert.equal(Number(run.actor?.id), scope.actorId);
    const created = Date.parse(run.created_at);
    assert.ok(
      dispatchWindow && created >= dispatchWindow.start - 5000 && created <= dispatchWindow.end,
      'Run is outside the recorded dispatch window',
    );
  };
  assert.equal(scope.approved, true);
  assert.equal(scope.attempts, 1);
  assert.equal(scope.deployProduction, false);
  assert.match(scope.sourceSha, /^[a-f0-9]{40}$/);
  for (const value of [scope.actorId, scope.applicationBuildRunId, scope.toolingRunId])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.ok(
    scope.operationId &&
      Number.isFinite(Date.parse(scope.latestTestStart)) &&
      Number.isFinite(Date.parse(scope.cleanupDeadline)),
  );
  assert.ok(now() < Date.parse(scope.cleanupDeadline), 'Observation/cleanup window expired');
  assert.ok(!(await store.exists('CAMPAIGN-CLOSED.private.json')), 'Campaign is closed');

  let intent;
  if (!observeOnly) {
    assert.ok(
      !(await store.exists('OPERATOR-INTENT.private.json')),
      'Existing activation intent; resume observation only',
    );
    assert.ok(now() < Date.parse(scope.latestTestStart), 'Activation window expired');
    const report = await preflight();
    assert.equal(report.activationReady, true, 'Consolidated preflight is not ready');
    for (const key of ['sourceSha', 'applicationBuildRunId', 'toolingRunId'])
      assert.equal(report[key], scope[key], 'Preflight binding differs from approval: ' + key);
    const flags = await inspectAdmission(request, limits);
    assert.ok(
      flags.every((flag) => flag.value === 'false'),
      'Admission must initially be closed',
    );
    assert.equal((await get('git/ref/heads/main')).object.sha, scope.sourceSha);
    const info = await get(workflowPath),
      before = await listRuns();
    assertNoOtherRun(await activeReleaseRuns(get));
    intent = {
      scope: structuredClone(scope),
      workflowId: info.id,
      previousRunIds: before.map((run) => run.id),
      inputs: {
        build_run_id: String(scope.applicationBuildRunId),
        tooling_run_id: scope.toolingRunId === scope.applicationBuildRunId ? '' : String(scope.toolingRunId),
        deploy_production: 'false',
        production_preflight_only: 'false',
      },
    };
    await persist('OPERATOR-INTENT.private.json', intent);
    await setFlags(true);
    assert.equal((await get('git/ref/heads/main')).object.sha, scope.sourceSha);
    assertNoOtherRun(await activeReleaseRuns(get));
    assert.ok(now() < Date.parse(scope.latestTestStart), 'Activation expired before dispatch');
    await persist('DISPATCH-COMMAND-INTENT.private.json', {
      workflowId: info.id,
      inputs: intent.inputs,
      createdBefore: new Date(Math.min(Date.parse(scope.latestTestStart), now() + 60000)).toISOString(),
    });
    const response = await request('POST', workflowPath + '/dispatches', { ref: 'main', inputs: intent.inputs });
    await persist('DISPATCH-ACK.private.json', githubFailureDetails(response));
    // A non-204 response can still have created a run. Discover/observe it; never POST again.
  } else {
    intent = await store.read('OPERATOR-INTENT.private.json');
    assert.deepEqual(intent.scope, scope, 'Operation scope changed');
    assert.ok(
      await store.exists('DISPATCH-COMMAND-INTENT.private.json'),
      'No dispatch command may have been issued; inspect partial activation',
    );
    assert.equal((await store.read('ADMISSION-ENABLED.private.json')).enabled, true);
  }
  intent = await store.read('OPERATOR-INTENT.private.json');
  const command = await store.read('DISPATCH-COMMAND-INTENT.private.json');
  assert.deepEqual(command.inputs, intent.inputs);
  assert.equal(command.workflowId, intent.workflowId);
  const issuedAt = Date.parse(command.at);
  const createdBefore = Date.parse(command.createdBefore);
  assert.ok(Number.isFinite(issuedAt) && createdBefore >= issuedAt && createdBefore <= issuedAt + 60000);
  dispatchWindow = { start: issuedAt, end: createdBefore };

  let binding;
  if (await store.exists('OPERATOR-RUN.private.json')) binding = await store.read('OPERATOR-RUN.private.json');
  else {
    for (let pass = 0; pass < discoveryPolls; pass++) {
      assert.ok(now() < Date.parse(scope.cleanupDeadline), 'Observation window expired');
      const matching = (await listRuns()).filter(
        (run) =>
          !intent.previousRunIds.includes(run.id) &&
          run.head_sha === scope.sourceSha &&
          run.event === 'workflow_dispatch' &&
          Number(run.actor?.id) === scope.actorId &&
          run.head_branch === 'main' &&
          Date.parse(run.created_at) >= issuedAt - 5000 &&
          Date.parse(run.created_at) <= createdBefore,
      );
      assert.ok(matching.length <= 1, 'Ambiguous dispatch; inspect without replay');
      if (matching.length) {
        assertRun(matching[0], intent);
        binding = { runId: matching[0].id, sourceSha: scope.sourceSha, workflowId: intent.workflowId };
        await persist('OPERATOR-RUN.private.json', binding);
        break;
      }
      if (pass + 1 < discoveryPolls) await sleep(5000);
    }
    assert.ok(binding, 'Dispatched run not observed; resume observation only, never redispatch');
  }
  assert.equal(binding.sourceSha, scope.sourceSha);
  assert.equal(binding.workflowId, intent.workflowId);
  let signature;
  for (;;) {
    assert.ok(now() < Date.parse(scope.cleanupDeadline), 'Observation/cleanup window expired');
    const run = await get('actions/runs/' + binding.runId);
    assert.equal(run.id, binding.runId);
    assertRun(run, intent);
    const jobs = [];
    for (let page = 1; ; page++) {
      assert.ok(page <= 10, 'Unexpected jobs inventory');
      const value = await get(`actions/runs/${binding.runId}/jobs?per_page=100&page=${page}`);
      jobs.push(...value.jobs);
      if (jobs.length >= value.total_count) break;
      assert.ok(value.jobs.length, 'Incomplete jobs inventory');
    }
    await store.update('OPERATOR-LATEST.private.json', {
      at: stamp(),
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      jobs,
    });
    if (canCloseAdmission(run, jobs)) {
      if (!(await store.exists('ADMISSION-CLOSED.private.json'))) {
        const others = (await activeReleaseRuns(get)).filter((other) => other.id !== run.id);
        assertNoOtherRun(others);
        await setFlags(false);
      }
      assert.ok(
        (await inspectAdmission(request, limits)).every((flag) => flag.value === 'false'),
        'Admission reopened; inspect',
      );
    }
    const snapshot = {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      admissionClosed: await store.exists('ADMISSION-CLOSED.private.json'),
      jobs: jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        step: job.steps?.find((step) => step.status === 'in_progress')?.name,
      })),
    };
    if (JSON.stringify(snapshot) !== signature) {
      progress(snapshot);
      signature = JSON.stringify(snapshot);
    }
    if (run.status === 'completed') {
      const result = {
        runId: run.id,
        conclusion: run.conclusion,
        admissionClosed: snapshot.admissionClosed,
        productionEnabled: false,
        qualificationEvidenceStillRequiresVerification: true,
      };
      if (!(await store.exists('OPERATOR-COMPLETED.private.json')))
        await persist('OPERATOR-COMPLETED.private.json', result);
      else assert.deepEqual((({ at, ...rest }) => rest)(await store.read('OPERATOR-COMPLETED.private.json')), result);
      return result;
    }
    await sleep(30000);
  }
}
