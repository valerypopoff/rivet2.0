import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFastReleasePolicy,
  assertParallelMigrationVerification,
  assertPinnedProviderHelm,
  assertEarlyHaPolicy,
  readWorkflowConfiguration,
} from './release-workflow-policy.mjs';

const workflows = Object.fromEntries(
  Object.entries({
    images: 'studio-server-images.yml',
    reusable: 'studio-server-ha-scenario.yml',
    verify: 'studio-server-verify.yml',
    publisher: 'studio-server-publish-qualification-images.yml',
    source: 'studio-server-source-contracts.yml',
    build: 'build.yml',
  }).map(([key, file]) => [
    key,
    readWorkflowConfiguration(new URL('../../.github/workflows/' + file, import.meta.url)).workflow,
  ]),
);
const fixture = () => structuredClone(workflows);
const step = (job, name) => {
  const found = job.steps.find((s) => s.name === name);
  assert.ok(found, 'Missing test target: ' + name);
  return found;
};
const removeStep = (job, name) => job.steps.splice(job.steps.indexOf(step(job, name)), 1);
const checkout = (job) => job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));

test('the actual early HA DAG retains native fallback, complete proof and explicit cleanup', () => {
  const { images, reusable } = fixture();
  assert.doesNotThrow(() => assertEarlyHaPolicy(images, reusable));
  for (const mutate of [
    (w, r) => {
      w.jobs['managed-kubernetes-early-upgrade'].needs = ['changes'];
    },
    (w, r) => {
      w.jobs['managed-kubernetes-upgrade'].if = 'always()';
    },
    (w, r) => {
      w.jobs['managed-kubernetes-upgrade'].needs.pop();
    },
    (w, r) => {
      w.jobs['managed-kubernetes-release-gate'].strategy.matrix.scenario.pop();
    },
    (w, r) => {
      w.jobs['managed-kubernetes-early-upgrade'].with.run_managed_disruption = false;
    },
    (w, r) => {
      w.jobs['managed-kubernetes-upgrade'].secrets = 'inherit';
    },
    (w, r) => {
      r.jobs.scenario.env.IMAGE_NAMESPACE = 'other';
    },
    (w, r) => {
      r.jobs.scenario.defaults.run.shell = 'bash';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Admit exact-run candidate').if = 'true';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Admit exact-run candidate').env.RIVET_HA_PHASE = 'prepare';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Delete Disposable Kind Cluster').if = 'success()';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Delete Disposable Kind Cluster').if = '${{ always() }}';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Run HA Kubernetes Gate').env.RIVET_HA_PHASE = 'prepare';
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Validate candidate before use')['continue-on-error'] = true;
    },
    (w, r) => {
      r.jobs.scenario.steps.find((s) => s.name === 'Download admitted candidate release manifest').with[
        'artifact-ids'
      ] = 'old';
    },
    (w, r) => {
      r.jobs.scenario.steps.reverse();
    },
    (w, r) => {
      r.concurrency = { group: 'build-images' };
    },
    (w, r) => {
      w.jobs['managed-kubernetes-ha-evidence'].steps.find(
        (s) => s.name === 'Require every HA scenario and its cleanup',
      ).run = 'echo OK';
    },
  ]) {
    const w = structuredClone(images),
      r = structuredClone(reusable);
    mutate(w, r);
    assert.throws(() => assertEarlyHaPolicy(w, r), String(mutate));
  }
});

test('each provider job must pin Helm before credentials and stop if selection fails', () => {
  const workflow = {
    jobs: Object.fromEntries(
      ['qualified', 'deploy'].map((name) => [
        name,
        {
          steps: [
            { run: 'corepack yarn studio-server:setup:k8s-tools --github-env', 'timeout-minutes': 2 },
            { uses: 'google-github-actions/auth@fixture' },
          ],
        },
      ]),
    ),
  };
  assert.doesNotThrow(() => assertPinnedProviderHelm(workflow));
  for (const name of ['qualified', 'deploy']) {
    for (const change of [
      (s) => s.reverse(),
      (s) => s.shift(),
      (s) => {
        s[0].if = 'false';
      },
      (s) => {
        s[0]['continue-on-error'] = true;
      },
    ]) {
      const broken = structuredClone(workflow);
      change(broken.jobs[name].steps);
      assert.throws(() => assertPinnedProviderHelm(broken));
    }
  }
});

