import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { startHaBrowserProbe } from '../lib/ha-browser-probe.mjs';
import { runHaKubernetesControlTopology } from '../lib/ha-kubernetes-control-topology.mjs';
import { mergeRuntimeControlGuards } from '../kubernetes-runtime-control-local.mjs';
import { getStudioServerReleaseManifestDigest } from '../lib/studio-server-release-manifest.mjs';
import { overlapProfileDigest } from '../lib/qualification-overlap-profile.mjs';
import { startHaDeveloperTraffic } from '../lib/ha-workflow-traffic.mjs';
import { prepareOverlapBundle } from './overlap-bundle-fixture.mjs';
import { ready, role, root, until, sleep } from './provider-gate.mjs';

const status = async (gate, pod) => {
  const actual = JSON.parse((await gate.kube(['get', 'pod', pod.name, '-o', 'json'])).stdout);
  assert.equal(actual.metadata.uid, pod.uid);
  const result = JSON.parse(
    (await gate.kube(['exec', pod.name, '-c', 'backend', '--', 'node', '/opt/rivet/retire-backend.mjs'])).stdout,
  );
  assert.equal(result.housekeeping?.podUid, pod.uid);
  assert.equal(result.housekeeping.incarnation, result.incarnation);
  return result;
};
const maintenanceDisk = async (gate, pod) => {
  const name = pod.spec.volumes?.find((v) => v.name === 'legacy-restore')?.persistentVolumeClaim?.claimName;
  assert.ok(name);
  const claim = JSON.parse((await gate.kube(['get', 'pvc', name, '-o', 'json'])).stdout);
  assert.equal(claim.status.phase, 'Bound');
  assert.ok(!claim.metadata.deletionTimestamp);
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  const volume = JSON.parse((await gate.kube(['get', 'pv', claim.spec.volumeName, '-o', 'json'])).stdout);
  assert.equal(volume.spec.claimRef.uid, claim.metadata.uid);
  assert.equal(volume.spec.claimRef.namespace, gate.config.namespace);
  assert.ok(!volume.metadata.deletionTimestamp && volume.metadata.uid && claim.metadata.uid);
  return {
    name,
    uid: claim.metadata.uid,
    volume: volume.metadata.name,
    volumeUid: volume.metadata.uid,
    size: claim.spec.resources.requests.storage,
  };
};

/** Adoption is a separate same-image preparation step, outside the protected
 * mixed-image window. It makes no initial developer-availability promise. */
export async function adoptProviderOverlap(gate) {
  const values = gate.values(gate.operation.previous.images);
  const sourcePool = values.postgres.poolMaxPerApiPod;
  if (values.ha.controlPlane.mode === 'singleton-overlap')
    return { sourceMode: 'singleton-overlap', sourcePool, preparationComplete: true };
  gate.overlapProfilePrepared = true;
  // Pool sizing is a separate same-image singleton rollout. Ownership transfer
  // must not leave old execution owners using a larger pool than its budget.
  if (sourcePool !== gate.operation.developerOverlapProfile.poolMaxPerApiPod)
    await gate.roll(gate.operation.previous.images, true, {
      ownerPoolTransition: { from: sourcePool, to: gate.operation.developerOverlapProfile.poolMaxPerApiPod },
    });
  gate.overlap = true;
  const target = gate.values(gate.operation.previous.images);
  const digest = getStudioServerReleaseManifestDigest(gate.operation.previous, { requirePromoted: true });
  await runHaKubernetesControlTopology({
    safety: gate.deploymentSafety('topology', digest),
    kube: (...args) => gate.kube(...args),
    release: gate.config.release,
    namespace: gate.config.namespace,
    manifestDigest: digest,
    resources: await gate.resources(target, 'provider-overlap-adoption'),
    observeProxyBackend: gate.observeProxyBackend,
    timeoutMs: 1200000,
    artifact: (...args) => gate.artifact(...args),
    applyTemplates: (guards) => gate.apply(mergeRuntimeControlGuards(target, guards), 'provider-overlap-enable.json'),
  });
  return { sourceMode: 'singleton', sourcePool, preparationComplete: true };
}

