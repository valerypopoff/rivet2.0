import assert from 'node:assert/strict';
import { createExecutionAutoscalerIO, PendingExecutionCpuSample } from './execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicyFromConfig, executionPoolDemand } from './execution-autoscaler.mjs';
import { waitForHaHeadroom, createHeadroomRead } from './ha-rollout-headroom.mjs';
import { runExecutionPoolTransition } from './execution-pool-transition.mjs';
import { createLegacyExecutionHttpHandoff } from './legacy-execution-http-handoff.mjs';

export function createExecutionPoolKubernetes({
  plan,
  config,
  kube,
  release,
  namespace,
  timeoutMs,
  observePod,
  status,
  beforeRetirement,
  afterRoutingWithdrawal = async () => {},
  withdraw,
  begin,
  waitForRoutingWithdrawal,
  waitForWithdrawal,
  bindCandidate,
  isCurrent,
  verifyProxy,
  artifact,
  service,
  candidateTemplate,
  routingWithdrawalClock,
}) {
  const policy = autoscalerPolicyFromConfig(config),
    ns = encodeURIComponent(namespace);
  let activeOperation;
  const observationTotals = { guards: 0, elapsedMs: 0, maximumGuardMs: 0, poolReads: 0, poolExecs: 0 };
  const readHeadroom = createHeadroomRead({ kube, namespace });
  const read = (name) =>
    readHeadroom(`/apis/apps/v1/namespaces/${ns}/statefulsets/${encodeURIComponent(name)}`, [
      'get',
      'statefulset',
      name,
      '-o',
      'json',
    ]);
  const transport = {
    json: async (method, url) => {
      assert.equal(method, 'GET', 'Pool headroom only reads resources');
      observationTotals.poolReads++;
      return readHeadroom(url);
    },
    exec: async (url, command) => {
      observationTotals.poolExecs++;
      const prefix = `/api/v1/namespaces/${ns}/pods/`;
      assert.ok(url.startsWith(prefix) && url.endsWith('/exec'));
      const name = decodeURIComponent(url.slice(prefix.length, -5));
      assert.ok([plan.previous.name, plan.candidate.name].some((pool) => name.startsWith(pool + '-')));
      return (await kube(['exec', name, '-c', 'api', '--', ...command])).stdout;
    },
  };
  const candidate = async (observation, minimumServing = 0) => {
    const controller = observation
      ? observation.controllers.find((owner) => owner?.metadata.name === plan.candidate.name)
      : await read(plan.candidate.name);
    assert.ok(controller.metadata.uid && !controller.metadata.deletionTimestamp);
    assert.equal(controller.metadata.labels?.['app.kubernetes.io/instance'], release);
    assert.equal(controller.spec.updateStrategy.type, 'OnDelete');
    bindCandidate(controller.metadata.uid);
    const count = controller.spec.replicas;
    assert.ok(Number.isSafeInteger(count) && count >= plan.previous.replicas && count <= policy.maxReplicas);
    let settling = controller.status?.observedGeneration < controller.metadata.generation,
      serving = 0;
    if (settling && !minimumServing) return null;
    for (let index = 0; index < count; index++) {
      const name = `${plan.candidate.name}-${index}`;
      const raw = observation?.pods.find((pod) => pod.metadata.name === name);
      const pod = observation
        ? raw && {
            name,
            uid: raw.metadata.uid,
            image: raw.spec.containers.find((c) => c.name === 'api')?.image,
            revision: raw.metadata.labels?.['controller-revision-hash'],
            ready: raw.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
            terminating: !!raw.metadata.deletionTimestamp,
          }
        : await observePod(name);
      if (raw) assert.equal(raw.metadata.labels?.['app.kubernetes.io/instance'], release);
      if (!pod?.ready || pod.terminating || !(await isCurrent(pod, controller.status?.updateRevision))) {
        if (!minimumServing) return null;
        settling = true;
        continue;
      }
      const current = observation
        ? observation.snapshot.pods.find((sample) => sample.uid === pod.uid)
        : await status(pod);
      assert.equal(current.state, 'serving');
      assert.equal(current.operationId, null);
      serving++;
    }
    assert.ok(serving >= minimumServing, 'Candidate execution serving floor was lost');
    const confirmed = observation ? controller : await read(plan.candidate.name);
    assert.equal(confirmed.metadata.uid, controller.metadata.uid);
    return !settling &&
      confirmed.metadata.generation === controller.metadata.generation &&
      confirmed.status?.observedGeneration >= confirmed.metadata.generation &&
      confirmed.spec.replicas === count &&
      confirmed.status?.updateRevision === controller.status?.updateRevision
      ? { uid: controller.metadata.uid, count }
      : null;
  };
  const assertCapacity = async (state) => {
    const started = performance.now();
    try {
      await verifyProxy(activeOperation);
      await waitForHaHeadroom(
        async () => {
          const io = createExecutionAutoscalerIO({ transport, ...config, policy, expectedUid: state.candidateUid });
          const observation = await io.poolSnapshot();
          const { snapshot, peer } = observation;
          const ready = await candidate(observation);
          if (!ready) throw new PendingExecutionCpuSample('Candidate execution capacity is still becoming ready');
          assert.equal(ready.uid, state.candidateUid);
          assert.equal(peer.uid, plan.previous.uid);
          assert.ok(
            snapshot.replicas + snapshot.poolCapacity.otherReplicas <= plan.maxReplicas,
            'Execution pools exceed the approved physical/connection capacity',
          );
          assert.ok(snapshot.poolCapacity.totalPods <= plan.maxReplicas);
          if (executionPoolDemand(snapshot, peer, policy) > ready.count)
            throw new PendingExecutionCpuSample('Candidate execution headroom needs permitted scaling');
          const previous = activeOperation.record.executionPool.capacity;
          await activeOperation.checkpoint({
            executionPool: {
              ...activeOperation.record.executionPool,
              capacity: {
                minimumReady: Math.min(previous?.minimumReady ?? ready.count, ready.count),
                maximumPhysicalPods: Math.max(previous?.maximumPhysicalPods ?? 0, snapshot.poolCapacity.totalPods),
              },
            },
          });
        },
        { timeoutMs },
      );
    } finally {
      const elapsedMs = performance.now() - started;
      observationTotals.guards++;
      observationTotals.elapsedMs += elapsedMs;
      observationTotals.maximumGuardMs = Math.max(observationTotals.maximumGuardMs, elapsedMs);
    }
  };
  const httpHandoff = createLegacyExecutionHttpHandoff({
    kube,
    release,
    namespace,
    plan,
    service,
    candidateTemplate,
    observePod,
    timeoutMs,
    clock: routingWithdrawalClock,
    assertCapacity: () => assertCapacity(activeOperation.record.executionPool),
  });
  const verify = async (state) => {
    const ready = await waitForHaHeadroom(
      async () => {
        activeOperation.assertLease();
        const previous = await read(plan.previous.name);
        assert.equal(previous.metadata.uid, plan.previous.uid);
        assert.equal(previous.spec.replicas, 0);
        for (const owner of state.owners) assert.equal(await observePod(owner.name), null);
        const current = await candidate(undefined, plan.previous.replicas);
        if (!current) throw new PendingExecutionCpuSample('Candidate execution capacity is still becoming ready');
        assert.equal(current.uid, state.candidateUid, 'Candidate execution pool identity changed');
        return current;
      },
      { timeoutMs },
    );
    activeOperation.assertLease();
    await httpHandoff.finish(activeOperation);
    await verifyProxy(activeOperation);
    return ready;
  };
  const io = {
    candidate: () => candidate(),
    assertCapacity,
    observe: observePod,
    status,
    prepare: (pod) => beforeRetirement(pod, { parallelPool: true }),
    prepareHttpHandoff: httpHandoff.prepare,
    beforeHttpWithdrawal: httpHandoff.beforeWithdraw,
    prepareFence: (pod) => afterRoutingWithdrawal(pod, { parallelPool: true }),
    withdraw,
    begin,
    waitForRoutingWithdrawal,
    waitForWithdrawal,
    verify,
    previous: async () => {
      const value = await read(plan.previous.name);
      return {
        uid: value.metadata.uid,
        replicas: value.spec.replicas,
        resourceVersion: value.metadata.resourceVersion,
      };
    },
    scalePrevious: async (current) => {
      await kube([
        'patch',
        'statefulset',
        plan.previous.name,
        '--type=json',
        '-p',
        JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: current.uid },
          { op: 'test', path: '/metadata/resourceVersion', value: current.resourceVersion },
          { op: 'test', path: '/spec/replicas', value: plan.previous.replicas },
          { op: 'replace', path: '/spec/replicas', value: 0 },
        ]),
      ]);
    },
  };
  return {
    workload: plan.previous.name,
    run: async (operation) => {
      activeOperation = operation;
      const state = await runExecutionPoolTransition({ operation, plan, io, timeoutMs });
      await artifact('ha-execution-pool.json', JSON.stringify({ ...state, observations: observationTotals }, null, 2));
    },
    verify: (operation) => {
      activeOperation = operation;
      return verify(operation.record.executionPool);
    },
  };
}
