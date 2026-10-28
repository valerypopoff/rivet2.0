import { randomUUID } from 'node:crypto';
import { autoscalerPolicy, recommendExecutionReplicas } from './execution-autoscaler.mjs';
import {
  createExecutionAutoscalerIO,
  cpuQuantity,
  PendingExecutionCpuSample,
} from './execution-autoscaler-kubernetes.mjs';

class PendingProxyMetrics extends Error {}

/** A replacement may be Ready before metrics-server's next scrape. Only this
 * typed observation delay is waitable; identity/policy/capacity failures remain
 * terminal. Every attempt reruns the complete checks, never a workload write. */
export async function waitForHaHeadroom(
  check,
  { timeoutMs, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw Error('Headroom observation requires a bounded timeout.');
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (
        !(error?.cause instanceof PendingProxyMetrics || error?.cause instanceof PendingExecutionCpuSample) ||
        now() >= deadline
      )
        throw error;
      await pause(Math.min(1000, deadline - now()));
    }
  }
}

/** Read the same fenced, fresh CPU/admission observations as the controller,
 * without acquiring its journal or issuing any autoscaling command. */
export function createHaExecutionHeadroomGuard({
  kube,
  release,
  namespace,
  resources,
  workloads,
  inventory,
  artifact = async () => {},
  now = Date.now,
}) {
  const controller = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.labels?.['app.kubernetes.io/component'] === 'autoscaler',
  );
  if (!controller) return async () => {};
  const raw = controller.spec.template.spec.containers[0].env?.find(
    (entry) => entry.name === 'RIVET_AUTOSCALER_CONFIG',
  )?.value;
  const config = JSON.parse(raw);
  const workload = workloads.find((value) => value.role === 'execution' && value.name === config.workload);
  if (!workload || config.release !== release || config.namespace !== namespace || config.image !== workload.image)
    throw new Error('HA execution headroom policy does not match the rendered release.');
  const policy = autoscalerPolicy(config.policy);
  const originalImage = inventory
    .find((value) => value.metadata.uid === workload.uid)
    ?.spec.template.spec.containers.find((value) => value.name === 'api')?.image;
  if (!originalImage) throw new Error('Original execution image is unconfirmed for rollout headroom.');
  const transport = {
    async json(method, requestPath) {
      if (method !== 'GET') throw new Error('Rollout headroom transport is read-only.');
      return JSON.parse((await kube(['get', '--raw', requestPath])).stdout);
    },
    async exec(requestPath, command) {
      const prefix = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/`;
      if (!requestPath.startsWith(prefix) || !requestPath.endsWith('/exec'))
        throw new Error('Rollout headroom exec identity is invalid.');
      const pod = decodeURIComponent(requestPath.slice(prefix.length, -'/exec'.length));
      if (!pod.startsWith(`${workload.name}-`) || !/^\d+$/.test(pod.slice(workload.name.length + 1)))
        throw new Error('Rollout headroom pod is outside the execution workload.');
      return (await kube(['exec', pod, '-c', 'api', '--', ...command])).stdout;
    },
  };
  return async ({ stage = 'retirement', departing } = {}) => {
    const base = {
      protocol: 1,
      observedAt: new Date(now()).toISOString(),
      stage,
      autoscalingFrozen: false,
      scaleDownPaused: stage !== 'preflight',
      automaticBurstScaling: true,
      workload: workload.name,
      workloadUid: workload.uid,
      ...(departing ? { departing: { name: departing.name, uid: departing.uid } } : {}),
    };
    let observation;
    try {
      const expectedImage = stage === 'preflight' ? originalImage : workload.image;
      const io = createExecutionAutoscalerIO({
        transport,
        release,
        namespace,
        workload: workload.name,
        service: config.service,
        image: expectedImage,
        expectedUid: workload.uid,
        policy,
        port: config.port,
        now,
      });
      const snapshot = await io.snapshot();
      if (snapshot.uid !== workload.uid || snapshot.startupFence)
        throw new Error('Execution ownership changed during rollout headroom inspection.');
      // Sampling executes sequentially. Recheck earlier owners and the complete
      // set after the last exec, so a late failure/scale cannot leave optimistic
      // headroom based on identities that no longer serve this workload.
      const ns = encodeURIComponent(namespace);
      const selector = encodeURIComponent(
        `app.kubernetes.io/instance=${release},app.kubernetes.io/component=execution`,
      );
      const [owner, pods] = await Promise.all([
        transport.json('GET', `/apis/apps/v1/namespaces/${ns}/statefulsets/${encodeURIComponent(workload.name)}`),
        transport.json('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`),
      ]);
      if (
        owner.metadata?.uid !== snapshot.uid ||
        owner.metadata.deletionTimestamp ||
        owner.spec?.replicas !== snapshot.replicas ||
        owner.spec.updateStrategy?.type !== 'OnDelete' ||
        owner.spec.template?.spec?.containers?.find((value) => value.name === 'api')?.image !== expectedImage ||
        owner.spec.template?.metadata?.annotations?.['rivet.dev/execution-retirement-fence'] ||
        !Array.isArray(pods.items) ||
        pods.items.length !== snapshot.pods.length ||
        snapshot.pods.some(
          (sample) =>
            !pods.items.some(
              (pod) =>
                pod.metadata?.uid === sample.uid &&
                pod.metadata.name === sample.name &&
                !pod.metadata.deletionTimestamp &&
                pod.status?.phase === 'Running' &&
                pod.metadata.ownerReferences?.some(
                  (ref) =>
                    ref.controller &&
                    ref.kind === 'StatefulSet' &&
                    ref.name === workload.name &&
                    ref.uid === snapshot.uid,
                ) &&
                (!sample.ready ||
                  pod.status.conditions?.some((value) => value.type === 'Ready' && value.status === 'True')),
            ),
        )
      )
        throw new Error('Execution capacity changed during rollout headroom inspection.');
      const observedAt = now();
      for (const pod of snapshot.pods)
        pod.sampleFresh &&=
          observedAt - pod.cpuSampleAt >= -5_000 && observedAt - pod.cpuSampleAt <= policy.metricsMaxAgeSeconds * 1000;
      observation = assessHaExecutionHeadroom(snapshot, policy, departing);
    } catch (cause) {
      await artifact(
        `ha-headroom-${randomUUID()}.json`,
        JSON.stringify(
          {
            ...base,
            outcome: 'blocked',
            reason: 'Execution demand, metrics or ownership is unconfirmed.',
          },
          null,
          2,
        ),
      );
      throw new Error(
        'HA rollout headroom is unconfirmed; no further owner withdrawal is allowed. Inspect fresh execution metrics before recovery.',
        { cause },
      );
    }
    await artifact(
      `ha-headroom-${randomUUID()}.json`,
      JSON.stringify(
        {
          ...base,
          ...observation,
          outcome: observation.sufficient ? 'passed' : 'blocked',
        },
        null,
        2,
      ),
    );
    if (!observation.sufficient)
      throw new Error(
        `HA rollout has insufficient measured headroom: ${observation.requiredServingOwners} execution owners required, ${observation.availableServingOwners} available${departing ? ' after withdrawal' : ''}. Wait for ready capacity within the approved limit before exact recovery; do not change ordinals manually.`,
      );
  };
}

