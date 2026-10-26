import { createHash } from 'node:crypto';
import { autoscalerPolicy, autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import { journalForReleaseOperation, releaseOperationJournalName } from './release-operation-journal.mjs';

const releaseLabel = 'app.kubernetes.io/instance';
const componentLabel = 'app.kubernetes.io/component';
const workloadKinds = new Set(['Deployment', 'StatefulSet']);
const controllerKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'CronJob']);
const terminal = (pod) => ['Succeeded', 'Failed'].includes(pod.status?.phase);
const key = (resource) => `${resource.kind}/${resource.metadata?.name}`;
const owner = (resource) => resource.metadata?.ownerReferences?.find((reference) => reference.controller === true);
const images = (template) =>
  ['containers', 'initContainers']
    .flatMap((group) => (template?.spec?.[group] ?? []).map(({ name, image }) => ({ group, name, image })))
    .sort((a, b) => `${a.group}/${a.name}`.localeCompare(`${b.group}/${b.name}`));
const hasImages = (actual, expected) =>
  images(expected).every((image) =>
    images(actual).some(
      (value) => value.group === image.group && value.name === image.name && value.image === image.image,
    ),
  );
const selected = (labels, selector) =>
  Object.entries(selector?.matchLabels ?? {}).every(([name, value]) => labels?.[name] === value) &&
  (selector?.matchExpressions ?? []).every(({ key: name, operator, values = [] }) => {
    const present = Object.hasOwn(labels ?? {}, name);
    if (operator === 'In') return present && values.includes(labels[name]);
    if (operator === 'NotIn') return !present || !values.includes(labels[name]);
    if (operator === 'Exists') return present;
    if (operator === 'DoesNotExist') return !present;
    return false;
  });
const sameOwner = (resource, controller) => {
  const reference = owner(resource);
  return (
    reference?.kind === controller.kind &&
    reference.name === controller.metadata.name &&
    reference.uid === controller.metadata.uid
  );
};

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [name, canonical(value[name])]),
        )
      : value;
const serialized = (value) => JSON.stringify(canonical(value));
const digest = (value) => createHash('sha256').update(serialized(value)).digest('hex');
const sorted = (values) => values.map(canonical).sort((a, b) => serialized(a).localeCompare(serialized(b)));

// Kubernetes API defaults, not controller-manager settings: an omitted downscale
// window remains unspecified, since the cluster can override its usual 300s.
function hpaPolicy(resource) {
  const spec = resource.spec ?? {};
  const rules = (direction) => {
    const value = spec.behavior?.[direction] ?? {};
    return {
      ...value,
      selectPolicy: value.selectPolicy ?? 'Max',
      stabilizationWindowSeconds: value.stabilizationWindowSeconds ?? (direction === 'scaleUp' ? 0 : null),
      policies: sorted(
        value.policies ??
          (direction === 'scaleUp'
            ? [
                { type: 'Pods', value: 4, periodSeconds: 15 },
                { type: 'Percent', value: 100, periodSeconds: 15 },
              ]
            : [{ type: 'Percent', value: 100, periodSeconds: 15 }]),
      ),
    };
  };
  return {
    ...spec,
    minReplicas: spec.minReplicas ?? 1,
    metrics: sorted(
      spec.metrics?.length
        ? spec.metrics
        : [
            {
              type: 'Resource',
              resource: {
                name: 'cpu',
                target: { type: 'Utilization', averageUtilization: 80 },
              },
            },
          ],
    ),
    behavior: { ...spec.behavior, scaleUp: rules('scaleUp'), scaleDown: rules('scaleDown') },
  };
}

