import assert from 'node:assert/strict';
import { matchesKubernetesTemplate } from './kubernetes-template-match.mjs';
import { kubernetesReadRetryReason } from './kubernetes-read-errors.mjs';

const component = 'app.kubernetes.io/component';
const instance = 'app.kubernetes.io/instance';
const ownedBy = (resource, kind, uid) =>
  resource.metadata?.ownerReferences?.some((owner) => owner.controller && owner.kind === kind && owner.uid === uid);
const ready = (pod) =>
  !pod.metadata.deletionTimestamp &&
  pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True');
// Provider-adjusted reservations are observations, not template acknowledgement
// failures. Runtime settings, images, storage and lifecycle still compare.
function runtimeTemplate(template) {
  const expected = structuredClone(template);
  for (const group of ['containers', 'initContainers'])
    for (const container of expected.spec[group] ?? []) delete container.resources;
  return expected;
}

/** An acknowledged Helm apply is not whole-release readiness. Before serial
 * retirement, require observed OnDelete templates and a ready candidate scaler;
 * native proxy/web replacement continues until final release settlement. */
export async function waitForHaTemplateReadiness({
  kube,
  resources,
  workloads,
  release,
  namespace,
  timeoutMs,
  includeFrontends = false,
  identities = new Map(workloads.map((workload) => [`StatefulSet/${workload.name}`, workload.uid])),
  assertLease = () => {},
  artifact = async () => {},
  clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const expected = resources.filter(
    (resource) =>
      resource.kind === 'StatefulSet' ||
      (resource.kind === 'Deployment' &&
        ['autoscaler', ...(includeFrontends ? ['proxy', 'web'] : [])].includes(resource.metadata.labels?.[component])),
  );
  assert.ok(expected.length > 0);
  const deadline = clock.now() + timeoutMs;
  let readFailure;
  for (;;) {
    assertLease();
    if (clock.now() >= deadline)
      throw new Error('Timed out waiting for HA template/controller readiness; owners retained', {
        cause: readFailure,
      });
    let response;
    try {
      response = await kube([
        'get',
        'statefulset,deployment,replicaset,pod',
        '-l',
        `${instance}=${release}`,
        '-o',
        'json',
      ]);
    } catch (error) {
      assertLease();
      if (!kubernetesReadRetryReason(error)) throw error;
      readFailure = error;
      await clock.sleep(Math.max(0, Math.min(1000, deadline - clock.now())));
      continue;
    }
    readFailure = undefined;
    const { items } = JSON.parse(response.stdout);
    assert.ok(Array.isArray(items), 'HA prerequisite inventory is unavailable');
    assertLease();
    assert.ok(clock.now() < deadline, 'HA prerequisite observation exceeded its deadline');
    const pending = [];
    const observed = [];
    for (const desired of expected) {
      assert.equal(desired.metadata.labels?.[instance], release);
      assert.ok(!desired.metadata.namespace || desired.metadata.namespace === namespace);
      const live = items.find(
        (resource) => resource.kind === desired.kind && resource.metadata?.name === desired.metadata.name,
      );
      assert.ok(live?.metadata?.uid && !live.metadata.deletionTimestamp, 'Applied HA controller is unavailable');
      assert.equal(live.metadata.namespace, namespace);
      assert.equal(live.metadata.labels?.[instance], release);
      assert.equal(live.metadata.labels?.[component], desired.metadata.labels?.[component]);
      const key = `${desired.kind}/${desired.metadata.name}`;
      const prior = identities.get(key);
      if (prior) assert.equal(live.metadata.uid, prior, 'Applied HA controller was replaced');
      identities.set(key, live.metadata.uid);
      assert.ok(
        matchesKubernetesTemplate(live.spec.template, runtimeTemplate(desired.spec.template)),
        'HA template application is unconfirmed',
      );
      const generation = live.metadata.generation;
      const generationObserved =
        Number.isSafeInteger(generation) && generation > 0 && live.status?.observedGeneration >= generation;
      let current = generationObserved;
      if (desired.kind === 'StatefulSet') {
        assert.equal(live.spec.updateStrategy?.type, 'OnDelete');
        current &&= typeof live.status?.updateRevision === 'string' && live.status.updateRevision.length > 0;
      } else {
        assert.ok(
          (live.spec.minReadySeconds ?? 0) >= (desired.spec.minReadySeconds ?? 0),
          'Candidate readiness stabilization was shortened',
        );
        const hpa = resources.find(
          (resource) =>
            resource.kind === 'HorizontalPodAutoscaler' &&
            resource.spec.scaleTargetRef.kind === 'Deployment' &&
            resource.spec.scaleTargetRef.name === desired.metadata.name,
        );
        const minimum = hpa?.spec.minReplicas ?? desired.spec.replicas ?? 1;
        const maximum = hpa?.spec.maxReplicas ?? minimum;
        const count = live.spec.replicas;
        assert.ok(
          Number.isSafeInteger(count) && count >= minimum && count <= maximum,
          'Candidate native capacity is outside its bounds',
        );
        const sets = items.filter(
          (resource) => resource.kind === 'ReplicaSet' && ownedBy(resource, 'Deployment', live.metadata.uid),
        );
        const pods = items.filter(
          (resource) =>
            resource.kind === 'Pod' &&
            !['Succeeded', 'Failed'].includes(resource.status?.phase) &&
            sets.some((set) => ownedBy(resource, 'ReplicaSet', set.metadata.uid)),
        );
        const candidates = pods.filter(
          (resource) => ready(resource) && matchesKubernetesTemplate(resource, runtimeTemplate(desired.spec.template)),
        );
        current &&=
          live.status.updatedReplicas >= count &&
          live.status.readyReplicas >= count &&
          live.status.availableReplicas >= count &&
          candidates.length >= count;
        if (includeFrontends) current &&= pods.length === count && candidates.length === count;
        assert.ok(
          // Status still belongs to the previous rollout until the controller
          // acknowledges this generation. Its old failure cannot reject a fix.
          !generationObserved ||
            !live.status?.conditions?.some(
              (condition) => condition.type === 'Progressing' && condition.status === 'False',
            ),
          'Candidate native controller rollout failed',
        );
      }
      if (!current) pending.push(desired.metadata.name);
      observed.push({ kind: live.kind, name: live.metadata.name, uid: live.metadata.uid, generation, ready: current });
    }
    if (!pending.length) {
      await artifact(
        includeFrontends ? 'ha-frontend-readiness.json' : 'ha-template-readiness.json',
        JSON.stringify(
          { version: 1, ready: true, nativeFrontendsMayStillBeUpdating: !includeFrontends, controllers: observed },
          null,
          2,
        ),
      );
      assertLease();
      return;
    }
    await clock.sleep(Math.min(1000, deadline - clock.now()));
  }
}