/** Inject only a known accepted fixture acknowledgement loss, once. A real
 * error never authorizes another attempt. Recovery uses the original journal
 * token after the actual prior runner lease expires, without repeating acquire. */
export async function rollWithHandoverInterruption(gate, images, probes, { wait = until } = {}) {
  const injected = Error('Isolated fixture accepted-acquire acknowledgement suppressed');
  let interrupted = false;
  let accepted;
  const kube = async (args, options) => {
    const result = await gate.kube(args, options);
    if (!interrupted && args[0] === 'exec' && args.includes('--housekeeping-acquire')) {
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.housekeeping?.state, 'owner');
      assert.ok(receipt.housekeeping.operationId);
      assert.ok(receipt.housekeeping.podUid && receipt.incarnation);
      assert.equal(receipt.housekeeping.incarnation, receipt.incarnation);
      accepted = {
        token: receipt.housekeeping.operationId,
        uid: receipt.housekeeping.podUid,
        incarnation: receipt.incarnation,
      };
      interrupted = true;
      await gate.artifact(
        'provider-handover-accepted-acquire.json',
        JSON.stringify({
          pod: args[1],
          podUid: receipt.housekeeping.podUid,
          incarnation: receipt.incarnation,
          operationId: receipt.housekeeping.operationId,
        }),
      );
      throw injected;
    }
    return result;
  };
  try {
    await gate.roll(images, true, { ...probes, kube });
    throw Error('Handover fixture did not exercise its interruption');
  } catch (error) {
    let cause = error;
    while (cause && cause !== injected) cause = cause.cause;
    if (!cause) throw error;
  }
  const record = await wait('original interrupted release lease settlement', async () => {
    const current = JSON.parse(
      JSON.parse((await gate.kube(['get', 'configmap', gate.journalName, '-o', 'json'])).stdout).data.record,
    );
    assert.notEqual(current.phase, 'complete');
    assert.equal(current.token, accepted.token, 'Interrupted release journal was replaced');
    assert.equal(current.owner?.housekeeping?.targetUid, accepted.uid);
    assert.equal(current.owner?.housekeeping?.targetIncarnation, accepted.incarnation);
    assert.equal(current.owner?.housekeeping?.acquireIssued, true);
    assert.ok(Number.isFinite(current.leaseExpiresAt));
    return current.leaseExpiresAt <= Date.now() ? current : null;
  });
  const result = await gate.roll(images, true, { ...probes, resumeToken: record.token });
  assert.equal(result.token, record.token);
  return result;
}