export function assessHaExecutionHeadroom(snapshot, input, departing) {
  const policy = autoscalerPolicy(input);
  // A journal-owned surge may be one above the ordinary autoscaler maximum.
  // Use the existing strict snapshot validation, but never use its clamped
  // recommendation to accept demand that already exceeds the approved ceiling.
  if (snapshot.replicas > policy.maxReplicas + 1)
    throw new Error('Execution rollout inventory exceeds the approved surge bound.');
  recommendExecutionReplicas(snapshot, { ...policy, maxReplicas: Math.max(policy.maxReplicas, snapshot.replicas) });
  if (departing && !snapshot.pods.some((pod) => pod.name === departing.name && pod.uid === departing.uid))
    throw new Error('Departing execution owner changed during demand inspection.');
  const slots = snapshot.pods.reduce((sum, pod) => sum + pod.active, 0);
  const cpu = snapshot.pods.reduce((sum, pod) => sum + pod.cpuRatio, 0);
  const limit = snapshot.pods[0].limit;
  const available = snapshot.pods.filter(
    (pod) => pod.ready && pod.state === 'serving' && !pod.operationId && pod.uid !== departing?.uid,
  ).length;
  const required = Math.max(
    policy.minReplicas,
    Math.ceil(slots / ((limit * policy.targetSlotsPercent) / 100)),
    Math.ceil(cpu / (policy.targetCpuPercent / 100)),
  );
  return {
    replicas: snapshot.replicas,
    availableServingOwners: available,
    requiredServingOwners: required,
    activeSlots: slots,
    admissionLimitPerOwner: limit,
    totalCpuRequestRatio: cpu,
    targetSlotsPercent: policy.targetSlotsPercent,
    targetCpuPercent: policy.targetCpuPercent,
    spareOwnersAtTarget: available - required,
    sufficient: available >= required,
    owners: snapshot.pods.map(({ name, uid, incarnation }) => ({ name, uid, incarnation })),
  };
}

