import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { startHaWorkflowTraffic, startHaWebAppTraffic } from './ha-workflow-traffic.mjs';
import { ordinaryRuntimeReplicaBounds } from './ha-release-evidence.mjs';
import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './studio-server-release-manifest.mjs';

export function assertRuntimeUpgradePair(previous, candidate) {
  assertStudioServerReleaseManifest(previous, { requirePromoted: true });
  assertStudioServerReleaseManifest(candidate);
  assert.equal(
    candidate.lineage?.predecessor?.manifestDigest,
    getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
  );
  assert.equal(candidate.lineage.predecessor.sourceSha, previous.source.sha);
  assert.deepEqual(candidate.lineage.predecessor.images, previous.images);
  assert.equal(
    candidate.lineage.predecessor.managedWorkflowSchemaVersion,
    previous.database.managedWorkflowSchema.version,
  );
  assert.ok(
    previous.database.managedWorkflowSchema.version >=
      candidate.database.managedWorkflowSchema.minimumRollbackCompatibleVersion,
    'An incompatible schema requires maintenance, not an ordinary qualification',
  );
  assert.ok(
    previous.database.managedWorkflowSchema.version <= candidate.database.managedWorkflowSchema.version,
    'Ordinary qualification cannot downgrade the installed schema',
  );
  assert.notDeepEqual(previous.images, candidate.images, 'Ordinary qualification requires a mixed-image pair');
}

export function runtimeQualificationPurpose(value = 'ordinary-upgrade') {
  assert.ok(['ordinary-upgrade', 'adoption'].includes(value), 'Unknown runtime qualification purpose');
  return value;
}

export function assertOrdinaryRuntimePods(pods, images, { baseline = false, replicaBounds } = {}) {
  const counts = { proxy: 2, web: 1, backend: 1, execution: 2, autoscaler: 1 };
  const live = pods.filter((p) => !p.metadata.deletionTimestamp);
  if (baseline || replicaBounds)
    assert.equal(live.length, pods.length, 'A terminating owner still prevents runtime settlement');
  if (replicaBounds) {
    assert.ok(
      live.every((p) => Object.hasOwn(counts, p.metadata.labels?.['app.kubernetes.io/component'])),
      'Unexpected runtime workload',
    );
    assert.ok(
      live.every((p) => typeof p.metadata.uid === 'string' && p.metadata.uid.length > 0),
      'Runtime owner identity missing',
    );
    assert.equal(new Set(live.map((p) => p.metadata.uid)).size, live.length, 'Duplicate runtime owner identity');
  }
  for (const [role, count] of Object.entries(counts)) {
    const owners = live.filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === role);
    assert.ok(owners.length >= count, `${role} capacity is below its floor`);
    if (replicaBounds) {
      const bound = replicaBounds[role];
      assert.ok(
        owners.length >= bound.min && owners.length <= bound.max,
        `${role} capacity is outside its approved bounds`,
      );
    } else if (baseline)
      assert.equal(owners.length, count, 'Ordinary proof must start and finish at the seven-pod floor');
    assert.ok(
      owners.filter((p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')).length >=
        (replicaBounds ? owners.length : count),
      `${role} owners are not ready`,
    );
    if (images)
      for (const p of owners) {
        const image = images[['backend', 'execution', 'autoscaler'].includes(role) ? 'api' : role];
        const container = role === 'execution' ? 'api' : role;
        assert.ok(
          p.spec.containers.find((c) => c.name === container)?.image === `${image.repository}@${image.digest}`,
          'Unexpected baseline image',
        );
      }
  }
  if (baseline && !replicaBounds) assert.equal(live.length, 7, 'Unclassified owners cannot be hidden in the baseline');
  return Object.fromEntries(
    Object.keys(counts).map((role) => [
      role,
      live.filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === role).length,
    ]),
  );
}

export async function waitForOrdinaryRuntime(gate, images, until) {
  const replicaBounds =
    gate.operation?.qualification?.tier === 'focused' ? ordinaryRuntimeReplicaBounds(gate.operation.policy) : undefined;
  let observed;
  await until(
    replicaBounds
      ? 'ready exact-image application owners within approved capacity'
      : 'seven ready exact-image application owners',
    async () => {
      try {
        observed = assertOrdinaryRuntimePods(await gate.pods(), images, { baseline: true, replicaBounds });
        return true;
      } catch {
        return false;
      }
    },
  );
  return observed;
}

/** Real gate transport, roll and accepted-work probes; no provisioning or
 * publication here. Failed windows are final, never retried or spliced. */