export async function startProviderOverlapProbe(
  gate,
  probes,
  previous,
  candidate,
  { startBrowser = startHaBrowserProbe, wait = until, startTraffic = startHaDeveloperTraffic } = {},
) {
  const before = await gate.pods();
  const original = before.find((p) => role(p) === 'backend');
  assert.ok(original && ready(original));
  const disk = await maintenanceDisk(gate, original);
  probes.overlapBundle = await prepareOverlapBundle(gate, probes.template);
  const browser = await startBrowser(gate, gate.config.baseUrl, root, {
    template: probes.template,
    label: 'provider-backend-overlap',
  });
  const traffic = startTraffic(gate, gate.config.baseUrl);
  const transfers = new Map();
  let running = true,
    resumed = false,
    samplingError,
    samples = 0,
    minimumReady = Infinity,
    sameNodeSamples = 0;
  const observe = (async () => {
    while (running) {
      const backends = (await gate.pods()).filter((p) => role(p) === 'backend');
      assert.ok(backends.length <= 2, 'Unexpected extra backend during overlap');
      const count = backends.filter(ready).length;
      minimumReady = Math.min(minimumReady, count);
      assert.ok(count >= 1, 'Developer serving capacity disappeared');
      samples++;
      if (!resumed && backends.some((p) => p.metadata.uid === original.metadata.uid)) {
        const current = await status(gate, { name: original.metadata.name, uid: original.metadata.uid });
        if (current.state === 'draining') {
          await browser.resumeAfterFrontendReplacement([]);
          resumed = true;
        }
      }
      assert.deepEqual(traffic.report.failures, []);
      await sleep(500);
    }
  })().catch((e) => {
    samplingError = e;
  });
  const checkpoint = () => {
    if (samplingError) throw samplingError;
    assert.deepEqual(traffic.report.failures, []);
  };
  const artifact = async (name, contents) => {
    checkpoint();
    if (name !== 'ha-rollout.json') return;
    const journal = JSON.parse(contents),
      h = journal.owner?.housekeeping;
    if (!h?.complete) return;
    if (transfers.has(`${h.sourceUid}:${h.targetUid}`)) return;
    const backends = (await gate.pods()).filter((p) => role(p) === 'backend');
    const source = backends.find((p) => p.metadata.uid === h.sourceUid);
    const target = backends.find((p) => p.metadata.uid === h.targetUid);
    assert.ok(source && target);
    assert.ok(source.spec.nodeName && source.spec.nodeName === target.spec.nodeName);
    const a = await status(gate, { name: source.metadata.name, uid: h.sourceUid });
    const b = await status(gate, { name: target.metadata.name, uid: h.targetUid });
    assert.equal(a.housekeeping.state, 'released');
    assert.equal(b.housekeeping.state, 'owner');
    assert.equal(a.incarnation, h.sourceIncarnation);
    assert.equal(b.incarnation, h.targetIncarnation);
    assert.equal(a.housekeeping.operationId, journal.token);
    assert.equal(b.housekeeping.operationId, journal.token);
    sameNodeSamples++;
    transfers.set(`${h.sourceUid}:${h.targetUid}`, h);
  };
  return {
    async roll(callbacks) {
      const editors = new Set();
      return rollWithHandoverInterruption(
        gate,
        candidate.images,
        {
          ...callbacks,
          artifact,
          verifyDeveloperReady: (pod) => gate.verifyDeveloperAcceptance(pod),
          beforeRetirement: async (pod) => {
            checkpoint();
            if (/-ha-backend-[01]$/.test(pod.name) && !editors.has(pod.uid)) {
              editors.add(pod.uid);
              await probes.startEditor(pod, `${gate.config.release}-ha-backend-${pod.name.endsWith('-0') ? 1 : 0}`);
            }
            await callbacks.beforeRetirement(pod);
          },
        },
        { wait },
      );
    },
    async finish() {
      await Promise.all(probes.editors.map((p) => p.completed));
      checkpoint();
      for (const p of probes.editors) {
        assert.equal(p.error, null);
        assert.equal(p.receipt?.phase, 'passed');
      }
      assert.equal(resumed, true);
      const receipt = await browser.finish(before, {
        frontendReplacement: !isDeepStrictEqual(previous.images.web, candidate.images.web),
      });
      await wait('one hundred authenticated developer requests', async () => {
        checkpoint();
        return traffic.report.samples >= 100;
      });
      assert.equal(transfers.size, 2);
      const backends = (await gate.pods()).filter((p) => role(p) === 'backend');
      assert.equal(backends.length, 1);
      const final = await status(gate, { name: backends[0].metadata.name, uid: backends[0].metadata.uid });
      assert.equal(final.state, 'serving');
      assert.equal(final.housekeeping.state, 'owner');
      const after = await maintenanceDisk(gate, backends[0]);
      assert.deepEqual(after, disk, 'Maintenance claim changed through backend handover');
      return {
        profileDigest: overlapProfileDigest(gate.operation.developerOverlapProfile),
        adoptionOrAlreadyEnabled: true,
        interruptedSameOperationRecovered: true,
        sameNodeSamples,
        readinessSamples: samples,
        minimumReady,
        maximumHousekeepingOwners: 1,
        handoverCount: transfers.size,
        claimIdentityPreserved: true,
        maintenanceClaim: { before: disk, after },
        finalBackendCount: 1,
        finalOwnerCount: 1,
        editorRuns: probes.editors.map((p) => ({ uid: p.uid, receipt: p.receipt })),
        browser: receipt,
        developerTraffic: traffic.report,
      };
    },
    async close() {
      running = false;
      await Promise.all([observe, traffic.stop()]);
      await browser.close();
      checkpoint();
    },
  };
}