/** The deployment owner pauses proxy downscale. Measure ordinary serving
 * baseline, never count its temporary maxSurge pod as durable capacity. */
export function createHaProxyHeadroomGuard({
  kube,
  release,
  namespace,
  resources,
  artifact = async () => {},
  now = Date.now,
  metricsMaxAgeSeconds = 90,
}) {
  const proxy = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.labels?.['app.kubernetes.io/component'] === 'proxy',
  );
  const hpa = resources.find(
    (resource) =>
      resource.kind === 'HorizontalPodAutoscaler' &&
      resource.spec.scaleTargetRef?.kind === 'Deployment' &&
      resource.spec.scaleTargetRef.name === proxy?.metadata.name,
  );
  if (!hpa) return async () => {};
  const target = hpa.spec.metrics?.find(
    (metric) =>
      metric.type === 'Resource' && metric.resource?.name === 'cpu' && metric.resource.target?.type === 'Utilization',
  )?.resource.target.averageUtilization;
  if (
    !Number.isSafeInteger(target) ||
    target < 1 ||
    target > 100 ||
    hpa.spec.metrics.length !== 1 ||
    !Number.isSafeInteger(metricsMaxAgeSeconds) ||
    metricsMaxAgeSeconds < 1 ||
    proxy.spec.strategy?.rollingUpdate?.maxSurge !== 1 ||
    proxy.spec.strategy?.rollingUpdate?.maxUnavailable !== 0
  )
    throw new Error('Proxy rollout headroom requires its CPU HPA and zero-unavailable, one-surge policy.');
  const selector = proxy.spec.selector?.matchLabels;
  if (!selector || !Object.keys(selector).length || proxy.spec.selector.matchExpressions?.length)
    throw new Error('Proxy rollout selector is unconfirmed.');
  const query = `?labelSelector=${encodeURIComponent(
    Object.entries(selector)
      .map(([key, value]) => `${key}=${value}`)
      .join(','),
  )}`;
  const ns = encodeURIComponent(namespace),
    workload = proxy.metadata.name;
  const get = async (requestPath) => JSON.parse((await kube(['get', '--raw', requestPath])).stdout);
  let workloadUid;
  return async ({ stage = 'retirement' } = {}) => {
    const base = {
      protocol: 1,
      observedAt: new Date(now()).toISOString(),
      stage,
      workload,
      autoscalingFrozen: false,
      scaleDownPaused: stage !== 'preflight',
      automaticBurstScaling: true,
    };
    let result;
    try {
      const owner = await get(`/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(workload)}`);
      if (
        !owner.metadata?.uid ||
        (workloadUid && owner.metadata.uid !== workloadUid) ||
        owner.metadata.labels?.['app.kubernetes.io/instance'] !== release ||
        owner.metadata.labels?.['app.kubernetes.io/component'] !== 'proxy' ||
        !Number.isSafeInteger(owner.spec.replicas) ||
        owner.spec.replicas < hpa.spec.minReplicas ||
        owner.spec.replicas > hpa.spec.maxReplicas
      )
        throw new Error('Proxy rollout identity or capacity changed.');
      workloadUid = owner.metadata.uid;
      const [sets, pods, metrics] = await Promise.all([
        get(`/apis/apps/v1/namespaces/${ns}/replicasets${query}`),
        get(`/api/v1/namespaces/${ns}/pods${query}`),
        get(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods${query}`),
      ]);
      if (![sets, pods, metrics].every((value) => Array.isArray(value.items)))
        throw new Error('Proxy rollout metrics are unavailable.');
      const ownedSets = new Set(
        sets.items
          .filter((set) =>
            set.metadata.ownerReferences?.some(
              (ref) => ref.controller && ref.kind === 'Deployment' && ref.name === workload && ref.uid === workloadUid,
            ),
          )
          .map((set) => set.metadata.uid),
      );
      const samples = pods.items
        .filter((pod) => !['Succeeded', 'Failed'].includes(pod.status?.phase))
        .map((pod) => {
          if (
            !pod.metadata.uid ||
            !pod.metadata.ownerReferences?.some(
              (ref) => ref.controller && ref.kind === 'ReplicaSet' && ownedSets.has(ref.uid),
            )
          )
            throw new Error('Proxy pod ownership changed.');
          const sample = metrics.items.find((value) => value.metadata.name === pod.metadata.name);
          const age = now() - Date.parse(sample?.timestamp);
          if (!Number.isFinite(age) || age < -5000 || age > metricsMaxAgeSeconds * 1000)
            throw new PendingProxyMetrics('Proxy CPU sample is missing or stale.');
          let requestCpu = 0,
            usageCpu = 0;
          for (const container of pod.spec.containers) {
            const request = cpuQuantity(container.resources?.requests?.cpu);
            if (!(request > 0)) throw new Error('Proxy CPU request is unavailable.');
            requestCpu += request;
            usageCpu += cpuQuantity(sample.containers?.find((value) => value.name === container.name)?.usage?.cpu);
          }
          return {
            name: pod.metadata.name,
            uid: pod.metadata.uid,
            requestCpu,
            usageCpu,
            sampleAt: Date.parse(sample.timestamp),
            ready:
              !pod.metadata.deletionTimestamp &&
              pod.status?.conditions?.some((value) => value.type === 'Ready' && value.status === 'True'),
          };
        });
      if (
        !samples.length ||
        samples.length > owner.spec.replicas + 1 ||
        new Set(samples.map((value) => value.uid)).size !== samples.length
      )
        throw new Error('Proxy rollout inventory is incomplete or outside the surge bound.');
      const ready = samples.filter((value) => value.ready);
      const available = Math.min(owner.spec.replicas, ready.length);
      const usageCpu = samples.reduce((sum, value) => sum + value.usageCpu, 0);
      const minimumRequest = Math.min(...samples.map((value) => value.requestCpu));
      const required = Math.max(hpa.spec.minReplicas, Math.ceil(usageCpu / ((minimumRequest * target) / 100)));
      // Confirm the observed identities after reading metrics, including Pod
      // replacements that can otherwise reuse an old name's CPU observation.
      const [confirmedOwner, confirmedPods] = await Promise.all([
        get(`/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(workload)}`),
        get(`/api/v1/namespaces/${ns}/pods${query}`),
      ]);
      const confirmedActive = Array.isArray(confirmedPods.items)
        ? confirmedPods.items.filter((pod) => !['Succeeded', 'Failed'].includes(pod.status?.phase))
        : [];
      if (
        confirmedOwner.metadata.uid !== workloadUid ||
        confirmedOwner.metadata.generation !== owner.metadata.generation ||
        confirmedOwner.spec.replicas !== owner.spec.replicas ||
        samples.some((sample) => now() - sample.sampleAt > metricsMaxAgeSeconds * 1000) ||
        !Array.isArray(confirmedPods.items) ||
        confirmedActive.length !== samples.length ||
        samples.some(
          (sample) =>
            !confirmedActive.some(
              (pod) =>
                pod.metadata.uid === sample.uid &&
                pod.metadata.name === sample.name &&
                (!sample.ready ||
                  (!pod.metadata.deletionTimestamp &&
                    pod.status?.conditions?.some((value) => value.type === 'Ready' && value.status === 'True'))),
            ),
        )
      )
        throw new Error('Proxy observation changed during CPU inspection.');
      result = {
        workloadUid,
        replicas: owner.spec.replicas,
        availableServingOwners: available,
        requiredServingOwners: required,
        totalCpuCores: usageCpu,
        targetCpuPercent: target,
        spareOwnersAtTarget: available - required,
        sufficient: available === owner.spec.replicas && available >= required,
        owners: samples.map(({ name, uid }) => ({ name, uid })),
      };
    } catch (cause) {
      await artifact(
        `ha-proxy-headroom-${randomUUID()}.json`,
        JSON.stringify(
          {
            ...base,
            outcome: 'blocked',
            reason: 'Proxy CPU demand, metrics or ownership is unconfirmed.',
          },
          null,
          2,
        ),
      );
      throw new Error('HA proxy headroom is unconfirmed; no further rollout withdrawal is allowed.', { cause });
    }
    await artifact(
      `ha-proxy-headroom-${randomUUID()}.json`,
      JSON.stringify(
        {
          ...base,
          ...result,
          outcome: result.sufficient ? 'passed' : 'blocked',
        },
        null,
        2,
      ),
    );
    if (!result.sufficient)
      throw new Error(
        `HA proxy headroom is insufficient: ${result.requiredServingOwners} owners required, ${result.availableServingOwners} available. Wait for fresh ready capacity before recovery; the approved cap and provisioning time still apply.`,
      );
  };
}
