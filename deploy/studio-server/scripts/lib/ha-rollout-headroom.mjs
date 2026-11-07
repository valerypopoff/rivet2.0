import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { autoscalerPolicy, recommendExecutionReplicas } from './execution-autoscaler.mjs';
import { readConcurrently } from './read-concurrently.mjs';
import { kubernetesReadRetryReason } from './kubernetes-read-errors.mjs';
import {
  createExecutionAutoscalerIO,
  cpuQuantity,
  PendingExecutionCpuSample,
} from './execution-autoscaler-kubernetes.mjs';

class PendingHeadroomObservation extends Error {}
class PendingHaCapacity extends Error {}

function headroomReader(kube, namespace) {
  const metricsPath = `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`;
  return async (requestPath, args = ['get', '--raw', requestPath]) => {
    let response;
    try {
      response = await kube(args);
    } catch (cause) {
      const reason = kubernetesReadRetryReason(cause, { allowNotFound: requestPath.split('?')[0] === metricsPath });
      if (reason)
        throw new PendingHeadroomObservation(
          `Kubernetes headroom GET unavailable (${reason}); serving owners retained.`,
          { cause },
        );
      throw cause;
    }
    // A paired pool may have no inactive controller yet. Only kubectl's
    // explicit ignore-not-found read can represent that absence as empty.
    if (args.includes('--ignore-not-found') && !response.stdout.trim()) return null;
    // Invalid JSON is a malformed observation, not a retryable API failure.
    return JSON.parse(response.stdout);
  };
}

function cpuOwners(cpu, capacity, samples) {
  const ratio = cpu / capacity;
  // CPU quantities are decimal fractions; summation must not invent an owner
  // when a mathematically integral ratio lands a few floating-point bits above it.
  return Math.ceil(ratio - Number.EPSILON * samples * Math.max(1, ratio));
}

function proxyPodHasFinished(pod) {
  if (['Succeeded', 'Failed'].includes(pod.status?.phase)) return true;
  const containers = [
    ...(pod.spec?.containers ?? []),
    ...(pod.spec?.initContainers ?? []).filter((container) => container.restartPolicy === 'Always'),
    ...(pod.spec?.ephemeralContainers ?? []),
  ];
  const statuses = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.ephemeralContainerStatuses ?? []),
  ];
  return (
    !!pod.metadata.deletionTimestamp &&
    !!pod.spec?.containers?.length &&
    containers.every((container) =>
      statuses.some((status) => status.name === container.name && Number.isInteger(status.state?.terminated?.exitCode)),
    )
  );
}

/** Allow fresh metrics and permitted autoscaling to catch up before retirement.
 * Recheck read-only for at most five minutes within the caller's deadline;
 * ownership, malformed observations and loss of the serving floor still fail. */