const migrationFixture = () => structuredClone(workflows.verify);

test('the complete migration fixture remains parallel and required after verified compilation', () => {
  assert.doesNotThrow(() => assertParallelMigrationVerification(migrationFixture()));
});

test('migration coverage cannot be skipped, filtered, duplicated, serialized or allowed to fail', () => {
  for (const mutate of [
    (w) => {
      w.jobs['deployment-contracts'].needs.pop();
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy.matrix.lane.splice(1, 1);
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy['max-parallel'] = 3;
    },
    (w) => {
      w.jobs['deployment-contracts'].strategy['fail-fast'] = true;
    },
    (w) => {
      w.jobs['deployment-contracts']['continue-on-error'] = true;
    },
    (w) => {
      step(w.jobs['deployment-contracts'], 'Verify compiled migration runtime').if = 'false';
    },
    (w) => {
      w.jobs['deployment-contracts'].steps.reverse();
    },
    (w) => {
      step(w.jobs['deployment-contracts'], 'Verify VM-to-managed copy, retry, and exact readback').if =
        "matrix.lane == 'managed'";
    },
    (w) => {
      step(w.jobs['deployment-contracts'], 'Verify VM-to-managed copy, retry, and exact readback')[
        'continue-on-error'
      ] = true;
    },
    (w) => {
      step(w.jobs['deployment-contracts'], 'Verify VM-to-managed copy, retry, and exact readback').run +=
        ' --supervised-restore-only';
    },
    (w) => {
      w.jobs['deployment-contracts'].steps.push({ run: 'yarn workspace api run test:migration-managed' });
    },
    (w) => {
      w.jobs.verify.needs = [];
    },
    (w) => {
      w.jobs.verify.if = 'success()';
    },
    (w) => {
      step(w.jobs.verify, 'Require every applicable Studio Server gate')['continue-on-error'] = true;
    },
    (w) => {
      delete step(w.jobs.verify, 'Require every applicable Studio Server gate').env.DEPLOYMENT_RESULT;
    },
    (w) => {
      step(w.jobs.verify, 'Require every applicable Studio Server gate').run = 'echo passed';
    },
    (w) => {
      step(w.jobs.verify, 'Require every applicable Studio Server gate').run = step(
        w.jobs.verify,
        'Require every applicable Studio Server gate',
      ).run.replace('= success', '= success || true');
    },
  ]) {
    const workflow = migrationFixture();
    mutate(workflow);
    assert.throws(() => assertParallelMigrationVerification(workflow), String(mutate));
  }
});

test('parallel build/recovery lanes retain cheap prerequisites and unconditional cleanup', () => {
  assert.doesNotThrow(() => assertFastReleasePolicy(fixture()));
});