export async function runOrdinaryRuntimeUpgrade({
  gate,
  previous,
  candidate,
  probes,
  baseUrl,
  until,
  signal,
  sampleIntervalMs = 500,
  startDeveloperOverlap,
  prepareDeveloperOverlap,
}) {
  signal?.throwIfAborted();
  assertRuntimeUpgradePair(previous, candidate);
  await gate.assertLocalContext(); // Provider adapters override with their exact isolated-operation guard.
  assert.equal(gate.edgeProfile, 'compact');
  assert.equal(gate.purpose, 'ordinary-upgrade');
  const focused = gate.operation?.qualification?.tier === 'focused';
  // Focused qualification accepts healthy autoscaler-grown capacity. Full
  // regression fixtures retain their deliberately fixed initial/final layout.
  const initialCapacity = await waitForOrdinaryRuntime(gate, previous.images, (name, check) =>
    until(name, async () => {
      signal?.throwIfAborted();
      return check();
    }),
  );
  const report = {
    qualification: 'local-functional-only',
    purpose: 'ordinary-upgrade',
    startedAt: new Date().toISOString(),
    candidateSourceSha: candidate.source.sha,
    predecessorSourceSha: previous.source.sha,
    predecessorManifestDigest: getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
    candidateImages: candidate.images,
    chartDigest: candidate.chart.contentDigest,
    initialApplicationPods: Object.values(initialCapacity).reduce((a, b) => a + b, 0),
    ...(focused ? { capacity: { initial: initialCapacity } } : {}),
    phases: [],
    // Retain even partially accepted probes on failure for exact settlement.
    outcomes: { acceptedWork: probes.background },
    readiness: { samples: 0, minimumReady: { execution: null, proxy: null } },
  };
  const inventory = async () => {
    const items = JSON.parse((await gate.kube(['get', 'service,pvc', '-o', 'json'])).stdout).items;
    return (
      items
        // Compare durable identities, not the whole desired configuration. A
        // Service port update or same-volume resize is not replacement/data loss.
        .map((r) => ({
          kind: r.kind,
          name: r.metadata.name,
          uid: r.metadata.uid,
          binding:
            r.kind === 'Service'
              ? { addresses: r.spec.clusterIPs ?? [r.spec.clusterIP] }
              : { volumeName: r.spec.volumeName, storageClassName: r.spec.storageClassName },
        }))
        .sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`))
    );
  };
  const before = await inventory();
  let phase = focused ? 'predecessor-runtime-preparation' : 'predecessor-seven-preparation';
  const workflow = startHaWorkflowTraffic(gate, baseUrl, () => phase);
  const web = startHaWebAppTraffic(gate, baseUrl, () => phase);
  let observing = true,
    developer,
    observationFailure,
    failure,
    firstFailureDiagnostics;
  const captureFirstFailure = () => {
    firstFailureDiagnostics ??= Promise.resolve()
      .then(() => gate.capture('ordinary-upgrade-first-failure'))
      .then(
        () => true,
        () => false,
      );
  };
  const checkpoint = () => {
    signal?.throwIfAborted();
    if (observationFailure || workflow.report.failures.length || web.report.failures.length) {
      captureFirstFailure();
      throw observationFailure ?? Error('Protected public traffic failed');
    }
  };
  const wait = (name, check) =>
    until(name, async () => {
      checkpoint();
      return check();
    });
  const observe = (async () => {
    while (observing) {
      const pods = await gate.pods();
      gate.continuityProbes?.observeProxyPods?.(pods);
      // Singleton developer availability is intentionally not promised.
      for (const role of ['execution', 'proxy']) {
        const count = pods.filter(
          (p) =>
            !p.metadata.deletionTimestamp &&
            p.metadata.labels?.['app.kubernetes.io/component'] === role &&
            p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
        ).length;
        const minimum = report.readiness.minimumReady[role];
        report.readiness.minimumReady[role] = minimum === null ? count : Math.min(minimum, count);
        assert.ok(count >= 2, 'Published runtime lost its two ready owners');
      }
      report.readiness.samples++;
      if (workflow.report.failures.length || web.report.failures.length) throw Error('Public traffic failed');
      await new Promise((r) => setTimeout(r, sampleIntervalMs));
    }
  })().catch((error) => {
    observationFailure = error;
    // Keep the request IDs and contemporaneous upstream logs together. Waiting
    // until a long rollout finishes can lose the first 502 to log truncation.
    captureFirstFailure();
  });
  try {
    gate.config.images = previous.images;
    report.outcomes.initialAutoscaler = await gate.assertAutoscalerActive(Date.now());
    checkpoint();
    // Keep customer observers and two-owner floors active through the optional
    // bridge too. Developer continuity starts only after that explicit adoption.
    if (prepareDeveloperOverlap) {
      report.outcomes.overlapPreparation = await prepareDeveloperOverlap();
      checkpoint();
    }
    await probes.prepare({
      embeddedMaintenance: startDeveloperOverlap ? true : 'singleton',
      ...(gate.continuityProbes ? { retirementDelayMs: 315000 } : {}),
    });
    await gate.continuityProbes?.prepare(probes.template);
    if (startDeveloperOverlap) developer = await startDeveloperOverlap(probes);
    checkpoint();
    phase = focused ? 'ordinary-runtime-upgrade' : 'ordinary-seven-to-seven-upgrade';
    const callbacks = {
      beforeRetirement: async (pod) => {
        checkpoint();
        if (/-ha-execution(?:-next)?-[01]$/.test(pod.name))
          await gate.continuityProbes?.startCohort('execution-retirement');
        return /-ha-execution(?:-next)?-[01]$/.test(pod.name) ? probes.beforeRetirement(pod) : undefined;
      },
      afterWithdrawal: (pod) =>
        /-ha-execution(?:-next)?-[01]$/.test(pod.name) ? probes.afterWithdrawal(pod) : undefined,
    };
    if (developer) await developer.roll(callbacks);
    else {
      const rolled = await gate.roll(candidate.images, true, callbacks);
      if (rolled?.executionPools !== undefined) report.outcomes.executionPools = rolled.executionPools;
      if (rolled?.executionPool) report.outcomes.executionPool = rolled.executionPool;
    }
    if (developer) {
      report.outcomes.developerOverlap = await developer.finish();
      await developer.close();
      developer = undefined;
    }
    report.phases.push(focused ? 'bounded-capacity-mixed-image-upgrade' : 'exact-seven-to-seven-mixed-image-upgrade');
    if (previous.database.managedWorkflowSchema.version !== candidate.database.managedWorkflowSchema.version) {
      report.schemaCompatibility = await gate.verifyMixedSchemaRepositories({
        previousApiImage: { ...previous.images.api, schemaVersion: previous.database.managedWorkflowSchema.version },
        candidateApi: candidate.images.api,
        to: candidate.database.managedWorkflowSchema.version,
      });
    }
    checkpoint();
    phase = focused ? 'candidate-runtime-acceptance' : 'candidate-seven-acceptance';
    gate.config.images = candidate.images;
    report.outcomes.autoscaler = await gate.assertAutoscalerActive(Date.now());
    checkpoint();
    await gate.waitForDeveloperRoute(baseUrl);
    await waitForOrdinaryRuntime(gate, candidate.images, wait);
    assert.equal(probes.background.length, 2, 'Both original execution owners must accept a drain probe');
    assert.ok(
      probes.background.every((r) => r.recordingId),
      'Accepted background runs must each retain their recording',
    );
    assert.ok(isDeepStrictEqual(await inventory(), before), 'Storage or service routing identity changed');
    const response = await fetch(`${baseUrl}/api/workflows/project-bundles/${probes.bundle.id}/download`, {
      headers: gate.probeHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      probes.bundle.archiveHash,
    );
    report.outcomes.acceptedWork = probes.background;
    report.outcomes.maintenanceArchivePreserved = true;
    await wait(
      'at least one hundred protected workflow and web completions',
      async () => workflow.report.samples >= 100 && web.report.samples >= 100,
    );
    checkpoint();
    if (!focused) {
      phase = 'candidate-runtime-without-developers';
      report.outcomes.independence = await gate.isolateRuntime(baseUrl, probes.projectId);
      report.phases.push('candidate-runtime-without-developers');
    }
    if (gate.continuityProbes) report.requestContinuity = await gate.continuityProbes.finish();
    checkpoint();
    // Long responses may finish after an HPA change. Validate and report the
    // settled runtime after those completions, not an earlier capacity snapshot.
    const finalCapacity = await waitForOrdinaryRuntime(gate, candidate.images, wait);
    report.finalApplicationPods = Object.values(finalCapacity).reduce((a, b) => a + b, 0);
    if (focused) report.capacity.final = finalCapacity;
    report.outcomes.finalAutoscaler = await gate.assertAutoscalerActive(Date.now());
    checkpoint();
  } catch (error) {
    failure = error;
  } finally {
    await gate.continuityProbes?.close();
    if (developer) {
      try {
        await developer.close();
      } catch (e) {
        failure ??= e;
      }
    }
    observing = false;
    await Promise.all([observe, workflow.stop(), web.stop()]);
    failure ??= observationFailure;
    if (workflow.report.failures.length || web.report.failures.length) {
      captureFirstFailure();
      failure ??= Error('Protected public traffic failed');
    }
    report.workflow = workflow.report;
    report.web = web.report;
    report.outcome = failure ? 'failed' : 'passed';
    report.terminalPhase = phase;
    report.finishedAt = new Date().toISOString();
    // Capture private fixture diagnostics before cleanup; do not publish raw logs.
    if (failure) await gate.capture('ordinary-upgrade-failure').catch(() => {});
    if (firstFailureDiagnostics) report.firstFailureDiagnosticsCaptured = await firstFailureDiagnostics;
    await gate.artifact('runtime-ordinary-upgrade-report.json', JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  return report;
}