function autoscalerBinding(template) {
  const bindings = (template?.spec?.containers ?? []).flatMap((container) =>
    (container.env ?? [])
      .filter((entry) => entry.name === 'RIVET_AUTOSCALER_CONFIG')
      .map((entry) => ({ container: container.name, entry })),
  );
  if (bindings.length !== 1 || typeof bindings[0].entry.value !== 'string' || bindings[0].entry.valueFrom)
    throw new Error('Release settlement autoscaler configuration must be one literal binding.');
  let config;
  try {
    config = JSON.parse(bindings[0].entry.value);
  } catch {
    throw new Error('Release settlement autoscaler configuration is invalid.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Release settlement autoscaler configuration is invalid.');
  return { container: bindings[0].container, config };
}

function executionAutoscaler(resources, release, namespace) {
  const candidates = resources.filter(
    (resource) => resource.kind === 'Deployment' && resource.metadata?.labels?.[componentLabel] === 'autoscaler',
  );
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw new Error('Release settlement rendered duplicate execution autoscalers.');
  const candidate = candidates[0];
  const binding = autoscalerBinding(candidate.spec?.template);
  const { config } = binding;
  if (
    candidate.spec?.replicas !== 1 ||
    config.release !== release ||
    config.namespace !== namespace ||
    !config.workload
  )
    throw new Error('Release settlement execution autoscaler must be active with the expected target identity.');
  autoscalerPolicy(config.policy);
  return { candidate, binding };
}

function replicaBounds(resources, expected, release, namespace) {
  const bounds = new Map(
    expected.map((resource) => [
      key(resource),
      {
        min: resource.spec.replicas ?? 1,
        max: resource.spec.replicas ?? 1,
        automatic: false,
      },
    ]),
  );
  const automatic = (target, min, max) => {
    if (
      !bounds.has(target) ||
      bounds.get(target).automatic ||
      !Number.isInteger(min) ||
      min < 1 ||
      !Number.isInteger(max) ||
      max < min
    )
      throw new Error('Release settlement autoscaling policy is inconsistent with rendered workloads.');
    bounds.set(target, { min, max, automatic: true });
  };
  for (const resource of resources) {
    if (resource.kind === 'HorizontalPodAutoscaler') {
      automatic(
        `${resource.spec?.scaleTargetRef?.kind}/${resource.spec?.scaleTargetRef?.name}`,
        resource.spec?.minReplicas ?? 1,
        resource.spec?.maxReplicas,
      );
    }
  }
  const execution = executionAutoscaler(resources, release, namespace);
  if (execution) {
    const { config } = execution.binding;
    automatic(`StatefulSet/${config.workload}`, config.policy?.minReplicas, config.policy?.maxReplicas);
  }
  return bounds;
}

/** Inspect a read-only namespace inventory. No settings, environment values or
 * Kubernetes error messages are copied into the returned diagnostic receipt. */
export function inspectReleaseSettlement({ resources, items, release, namespace, retainedExecution = [] }) {
  if (!Array.isArray(resources) || !Array.isArray(items) || !release || !namespace)
    throw new Error('Release settlement requires rendered resources and a namespace inventory.');
  const expected = resources.filter((resource) => workloadKinds.has(resource.kind));
  if (
    !expected.length ||
    expected.some(
      (resource) =>
        resource.metadata?.labels?.[releaseLabel] !== release ||
        (resource.metadata.namespace && resource.metadata.namespace !== namespace) ||
        !resource.metadata.name ||
        !(resource.spec?.template?.spec?.containers?.length > 0),
    )
  )
    throw new Error('Release settlement workload identity is missing or inconsistent.');
  if (new Set(expected.map(key)).size !== expected.length)
    throw new Error('Release settlement rendered duplicate workload identities.');
  const bounds = replicaBounds(resources, expected, release, namespace);
  if (
    !Array.isArray(retainedExecution) ||
    new Set(retainedExecution.map((r) => r.name)).size !== retainedExecution.length ||
    retainedExecution.some(
      (r) =>
        !r.uid ||
        !r.revision ||
        !Number.isSafeInteger(r.replicas) ||
        r.replicas < 2 ||
        !Array.isArray(r.pods) ||
        r.pods.length !== r.replicas ||
        r.pods.some((uid) => !uid) ||
        new Set(r.pods).size !== r.pods.length ||
        !expected.some(
          (w) =>
            w.kind === 'StatefulSet' &&
            w.metadata.name === r.name &&
            w.metadata.labels?.[componentLabel] === 'execution',
        ),
    )
  )
    throw Error('Retained topology execution identity is incomplete or outside this release.');
  const retained = (controller) =>
    retainedExecution.find((r) => controller.kind === 'StatefulSet' && r.name === controller.metadata.name);
  const pending = new Set();
  const note = (resource, reason) => pending.add(`${key(resource)}: ${reason}`);
  const inNamespace = (resource) => resource.metadata?.namespace === namespace;
  const belongs = (resource) => inNamespace(resource) && resource.metadata?.labels?.[releaseLabel] === release;
  const controllers = items.filter((resource) => controllerKinds.has(resource.kind));
  const expectedKeys = new Set(expected.map(key));
  for (const controller of controllers.filter(belongs)) {
    if (!expectedKeys.has(key(controller))) note(controller, 'unexpected release controller remains');
  }
  const live = [];
  const execution = executionAutoscaler(resources, release, namespace);
  const checkExecutionConfig = (resource, template) => {
    try {
      if (serialized(autoscalerBinding(template)) === serialized(execution.binding)) return;
    } catch {
      /* A missing, duplicated or nonliteral setting is not the rendered policy. */
    }
    note(resource, 'execution autoscaler configuration differs from the rendered policy or target');
  };
  for (const candidate of expected) {
    const matches = controllers.filter((resource) => key(resource) === key(candidate) && inNamespace(resource));
    if (matches.length !== 1) {
      note(candidate, 'expected controller is missing or ambiguous');
      continue;
    }
    const controller = matches[0];
    live.push({ candidate, controller });
    if (
      !belongs(controller) ||
      !controller.metadata.uid ||
      controller.metadata.labels?.[componentLabel] !== candidate.metadata.labels?.[componentLabel]
    )
      note(controller, 'controller identity does not match the release');
    if (controller.metadata.deletionTimestamp) note(controller, 'controller is terminating');
    if (
      !Number.isInteger(controller.metadata.generation) ||
      !Number.isInteger(controller.status?.observedGeneration) ||
      controller.status.observedGeneration < controller.metadata.generation
    )
      note(controller, 'controller has not observed its current generation');
    if (!Number.isInteger(controller.spec?.replicas) || controller.spec.replicas < 0)
      note(controller, 'controller desired replicas are invalid');
    const allowed = bounds.get(key(candidate));
    if (controller.spec?.replicas < allowed.min || controller.spec?.replicas > allowed.max)
      note(controller, 'live desired replicas are outside the rendered capacity policy');
    if (!hasImages(controller.spec?.template, candidate.spec.template))
      note(controller, 'controller template does not use candidate images');
    if (candidate === execution?.candidate) checkExecutionConfig(controller, controller.spec?.template);
    if (!selected(controller.spec?.template?.metadata?.labels, candidate.spec.selector))
      note(controller, 'controller template does not match the candidate selector');
    const desired = controller.spec?.replicas;
    const prior = retained(controller);
    if (prior && (controller.metadata.uid !== prior.uid || desired !== prior.replicas))
      note(controller, 'retained topology execution controller identity or capacity changed');
    if (
      (controller.status?.replicas ?? 0) !== desired ||
      (controller.status?.readyReplicas ?? 0) !== desired ||
      (!prior && (controller.status?.updatedReplicas ?? 0) !== desired)
    )
      note(controller, 'current, ready and updated replicas have not reached live desired capacity');
    if (controller.kind === 'Deployment' && (controller.status?.availableReplicas ?? 0) !== desired)
      note(controller, 'desired replicas are not yet available');
    if (
      controller.status?.conditions?.some(
        (condition) =>
          (condition.type === 'Progressing' && condition.status === 'False') ||
          (condition.type === 'ReplicaFailure' && condition.status === 'True'),
      )
    )
      note(controller, 'controller reports a rollout failure');
  }

  const replicaSets = items.filter((resource) => resource.kind === 'ReplicaSet' && inNamespace(resource));
  const jobs = items.filter((resource) => resource.kind === 'Job' && inNamespace(resource));
  const migrationJobs = jobs.filter(
    (job) => belongs(job) && job.metadata.labels?.[componentLabel] === 'workflow-schema-migration' && job.metadata.uid,
  );
  for (const job of jobs.filter(belongs)) {
    if (!migrationJobs.includes(job)) note(job, 'unexpected release job remains');
    else if (
      !job.status?.conditions?.some(
        (condition) => ['Complete', 'Failed'].includes(condition.type) && condition.status === 'True',
      )
    )
      note(job, 'schema migration has not finished');
  }
  for (const replicaSet of replicaSets.filter(
    (resource) => belongs(resource) || live.some(({ controller }) => sameOwner(resource, controller)),
  )) {
    const deployment = live.find(
      ({ controller }) => controller.kind === 'Deployment' && sameOwner(replicaSet, controller),
    )?.controller;
    if (!deployment) note(replicaSet, 'ReplicaSet has no expected deployment owner');
    else if (
      replicaSet.metadata.annotations?.['deployment.kubernetes.io/revision'] !==
        deployment.metadata.annotations?.['deployment.kubernetes.io/revision'] &&
      ((replicaSet.spec?.replicas ?? 0) !== 0 || (replicaSet.status?.replicas ?? 0) !== 0)
    )
      note(replicaSet, 'superseded ReplicaSet has not reached zero replicas');
  }

  const releasePods = items.filter(
    (resource) =>
      resource.kind === 'Pod' &&
      inNamespace(resource) &&
      (belongs(resource) ||
        live.some(({ controller }) => sameOwner(resource, controller)) ||
        replicaSets.some(
          (replicaSet) =>
            sameOwner(resource, replicaSet) && live.some(({ controller }) => sameOwner(replicaSet, controller)),
        )),
  );
  const workloads = live
    .map(({ candidate, controller }) => {
      const prior = retained(controller);
      const owned = releasePods.filter((pod) =>
        controller.kind === 'StatefulSet'
          ? sameOwner(pod, controller)
          : replicaSets.some((replicaSet) => sameOwner(replicaSet, controller) && sameOwner(pod, replicaSet)),
      );
      if (owned.length !== controller.spec?.replicas) note(controller, 'pod count differs from live desired replicas');
      if (prior && (owned.length !== prior.pods.length || owned.some((p) => !prior.pods.includes(p.metadata.uid))))
        note(controller, 'retained topology execution pod identities changed');
      for (const pod of owned) {
        if (
          !belongs(pod) ||
          !pod.metadata.uid ||
          !selected(pod.metadata.labels, controller.spec.selector) ||
          !selected(pod.metadata.labels, candidate.spec.selector)
        )
          note(pod, 'pod identity or selector does not match its controller');
        if (pod.metadata.deletionTimestamp) note(pod, 'pod is terminating');
        if (terminal(pod)) note(pod, 'workload pod is terminal');
        if (
          pod.status?.phase !== 'Running' ||
          !pod.status.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')
        )
          note(pod, 'pod is not Ready');
        if (!hasImages(pod, candidate.spec.template)) note(pod, 'pod does not use candidate images');
        if (candidate === execution?.candidate) checkExecutionConfig(pod, pod);
        if (controller.kind === 'StatefulSet') {
          if (
            !(prior?.revision ?? controller.status?.updateRevision) ||
            pod.metadata.labels?.['controller-revision-hash'] !== (prior?.revision ?? controller.status.updateRevision)
          )
            note(pod, 'pod has not adopted the desired StatefulSet revision');
        } else {
          const replicaSet = replicaSets.find(
            (resource) => sameOwner(pod, resource) && sameOwner(resource, controller),
          );
          const revision = controller.metadata.annotations?.['deployment.kubernetes.io/revision'];
          if (
            !revision ||
            replicaSet?.metadata.annotations?.['deployment.kubernetes.io/revision'] !== revision ||
            !hasImages(replicaSet?.spec?.template, candidate.spec.template) ||
            !replicaSet.metadata.labels?.['pod-template-hash'] ||
            pod.metadata.labels?.['pod-template-hash'] !== replicaSet.metadata.labels['pod-template-hash']
          )
            note(pod, 'pod has not adopted the desired Deployment revision');
        }
      }
      return {
        kind: controller.kind,
        name: controller.metadata.name,
        uid: controller.metadata.uid,
        generation: controller.metadata.generation,
        desiredReplicas: controller.spec?.replicas,
        readyReplicas: controller.status?.readyReplicas ?? 0,
        revision:
          controller.kind === 'StatefulSet'
            ? controller.status?.updateRevision
            : controller.metadata.annotations?.['deployment.kubernetes.io/revision'],
        ...(prior ? { retainedSourceRevision: prior.revision } : {}),
        images: images(candidate.spec.template),
        pods: owned.map((pod) => pod.metadata.uid).sort(),
      };
    })
    .sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  for (const pod of releasePods) {
    if (workloads.some((workload) => workload.pods.includes(pod.metadata.uid))) continue;
    if (terminal(pod) && !pod.metadata.deletionTimestamp && migrationJobs.some((job) => sameOwner(pod, job))) continue;
    note(pod, 'unexpected or superseded release pod remains');
  }
  const pods = releasePods
    .filter((pod) => workloads.some((workload) => workload.pods.includes(pod.metadata.uid)))
    .map((pod) => ({ name: pod.metadata.name, uid: pod.metadata.uid }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const expectedHpas = resources.filter((resource) => resource.kind === 'HorizontalPodAutoscaler');
  const hpas = items.filter((resource) => resource.kind === 'HorizontalPodAutoscaler' && inNamespace(resource));
  const autoscalers = [];
  for (const candidate of expectedHpas) {
    if (
      candidate.metadata?.labels?.[releaseLabel] !== release ||
      !candidate.metadata.name ||
      (candidate.metadata.namespace && candidate.metadata.namespace !== namespace)
    )
      throw new Error('Release settlement HPA identity is inconsistent.');
    const matches = hpas.filter((resource) => key(resource) === key(candidate));
    if (matches.length !== 1) {
      note(candidate, 'expected HPA is missing or ambiguous');
      continue;
    }
    const hpa = matches[0];
    if (
      !belongs(hpa) ||
      !hpa.metadata.uid ||
      hpa.metadata.deletionTimestamp ||
      hpa.metadata.labels?.[componentLabel] !== candidate.metadata.labels?.[componentLabel]
    )
      note(hpa, 'HPA identity does not match the release');
    if (serialized(hpaPolicy(hpa)) !== serialized(hpaPolicy(candidate)))
      note(hpa, 'installed HPA target or policy differs from the rendered configuration');
    // HPAGeneration is optional on supported Kubernetes versions. Both metadata
    // generation and observed-generation fields may be omitted. Validate any
    // supplied number and compare epochs only when the server supplies both.
    if (
      (hpa.metadata.generation != null &&
        (!Number.isInteger(hpa.metadata.generation) || hpa.metadata.generation < 0)) ||
      (hpa.status?.observedGeneration != null &&
        (!Number.isInteger(hpa.status.observedGeneration) ||
          hpa.status.observedGeneration < 0 ||
          (hpa.metadata.generation != null && hpa.status.observedGeneration < hpa.metadata.generation)))
    )
      note(hpa, 'HPA has not observed its current generation');
    if (
      !['AbleToScale', 'ScalingActive'].every((type) =>
        hpa.status?.conditions?.some(
          (condition) =>
            condition.type === type &&
            condition.status === 'True' &&
            (condition.observedGeneration == null ||
              (Number.isInteger(condition.observedGeneration) &&
                condition.observedGeneration >= 0 &&
                (hpa.metadata.generation == null || condition.observedGeneration >= hpa.metadata.generation))),
        ),
      )
    )
      note(hpa, 'HPA scaling or metric availability is not confirmed');
    autoscalers.push({
      kind: hpa.kind,
      name: hpa.metadata.name,
      uid: hpa.metadata.uid,
      generation: hpa.metadata.generation,
      policyDigest: digest(hpaPolicy(hpa)),
    });
  }
  for (const hpa of hpas) {
    const target = `${hpa.spec?.scaleTargetRef?.kind}/${hpa.spec?.scaleTargetRef?.name}`;
    if (!expectedHpas.some((candidate) => key(candidate) === key(hpa)) && (belongs(hpa) || expectedKeys.has(target)))
      note(hpa, 'unexpected HPA may compete for release capacity');
  }
  if (execution)
    autoscalers.push({
      kind: execution.candidate.kind,
      name: execution.candidate.metadata.name,
      policyDigest: digest(execution.binding),
      activation: 'requires-post-release-observation',
    });
  autoscalers.sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  return {
    settled: pending.size === 0,
    pending: [...pending].sort(),
    workloads,
    pods,
    autoscalers,
    fingerprint: digest({ workloads, pods, autoscalers }),
  };
}

/** Wait for candidate workload settlement at live autoscaled capacity. This is
 * infrastructure acceptance; public traffic and application checks are separate. */
export async function waitForReleaseSettlement({
  kube,
  resources,
  release,
  namespace,
  timeoutMs,
  stableMs = 30_000,
  retainedExecution = [],
  clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  artifact = async () => {},
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(stableMs) || stableMs < 0)
    throw new Error('Release settlement timeout and stability window must be valid durations.');
  const startedAt = clock.now();
  // Exact-token recovery reuses its artifact directory. Clear prior successful
  // evidence before any read can fail or this observation can be interrupted.
  await artifact(
    'release-settlement.json',
    JSON.stringify(
      {
        release,
        namespace,
        observedAt: new Date(startedAt).toISOString(),
        elapsedMs: 0,
        stableMs: 0,
        healthy: false,
        settled: false,
        pending: ['release settlement observation is in progress'],
      },
      null,
      2,
    ),
  );
  // A slow management-plane read is not evidence that workloads stayed healthy
  // throughout the blind interval. Allow ordinary list latency, but require
  // repeated fresh observations within the stability window.
  const maximumObservationGapMs = Math.max(2_500, Math.min(10_000, stableMs / 2));
  let stableSince = null;
  let previousFingerprint;
  let previousObservedAt = null;
  while (true) {
    const response = await kube([
      'get',
      'deployment,statefulset,daemonset,replicationcontroller,cronjob,replicaset,job,pod,hpa',
      '--namespace',
      namespace,
      '-o',
      'json',
    ]);
    let items;
    try {
      items = JSON.parse(response.stdout).items;
    } catch {
      throw new Error('Could not parse release settlement inventory.');
    }
    const inspection = inspectReleaseSettlement({ resources, items, release, namespace, retainedExecution });
    const now = clock.now();
    if (!inspection.settled) stableSince = null;
    else if (
      stableSince === null ||
      previousFingerprint !== inspection.fingerprint ||
      previousObservedAt === null ||
      now < previousObservedAt ||
      now - previousObservedAt > maximumObservationGapMs
    )
      stableSince = now;
    previousFingerprint = inspection.fingerprint;
    previousObservedAt = now;
    const complete = inspection.settled && now - stableSince >= stableMs && now - startedAt <= timeoutMs;
    const report = {
      release,
      namespace,
      observedAt: new Date(now).toISOString(),
      elapsedMs: now - startedAt,
      stableMs: stableSince === null ? 0 : now - stableSince,
      ...inspection,
      healthy: inspection.settled,
      settled: complete,
    };
    if (complete) {
      await artifact('release-settlement.json', JSON.stringify(report, null, 2));
      return report;
    }
    if (now - startedAt >= timeoutMs) {
      await artifact('release-settlement.json', JSON.stringify(report, null, 2));
      const reason =
        inspection.pending.join('; ') ||
        (now - startedAt > timeoutMs
          ? 'final observation arrived after the deadline'
          : 'healthy workload identities have not remained stable long enough');
      throw new Error(`Release workload settlement timed out: ${reason}.`);
    }
    await clock.sleep(Math.min(1000, timeoutMs - (now - startedAt)));
  }
}

/** Observe a successful execution-autoscaler tick only after the deploying caller
 * has released its shared journal lease. This never reopens or mutates a rollout;
 * a timeout means activation is unconfirmed, not that the deployed release failed. */
export async function waitForExecutionAutoscalerActivation({
  kube,
  resources,
  release,
  namespace,
  timeoutMs,
  after,
  clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  artifact = async () => {},
}) {
  const execution = executionAutoscaler(resources, release, namespace);
  if (!execution) return { release, namespace, activated: true, skipped: true };
  const startedAt = clock.now();
  after ??= startedAt;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(after) || after < 0 || after > startedAt)
    throw new Error('Execution autoscaler activation timing is invalid.');
  const { config } = execution.binding;
  if (typeof config.manifestDigest !== 'string' || !config.manifestDigest)
    throw new Error('Execution autoscaler activation requires the rendered manifest identity.');
  const policy = autoscalerPolicy(config.policy);
  const policyDigest = autoscalerPolicyDigest(policy);
  await artifact(
    'execution-autoscaler-activation.json',
    JSON.stringify(
      {
        release,
        namespace,
        activated: false,
        observedAt: new Date(startedAt).toISOString(),
        elapsedMs: 0,
        manifestDigest: config.manifestDigest,
        policyDigest,
        pending: 'execution autoscaler activation observation is in progress',
      },
      null,
      2,
    ),
  );
  while (true) {
    let record;
    let pending = 'waiting for a fresh completed autoscaler observation after release';
    try {
      const response = await kube([
        'get',
        'configmap',
        releaseOperationJournalName(release),
        '--namespace',
        namespace,
        '--ignore-not-found',
        '-o',
        'json',
      ]);
      const cm = response.stdout.trim() ? JSON.parse(response.stdout) : null;
      if (cm) {
        if (
          cm.metadata?.name !== releaseOperationJournalName(release) ||
          cm.metadata.namespace !== namespace ||
          cm.metadata.labels?.[releaseLabel] !== release ||
          !cm.metadata.uid ||
          cm.metadata.deletionTimestamp
        )
          throw new Error('Journal identity is unconfirmed.');
        record = journalForReleaseOperation(
          { ...JSON.parse(cm.data.record), resourceVersion: cm.metadata.resourceVersion },
          'autoscaling',
          { release, namespace },
          clock.now,
        );
      }
    } catch {
      pending = 'shared journal is owned, unavailable or its identity is unconfirmed';
    }
    const now = clock.now();
    const observations = [record?.lastSampleAt, record?.lastScaleAt].filter(
      (value) => Number.isFinite(value) && value > 0,
    );
    const observedAt = observations.length ? Math.max(...observations) : null;
    // An expired lease also occurs after a failed mutation. A fresh demand
    // sample on an unfinished retirement intent does not prove a successful tick.
    const activated =
      record?.autoscalingProtocol === 1 &&
      record.phase === 'complete' &&
      record.manifestDigest === config.manifestDigest &&
      record.policyDigest === policyDigest &&
      record.leaseExpiresAt <= now &&
      observedAt !== null &&
      observedAt >= after &&
      observedAt <= now &&
      now - observedAt <= policy.metricsMaxAgeSeconds * 1000 &&
      now - startedAt <= timeoutMs;
    const report = {
      release,
      namespace,
      activated: !!activated,
      observedAt: new Date(now).toISOString(),
      elapsedMs: now - startedAt,
      manifestDigest: config.manifestDigest,
      policyDigest,
      ...(activated ? { sampleAt: new Date(observedAt).toISOString(), phase: record.phase } : { pending }),
    };
    if (activated || now - startedAt >= timeoutMs) {
      await artifact('execution-autoscaler-activation.json', JSON.stringify(report, null, 2));
      return report;
    }
    await clock.sleep(Math.min(1000, timeoutMs - (now - startedAt)));
  }
}