test('cold checkout allowance stays distinct from stalled transfers and the source job deadline', () => {
  for (const mutate of [
    (job) => {
      job['timeout-minutes'] = 5;
    },
    (job) => {
      checkout(job)['timeout-minutes'] = 2;
    },
    (job) => {
      delete checkout(job).env.GIT_HTTP_LOW_SPEED_TIME;
    },
    (job) => {
      checkout(job).env.GIT_HTTP_LOW_SPEED_LIMIT = '0';
    },
  ]) {
    const f = fixture();
    mutate(f.source.jobs.source);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
test('failed, skipped or cancelled prerequisites cannot be bypassed by permissive conditions', () => {
  for (const condition of ['always()', 'failure()', 'cancelled()']) {
    for (const [workflow, job] of [
      ['images', 'managed-kubernetes-release-gate'],
      ['verify', 'deployment-command-tests'],
    ]) {
      const f = fixture();
      f[workflow].jobs[job].if = condition;
      assert.throws(() => assertFastReleasePolicy(f), /successful prerequisites/);
    }
  }
});

test('native preparation checks cannot be removed, skipped or allowed to fail', () => {
  const native = 'Verify packaged provider preparation and cleanup before expensive work';
  const tools = 'Install native provider test tools';
  for (const mutate of [
    (job) => removeStep(job, native),
    (job) => {
      step(job, native).if = 'false';
    },
    (job) => {
      step(job, native)['continue-on-error'] = true;
    },
    (job) => {
      step(job, tools).env.KUBECTL_VERSION = 'latest';
    },
    (job) => {
      step(job, tools).run = 'download without checksums';
    },
    (job) => {
      step(job, tools).run = 'sha256sum -c -';
    },
  ]) {
    const f = fixture();
    mutate(f.source.jobs.source);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
test('removing source/scan barriers, losing cleanup or reserializing expensive work is rejected', () => {
  for (const mutate of [
    (f) => (f.images.jobs['build-and-push'].needs = []),
    (f) => (f.publisher.jobs.publish.needs = []),
    (f) => (step(f.publisher.jobs.publish, 'Configure cache builder with classic-store output').with.driver = 'docker'),
    (f) => (f.images.jobs['managed-kubernetes-release-gate'].needs = []),
    (f) => f.images.jobs['build-and-push'].needs.push('verify-repository'),
    (f) => delete step(f.verify.jobs.verify, 'Require every applicable Studio Server gate').env.SOURCE_RESULT,
  ]) {
    const f = fixture();
    // Use an array for the mutation that adds a dependency.
    f.images.jobs['build-and-push'].needs = ['source-contracts'];
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});

test('deployment command coverage and failure results are mandatory after splitting the jobs', () => {
  for (const mutate of [
    (f) => (f.verify.jobs['deployment-command-tests'].needs = ['changes', 'build-studio-server']),
    (f) => (f.verify.jobs['deployment-command-tests'].if = 'false'),
    (f) => (f.verify.jobs['deployment-command-tests']['continue-on-error'] = true),
    (f) => (step(f.verify.jobs['deployment-command-tests'], 'Run deployment command journeys').if = 'false'),
    (f) =>
      (step(f.verify.jobs['deployment-command-tests'], 'Run deployment command journeys')['continue-on-error'] = true),
    (f) =>
      (step(f.verify.jobs['deployment-command-tests'], 'Run deployment command journeys').run +=
        ' --test-name-pattern=smoke'),
    (f) => (f.verify.jobs.verify.needs = ['source-contracts']),
    (f) =>
      delete step(f.verify.jobs.verify, 'Require every applicable Studio Server gate').env.DEPLOYMENT_COMMAND_RESULT,
    (f) =>
      (step(f.verify.jobs.verify, 'Require every applicable Studio Server gate').run =
        'test "$SOURCE_RESULT" = success'),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});

test('early image scans remain mandatory and their evidence must match the final manifest', () => {
  for (const mutate of [
    (f) => removeStep(f.images.jobs['build-and-push'], 'Scan every published architecture immediately'),
    (f) => {
      step(f.images.jobs['build-and-push'], 'Scan every published architecture immediately').if = 'false';
    },
    (f) => {
      step(f.images.jobs['build-and-push'], 'Scan every published architecture immediately')['continue-on-error'] =
        true;
    },
    (f) => {
      step(f.images.jobs['scan-images'], 'Verify every scanned digest and architecture').if = 'false';
    },
    (f) => {
      step(f.images.jobs['scan-images'], 'Verify every scanned digest and architecture')['continue-on-error'] = true;
    },
    (f) => {
      step(f.images.jobs['scan-images'], 'Verify every scanned digest and architecture').run = 'echo passed';
    },
    (f) => {
      step(f.images.jobs['scan-images'], 'Download component scan evidence').with.name = 'previous-run';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertFastReleasePolicy(f));
  }
});