export async function waitForHaHeadroom(
  check,
  { timeoutMs, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw Error('Headroom observation requires a bounded timeout.');
  const deadline = now() + Math.min(timeoutMs, 300000);
  let pending;
  for (;;) {
    if (pending && now() >= deadline) throw pending;
    try {
      const result = await check();
      if (now() >= deadline) throw new Error('HA headroom observation deadline exceeded; serving owners retained.');
      return result;
    } catch (error) {
      if (
        !(
          error instanceof PendingHaCapacity ||
          error?.cause instanceof PendingHaCapacity ||
          error?.cause instanceof PendingHeadroomObservation ||
          error?.cause instanceof PendingExecutionCpuSample
        ) ||
        now() >= deadline
      )
        throw error;
      pending = error;
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
  const get = headroomReader(kube, namespace);
  const transport = {
    async json(method, requestPath) {
      if (method !== 'GET') throw new Error('Rollout headroom transport is read-only.');
      const poolPrefix = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets/`;
      if (config.poolWorkloads?.length && requestPath.startsWith(poolPrefix)) {
        const name = decodeURIComponent(requestPath.slice(poolPrefix.length));
        if (!config.poolWorkloads.includes(name)) throw Error('Execution headroom read escaped its paired pools');
        return get(requestPath, ['get', 'statefulset', name, '--ignore-not-found', '-o', 'json']);
      }
      return get(requestPath);
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
        poolWorkloads: config.poolWorkloads,
        now,
      });
      const snapshot = await io.snapshot();
      if (snapshot.uid !== workload.uid || snapshot.startupFence)
        throw new Error('Execution ownership changed during rollout headroom inspection.');
      // Sampling is bounded and concurrent. Recheck owners and the complete
      // set after all execs, so a late failure/scale cannot leave optimistic
      // headroom based on identities that no longer serve this workload.
      const ns = encodeURIComponent(namespace);
      const selector = encodeURIComponent(
        `app.kubernetes.io/instance=${release},app.kubernetes.io/component=execution`,
      );
      const [owner, pods] = await readConcurrently([
        () => transport.json('GET', `/apis/apps/v1/namespaces/${ns}/statefulsets/${encodeURIComponent(workload.name)}`),
        () => transport.json('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`),
      ]);
      if (config.poolWorkloads?.length) {
        // IO already validated the complete paired-pool inventory. This guard
        // assesses the selected owner; peer capacity is assessed at pool fencing.
        pods.items = pods.items.filter((pod) =>
          pod.metadata.ownerReferences?.some(
            (ref) => ref.controller && ref.kind === 'StatefulSet' && ref.uid === snapshot.uid,
          ),
        );
      }
      if (
        owner.metadata?.uid !== snapshot.uid ||
        owner.metadata.deletionTimestamp ||
        !Number.isSafeInteger(owner.spec?.replicas) ||
        owner.spec.replicas < policy.minReplicas ||
        owner.spec.replicas > policy.maxReplicas + 1 ||
        owner.spec.updateStrategy?.type !== 'OnDelete' ||
        owner.spec.template?.spec?.containers?.find((value) => value.name === 'api')?.image !== expectedImage ||
        owner.spec.template?.metadata?.annotations?.['rivet.dev/execution-retirement-fence'] ||
        !Array.isArray(pods.items) ||
        new Set(pods.items.map((pod) => pod.metadata.uid)).size !== pods.items.length ||
        pods.items.some((pod) => {
          const name = pod.metadata.name,
            ordinal = name?.slice(workload.name.length + 1);
          return (
            !pod.metadata.uid ||
            !name?.startsWith(`${workload.name}-`) ||
            !/^\d+$/.test(ordinal) ||
            Number(ordinal) >= owner.spec.replicas ||
            pod.metadata.deletionTimestamp ||
            !['Running', 'Pending'].includes(pod.status?.phase) ||
            !pod.metadata.ownerReferences?.some(
              (ref) =>
                ref.controller && ref.kind === 'StatefulSet' && ref.name === workload.name && ref.uid === snapshot.uid,
            )
          );
        }) ||
        snapshot.pods.some(
          (sample) =>
            !pods.items.some(
              (pod) =>
                pod.metadata?.uid === sample.uid &&
                pod.metadata.name === sample.name &&
                (!sample.ready ||
                  (pod.status.phase === 'Running' &&
                    pod.status.conditions?.some((value) => value.type === 'Ready' && value.status === 'True'))),
            ),
        )
      )
        throw new Error('Execution capacity changed during rollout headroom inspection.');
      const observedAt = now();
      for (const pod of snapshot.pods) {
        if (Number.isFinite(pod.cpuSampleAt) && observedAt - pod.cpuSampleAt > policy.metricsMaxAgeSeconds * 1000)
          throw new PendingExecutionCpuSample('Execution CPU sample expired while confirming rollout capacity.');
        pod.sampleFresh &&=
          observedAt - pod.cpuSampleAt >= -5_000 && observedAt - pod.cpuSampleAt <= policy.metricsMaxAgeSeconds * 1000;
      }
      if (
        owner.spec.replicas !== snapshot.replicas ||
        pods.items.length !== snapshot.pods.length ||
        snapshot.pods.some(
          (pod) => pod.uid !== departing?.uid && (!pod.state || (pod.state === 'serving' && !pod.ready)),
        )
      ) {
        const serving = snapshot.pods.filter(
          (pod) =>
            pod.ready && pod.sampleFresh && pod.state === 'serving' && !pod.operationId && pod.uid !== departing?.uid,
        ).length;
        if (
          owner.spec.replicas >= snapshot.replicas &&
          owner.spec.replicas <= Math.max(snapshot.replicas, policy.maxReplicas) &&
          pods.items.length >= snapshot.pods.length &&
          pods.items.length <= owner.spec.replicas &&
          serving >= policy.minReplicas
        )
          throw new PendingHaCapacity('Owned execution growth is still settling; collect a fresh capacity sample.');
        throw new Error('Execution capacity changed outside permitted growth.');
      }
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
    if (!observation.sufficient) {
      const CapacityError = observation.availableServingOwners >= policy.minReplicas ? PendingHaCapacity : Error;
      throw new CapacityError(
        `HA rollout has insufficient measured headroom: ${observation.requiredServingOwners} execution owners required, ${observation.availableServingOwners} available${departing ? ' after proposed withdrawal' : ''}. Serving owners retained; capacity must be confirmed before retirement.`,
      );
    }
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
  // Autoscaler targets guide ordinary growth; they are not hard rollout limits.
  // Retain total demand, including accepted work draining on the departing owner,
  // so the remaining pool can handle that demand at real admission/CPU capacity.
  const required = Math.max(policy.minReplicas, Math.ceil(slots / limit), cpuOwners(cpu, 1, snapshot.pods.length));
  const target = Math.max(
    policy.minReplicas,
    Math.ceil(slots / ((limit * policy.targetSlotsPercent) / 100)),
    cpuOwners(cpu, policy.targetCpuPercent / 100, snapshot.pods.length),
  );
  return {
    replicas: snapshot.replicas,
    availableServingOwners: available,
    requiredServingOwners: required,
    targetServingOwners: target,
    activeSlots: slots,
    admissionLimitPerOwner: limit,
    totalCpuRequestRatio: cpu,
    targetSlotsPercent: policy.targetSlotsPercent,
    targetCpuPercent: policy.targetCpuPercent,
    spareOwnersAtTarget: available - target,
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
  const get = headroomReader(kube, namespace);
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
      const [sets, pods, metrics] = await readConcurrently([
        () => get(`/apis/apps/v1/namespaces/${ns}/replicasets${query}`),
        () => get(`/api/v1/namespaces/${ns}/pods${query}`),
        () => get(`/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods${query}`),
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
        // Kubelet can report all containers stopped before Pod phase catches up.
        // Those terminating Pods cannot serve or consume CPU, even if their last
        // scrape has already disappeared. Live or unknown containers still wait.
        .filter((pod) => !proxyPodHasFinished(pod))
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
            throw new PendingHeadroomObservation('Proxy CPU sample is missing or stale.');
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
            terminating: !!pod.metadata.deletionTimestamp,
            ready:
              !pod.metadata.deletionTimestamp &&
              pod.status?.conditions?.some((value) => value.type === 'Ready' && value.status === 'True'),
          };
        });
      // Kubernetes excludes terminating Pods from maxSurge. They can still
      // consume CPU while draining, so retain their demand and ownership checks.
      const nonTerminating = samples.filter((value) => !value.terminating);
      if (
        !samples.length ||
        nonTerminating.length > owner.spec.replicas + 1 ||
        new Set(samples.map((value) => value.uid)).size !== samples.length
      )
        throw new Error('Proxy rollout inventory is incomplete or outside the surge bound.');
      const ready = samples.filter((value) => value.ready);
      const available = Math.min(owner.spec.replicas, ready.length);
      const usageCpu = samples.reduce((sum, value) => sum + value.usageCpu, 0);
      const minimumRequest = Math.min(...samples.map((value) => value.requestCpu));
      const required = Math.max(hpa.spec.minReplicas, cpuOwners(usageCpu, minimumRequest, samples.length));
      const targetRequired = Math.max(
        hpa.spec.minReplicas,
        cpuOwners(usageCpu, (minimumRequest * target) / 100, samples.length),
      );
      // Confirm the observed identities after reading metrics, including Pod
      // replacements that can otherwise reuse an old name's CPU observation.
      const confirmedPods = await get(`/api/v1/namespaces/${ns}/pods${query}`);
      // Read the parent after its Pods: a template edit must not look like HPA growth.
      const confirmedOwner = await get(`/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(workload)}`);
      const confirmedActive = Array.isArray(confirmedPods.items)
        ? confirmedPods.items.filter((pod) => !proxyPodHasFinished(pod))
        : [];
      // An already-terminating Pod may finish between reads. Its sampled CPU
      // remains included; every non-terminating owner must still be confirmed.
      const confirmedSamples = samples.filter(
        (sample) => !sample.terminating || confirmedActive.some((pod) => pod.metadata.uid === sample.uid),
      );
      if (
        confirmedOwner.metadata.uid !== workloadUid ||
        !Number.isSafeInteger(confirmedOwner.spec?.replicas) ||
        confirmedOwner.spec.replicas < hpa.spec.minReplicas ||
        confirmedOwner.spec.replicas > hpa.spec.maxReplicas ||
        !isDeepStrictEqual(confirmedOwner.spec, { ...owner.spec, replicas: confirmedOwner.spec.replicas }) ||
        samples.some((sample) => now() - sample.sampleAt > metricsMaxAgeSeconds * 1000) ||
        !Array.isArray(confirmedPods.items) ||
        new Set(confirmedActive.map((pod) => pod.metadata.uid)).size !== confirmedActive.length ||
        confirmedActive.some(
          (pod) =>
            !pod.metadata.uid ||
            !pod.metadata.ownerReferences?.some(
              (ref) => ref.controller && ref.kind === 'ReplicaSet' && ownedSets.has(ref.uid),
            ),
        ) ||
        confirmedSamples.some(
          (sample) =>
            !confirmedActive.some(
              (pod) =>
                pod.metadata.uid === sample.uid &&
                pod.metadata.name === sample.name &&
                (!sample.terminating || !!pod.metadata.deletionTimestamp) &&
                (!sample.ready ||
                  !!pod.metadata.deletionTimestamp ||
                  pod.status?.conditions?.some((value) => value.type === 'Ready' && value.status === 'True')),
            ),
        )
      )
        throw new Error('Proxy observation changed during CPU inspection.');
      const startedDraining = confirmedSamples.some(
        (sample) =>
          !sample.terminating &&
          confirmedActive.some((pod) => pod.metadata.uid === sample.uid && pod.metadata.deletionTimestamp),
      );
      if (
        startedDraining ||
        confirmedOwner.spec.replicas !== owner.spec.replicas ||
        confirmedActive.length !== confirmedSamples.length
      ) {
        // Native RollingUpdate can begin an owned predecessor's drain between
        // the CPU snapshot and confirmation. Keep the two-owner floor and take
        // a fresh sample before any worker retirement, never use stale readiness.
        const stillReady = confirmedActive.filter(
          (pod) =>
            !pod.metadata.deletionTimestamp &&
            pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
        ).length;
        if (
          confirmedOwner.spec.replicas >= owner.spec.replicas &&
          confirmedActive.length >= confirmedSamples.length &&
          confirmedActive.filter((pod) => !pod.metadata.deletionTimestamp).length <= confirmedOwner.spec.replicas + 1 &&
          stillReady >= hpa.spec.minReplicas
        )
          throw new PendingHaCapacity(
            'Owned proxy replacement or growth changed the sample; collect fresh CPU observations.',
          );
        throw new Error('Proxy capacity changed outside its protected rollout bounds.');
      }
      result = {
        workloadUid,
        replicas: owner.spec.replicas,
        availableServingOwners: available,
        requiredServingOwners: required,
        targetServingOwners: targetRequired,
        totalCpuCores: usageCpu,
        targetCpuPercent: target,
        spareOwnersAtTarget: available - targetRequired,
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
    if (!result.sufficient) {
      const CapacityError = result.availableServingOwners >= hpa.spec.minReplicas ? PendingHaCapacity : Error;
      throw new CapacityError(
        `HA proxy headroom is insufficient: ${result.requiredServingOwners} owners required, ${result.availableServingOwners} available. Serving owners retained; capacity must be confirmed before retirement.`,
      );
    }
  };
}
