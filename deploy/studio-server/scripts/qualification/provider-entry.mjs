import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ReusableProviderGate, root, until } from './provider-gate.mjs';
import { FixtureJournal } from './fixture-journal.mjs';
import { runProviderAutoscaling } from './provider-autoscaling.mjs';
import { runProviderProxyHpa, processStartTicks } from './provider-proxy-hpa.mjs';
import { createKubernetesTransport } from '../lib/execution-autoscaler-kubernetes.mjs';
import { ReusableStagingState, reusableStagingSettings } from '../lib/reusable-staging-state.mjs';
import { stagingCloudReader } from '../lib/reusable-staging-cloud.mjs';
import {
  observeStagingInventory,
  settleStaging,
  cleanupStaging,
  verifyStagingCleanup,
} from '../lib/reusable-staging-cleanup.mjs';
import { runOrdinaryRuntimeUpgrade, waitForOrdinaryRuntime } from '../lib/runtime-upgrade-qualification.mjs';
import { HaReleaseProbes } from '../lib/ha-release-probes.mjs';
import { assertReleaseManifestMatchesCurrentChart } from '../lib/studio-server-release-manifest.mjs';
import { qualificationHash } from '../lib/runtime-qualification-execution.mjs';
import { startHaWorkflowTraffic, startHaWebAppTraffic } from '../lib/ha-workflow-traffic.mjs';
import { waitForManagedGateCommands } from '../kubernetes-managed-release-gate.mjs';

export function normalizeProviderAutoscaling(raw, hpa) {
  const result = (name) => {
    const phase = raw.phases.find((p) => p.name === name);
    assert.ok(phase);
    return phase.result;
  };
  const drain = result('long-work-retirement-restart-serialization-and-returning-demand');
  const acceptedWorkRecorded = raw.accepted.some((r) =>
    r.responses?.some(
      (response) => response.correlationId === drain.longCorrelation && r.recordings?.[response.correlationId],
    ),
  );
  assert.equal(acceptedWorkRecorded, true);
  return {
    ...raw,
    drain: { ...drain, acceptedWorkRecorded },
    metrics: result('missing-and-stale-metrics-never-mean-idle'),
    proxyHpa: { ...hpa, readyUids: hpa.scaleUpObservation.readyUids },
  };
}

/** No phase is resumable by rerunning it. A failed phase leaves its intent and
 * owned state for settlement/inspection, never another seed or execution POST. */
export async function executeProviderPhase({
  phase,
  operation,
  state,
  cloud,
  actor,
  gate,
  privateDirectory,
  wait = until,
}) {
  const bind = (result) => ({
    ...result,
    protocol: 1,
    ...Object.fromEntries(['operationId', 'inputHash', 'projectId', 'projectNumber'].map((k) => [k, operation[k]])),
  });
  if (phase === 'armExpiry') {
    await cloud.project();
    await gate.verifyLocalBrowserFixture();
    await gate.verifySharedPrerequisites();
    return bind(await state.arm(actor));
  }
  if (phase === 'settle') {
    const inventory = await settleStaging(state, cloud, actor, wait);
    return bind({ writersStopped: true, acceptedWorkSettled: true, inventoryComplete: true, inventory });
  }
  if (phase === 'cleanup') {
    await cleanupStaging(state, actor);
    return bind({ deletionDispatched: true });
  }
  if (phase === 'verifyCleanup') {
    const result = await wait('exact namespace/CSI/NEG garbage collection', () => verifyStagingCleanup(state, cloud));
    return bind(result);
  }
  await state.admission();
  await state.change((r) => {
    r.testPhases ??= {};
    assert.ok(!r.testPhases[phase], 'Never replay an admitted phase');
    r.testPhases[phase] = { state: 'intent' };
  });
  let result;
  if (phase === 'prepare') {
    await gate.verifySharedPrerequisites();
    await state.namespace({ create: true });
    await gate.installDependencies();
    await gate.createPublicRoute();
    await gate.apply(gate.values(operation.previous.images), 'provider-predecessor.json');
    await waitForOrdinaryRuntime(gate, operation.previous.images, wait);
    await gate.readyPublic();
    // Fixture writes occur once, only after auth, LB health and installed images
    // are proven. A lost response is retained as an uncertain phase, not retried.
    const seed = await gate.exercisePersistence(gate.config.baseUrl);
    await gate.artifact('ha-persisted-state.json', JSON.stringify(seed));
    await gate.enableOAuth(gate.config.baseUrl, seed.relativePath);
    const { object } = await state.read();
    result = {
      stagingClusterUid: operation.staging.clusterUid,
      expiryIdentity: object.metadata.uid,
      inventoryComplete: true,
      inventory: await observeStagingInventory(state, cloud),
    };
  } else {
    assert.ok(['upgrade', 'autoscaling'].includes(phase));
    await gate.loadWorkflowKey({ webAppSession: true });
    if (phase === 'upgrade') {
      gate.currentManifest = operation.previous;
      const probes = new HaReleaseProbes(gate, gate.config.baseUrl, root);
      const report = await runOrdinaryRuntimeUpgrade({
        gate,
        previous: operation.previous,
        candidate: operation.candidate,
        probes,
        baseUrl: gate.config.baseUrl,
        until: wait,
      });
      result = {
        ...report,
        qualification: 'isolated-provider',
        initialApplicationPods: 7,
        finalApplicationPods: 7,
        storageIdentityPreserved: true,
        policyDigest: operation.policyDigest,
      };
    } else {
      gate.currentManifest = operation.candidate;
      const startedAt = new Date().toISOString();
      let subphase = 'autoscaling-preparation';
      const workflow = startHaWorkflowTraffic(gate, gate.config.baseUrl, () => subphase);
      const web = startHaWebAppTraffic(gate, gate.config.baseUrl, () => subphase);
      try {
        const owned = new FixtureJournal(state);
        const raw = await runProviderAutoscaling(gate, owned, {
          phase: (name) => {
            subphase = name;
          },
          checkpoint: async (item) => {
            await state.admission();
            assert.deepEqual(workflow.report.failures, []);
            assert.deepEqual(web.report.failures, []);
            await gate.artifact('autoscaling-checkpoint.json', JSON.stringify(item));
          },
        });
        subphase = 'proxy-hpa';
        const hpa = await runProviderProxyHpa(gate, owned);
        await waitForOrdinaryRuntime(gate, operation.candidate.images, wait);
        await wait(
          'one hundred independent autoscaling completions',
          async () => workflow.report.samples >= 100 && web.report.samples >= 100,
        );
        result = {
          ...normalizeProviderAutoscaling(raw, hpa),
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: 'passed',
        };
      } finally {
        await Promise.all([workflow.stop(), web.stop()]);
        if (result) {
          result.workflow = workflow.report;
          result.web = web.report;
        }
        assert.deepEqual(workflow.report.failures, []);
        assert.deepEqual(web.report.failures, []);
      }
    }
  }
  await state.change((r) => {
    r.testPhases[phase].state = 'acknowledged';
  });
  return bind(result);
}

