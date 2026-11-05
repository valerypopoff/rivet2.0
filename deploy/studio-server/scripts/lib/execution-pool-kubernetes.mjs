import assert from 'node:assert/strict';
import { createExecutionAutoscalerIO, PendingExecutionCpuSample } from './execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicy, executionPoolDemand } from './execution-autoscaler.mjs';
import { waitForHaHeadroom } from './ha-rollout-headroom.mjs';
import { runExecutionPoolTransition } from './execution-pool-transition.mjs';

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
}) {
  const policy = autoscalerPolicy(config.policy),
    ns = encodeURIComponent(namespace);
  let activeOperation;
  const read = async (name) => JSON.parse((await kube(['get', 'statefulset', name, '-o', 'json'])).stdout);
  const transport = {
    json: async (method, url) => {
      assert.equal(method, 'GET', 'Pool headroom only reads resources');
      return JSON.parse((await kube(['get', '--raw', url])).stdout);
    },
    exec: async (url, command) => {
      const prefix = `/api/v1/namespaces/${ns}/pods/`;
      assert.ok(url.startsWith(prefix) && url.endsWith('/exec'));
      const name = decodeURIComponent(url.slice(prefix.length, -5));
      assert.ok([plan.previous.name, plan.candidate.name].some((pool) => name.startsWith(pool + '-')));
      return (await kube(['exec', name, '-c', 'api', '--', ...command])).stdout;
    },
  };
  const candidate = async () => {
    const controller = await read(plan.candidate.name);
    assert.ok(controller.metadata.uid && !controller.metadata.deletionTimestamp);
    assert.equal(controller.metadata.labels?.['app.kubernetes.io/instance'], release);
    assert.equal(controller.spec.updateStrategy.type, 'OnDelete');
    bindCandidate(controller.metadata.uid);
    const count = controller.spec.replicas;
    assert.ok(Number.isSafeInteger(count) && count >= 2 && count <= plan.maxReplicas);
    if (controller.status?.observedGeneration < controller.metadata.generation) return null;
    for (let index = 0; index < count; index++) {
      const pod = await observePod(`${plan.candidate.name}-${index}`);
      if (!pod?.ready || pod.terminating || !(await isCurrent(pod))) return null;
      const current = await status(pod);
      assert.equal(current.state, 'serving');
      assert.equal(current.operationId, null);
    }
    const confirmed = await read(plan.candidate.name);
    assert.equal(confirmed.metadata.uid, controller.metadata.uid);
    return confirmed.spec.replicas === count ? { uid: controller.metadata.uid, count } : null;
  };
  const assertCapacity = async (state) => {
    await verifyProxy(activeOperation);
    await waitForHaHeadroom(
      async () => {
        const ready = await candidate();
        if (!ready) throw new PendingExecutionCpuSample('Candidate execution capacity is still becoming ready');
        assert.equal(ready.uid, state.candidateUid);
        const io = createExecutionAutoscalerIO({ transport, ...config, policy, expectedUid: ready.uid });
        const snapshot = await io.snapshot(),
          peer = await io.peerSnapshot();
        assert.equal(peer.uid, plan.previous.uid);
        assert.ok(
          snapshot.replicas + snapshot.poolCapacity.otherReplicas <= plan.maxReplicas,
          'Execution pools exceed the approved physical/connection capacity',
        );
        assert.ok(snapshot.poolCapacity.totalPods <= plan.maxReplicas);
        if (executionPoolDemand(snapshot, peer, policy) > ready.count)
          throw new PendingExecutionCpuSample('Candidate execution headroom needs permitted scaling');
        const confirmed = await candidate();
        if (!confirmed || confirmed.uid !== ready.uid || confirmed.count < ready.count)
          throw new PendingExecutionCpuSample('Candidate execution capacity changed during observation');
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
  };
  const verify = async (state) => {
    const previous = await read(plan.previous.name);
    assert.equal(previous.metadata.uid, plan.previous.uid);
    assert.equal(previous.spec.replicas, 0);
    for (const owner of state.owners) assert.equal(await observePod(owner.name), null);
    const ready = await candidate();
    assert.ok(ready && ready.uid === state.candidateUid, 'Candidate execution pool is not settled');
    await verifyProxy(activeOperation);
    return ready;
  };
  const io = {
    candidate,
    assertCapacity,
    observe: observePod,
    status,
    prepare: beforeRetirement,
    prepareFence: afterRoutingWithdrawal,
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
      await artifact('ha-execution-pool.json', JSON.stringify(state, null, 2));
    },
    verify: (operation) => {
      activeOperation = operation;
      return verify(operation.record.executionPool);
    },
  };
}