export async function assertProviderCheckout(operation) {
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    operation.candidate.source.sha,
  );
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim(),
    '',
    'Qualification checkout must be clean',
  );
  assertReleaseManifestMatchesCurrentChart(operation.candidate, root, { requirePromoted: false });
}
async function main() {
  process.env.RIVET_QUALIFICATION_RECEIPT_STDOUT = '1';
  process.env.RIVET_QUALIFICATION_BUNDLE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
  console.log = (...values) => console.error(...values); // stdout is a single private JSON receipt.
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert.ok(size < 4000000);
    chunks.push(chunk);
  }
  const { operation, privateDirectory } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { inputHash, ...input } = operation;
  assert.equal(qualificationHash(input), inputHash);
  await assertProviderCheckout(operation);
  const settings = reusableStagingSettings(
    JSON.parse(await fs.readFile(new URL('./settings.json', import.meta.url), 'utf8')),
  );
  const actor = { namespace: settings.runnerNamespace, name: process.env.POD_NAME, uid: process.env.POD_UID };
  assert.ok(
    actor.name && actor.uid && process.platform === 'linux',
    'Exact ephemeral in-cluster Linux runner required',
  );
  const WebSocketClass = createRequire(path.join(root, 'packages/studio-server-api/package.json'))('ws');
  const api = createKubernetesTransport({ origin: settings.clusterServer, WebSocketClass });
  const state = new ReusableStagingState(api, settings, operation),
    cloud = stagingCloudReader(settings);
  const stop = () => {
    state
      .change((r) => {
        r.closed = true;
      })
      .catch(() => {});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const phase = process.argv[2],
    id = `${process.pid}:${processStartTicks(await fs.readFile('/proc/self/stat', 'utf8'))}`;
  if (phase !== 'armExpiry') {
    const { record } = await state.read();
    assert.deepEqual(record.actor, actor);
    for (const worker of record.workers.filter((w) => !w.closed)) {
      let stat;
      try {
        stat = await fs.readFile(`/proc/${worker.pid}/stat`, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      assert.ok(!stat || processStartTicks(stat) !== worker.startTicks, 'A prior phase process still exists');
    }
    await state.change((r) => {
      r.workers.push({ id, pid: process.pid, startTicks: id.split(':')[1], phase, closed: false });
    });
  }
  const gate = new ReusableProviderGate(operation, settings, state, privateDirectory);
  let result;
  try {
    result = await executeProviderPhase({ phase, operation, state, cloud, actor, gate, privateDirectory });
  } finally {
    try {
      await gate.close();
    } finally {
      await waitForManagedGateCommands();
    }
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
  if (phase !== 'armExpiry')
    await state.change((r) => {
      r.workers.find((w) => w.id === id).closed = true;
    });
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
