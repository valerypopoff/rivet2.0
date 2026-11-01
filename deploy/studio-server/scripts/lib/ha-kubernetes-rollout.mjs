import { runHaRollingUpgrade } from './ha-rolling-upgrade.mjs';
import { handoverHousekeeping } from './housekeeping-handover.mjs';
import { inspectBackendOverlap } from './backend-overlap-preflight.mjs';
import { releaseOperationJournalName, journalForReleaseOperation } from './release-operation-journal.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { hasHaPublicEndpoint, waitForHaRoutingWithdrawal } from './ha-routing-withdrawal.mjs';
import {
  createHaExecutionHeadroomGuard,
  createHaProxyHeadroomGuard,
  waitForHaHeadroom,
} from './ha-rollout-headroom.mjs';
import { autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';
import { prepareHaReplacements } from './ha-rollout-preparation.mjs';
import { matchesKubernetesTemplate } from './kubernetes-template-match.mjs';
import { continuityFromResources } from './request-continuity.mjs';
import { createKubernetesProxyContinuity } from './proxy-continuity-kubernetes.mjs';

export const haFrozenAutoscalingValues = {
  autoscaling: {
    execution: { enabled: false },
    executionController: { suspended: true },
    proxy: { enabled: false },
    web: { enabled: false },
    backend: { enabled: false },
  },
};

export function haRolloutAutoscalingValues(resources) {
  const values = structuredClone(haFrozenAutoscalingValues);
  if (
    resources.some(
      (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === 'autoscaler',
    )
  )
    values.autoscaling.executionController.suspended = false;
  if (
    resources.some(
      (r) => r.kind === 'HorizontalPodAutoscaler' && r.metadata.labels?.['app.kubernetes.io/component'] === 'proxy',
    )
  )
    values.autoscaling.proxy = { enabled: true, scaleDownPaused: true };
  return values;
}

const ownerEnvNames = new Set([
  'PORT',
  'RIVET_KEY',
  'RIVET_API_PROFILE',
  'RIVET_REQUIRE_UI_GATE_KEY',
  'RIVET_BACKEND_API_PORT',
  'RIVET_BACKEND_EXECUTOR_PORT',
  'RIVET_BACKEND_HEALTH_PORT',
  'RIVET_EXECUTOR_RUNTIME_CONFIG_URL',
  'RIVET_LEGACY_RESTORE_INSTALLATION',
]);
const ownerEnvPrefixes = [
  'RIVET_APP_SETTINGS_',
  'RIVET_SERVER_UI_',
  'RIVET_DEPLOYMENT_STORAGE',
  'RIVET_DEPLOYMENT_DATABASE',
  'RIVET_HA_',
  'RIVET_ROLLING_RETIREMENT_',
  'RIVET_LATEST_WORKFLOWS_',
  'RIVET_LATEST_APPS_',
  'RIVET_PUBLISHED_WORKFLOWS_',
  'RIVET_PUBLISHED_APPS_',
];

/** Recovery must use the same rendered configuration, not just the same images.
 * Object key/resource order is immaterial; ordered command/env arrays are not. */
export function getHaConfigurationDigest(resources) {
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const ordered = resources.map((value) => JSON.stringify(canonical(value))).sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}`;
}

export function hasSameHaOwnerIdentity(current, candidate, poolTransition) {
  if (poolTransition) {
    const { from, to } = poolTransition;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < 1 || from < to)
      throw Error('A same-image pool preparation may only retain or decrease a positive pool size.');
    const pool = (template) =>
      template?.spec?.containers
        ?.find((c) => ['backend', 'api'].includes(c.name))
        ?.env?.filter((e) => e.name === 'RIVET_DEPLOYMENT_DATABASE_POOL_MAX');
    const a = pool(current),
      b = pool(candidate);
    if (
      a?.length !== 1 ||
      b?.length !== 1 ||
      a[0].valueFrom ||
      b[0].valueFrom ||
      ![String(from), String(to)].includes(a[0].value) ||
      b[0].value !== String(to)
    )
      return false;
    if (
      current.spec.containers.find((c) => ['backend', 'api'].includes(c.name)).image !==
      candidate.spec.containers.find((c) => ['backend', 'api'].includes(c.name)).image
    )
      return false;
  }
  const identity = (template) => {
    const container = template?.spec?.containers?.find((c) => ['backend', 'api'].includes(c.name));
    if (!container) return null;
    const mode = (container.env ?? []).find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE');
    return {
      controlPlaneMode: mode?.valueFrom ? mode : mode?.value ?? 'replicated',
      env: (container.env ?? [])
        .filter(
          (e) =>
            e.name !== 'RIVET_HA_CONTROL_PLANE_MODE' &&
            !(poolTransition && e.name === 'RIVET_DEPLOYMENT_DATABASE_POOL_MAX') &&
            (ownerEnvNames.has(e.name) || ownerEnvPrefixes.some((prefix) => e.name.startsWith(prefix))),
        )
        // The API omits empty literal values; an absent EnvVar or valueFrom
        // remains distinct because it can resolve a different runtime value.
        .map((e) => (e.valueFrom ? e : { ...e, value: e.value ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      envFrom: container.envFrom ?? [],
      serviceAccountName: template.spec.serviceAccountName ?? 'default',
      vault: Object.fromEntries(
        Object.entries(template.metadata?.annotations ?? {}).filter(
          ([key]) =>
            key.startsWith('vault.hashicorp.com/') && !/^vault\.hashicorp\.com\/agent-(requests|limits)-/.test(key),
        ),
      ),
    };
  };
  const before = identity(current),
    after = identity(candidate);
  return before !== null && after !== null && isDeepStrictEqual(before, after);
}

export function hasSameHaServiceRouting(current, candidate) {
  const routing = ({ spec }) => ({
    type: spec.type ?? 'ClusterIP',
    selector: spec.selector ?? {},
    publishNotReadyAddresses: spec.publishNotReadyAddresses ?? false,
    headless: spec.clusterIP === 'None',
    ports: (spec.ports ?? [])
      .map((port) => ({
        name: port.name,
        port: port.port,
        targetPort: port.targetPort ?? port.port,
        protocol: port.protocol ?? 'TCP',
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return isDeepStrictEqual(routing(current), routing(candidate));
}

export function resolveHaWorkloadCapacity(candidate, existing, journal, resumeToken) {
  const saved = journal?.phase !== 'complete' && journal?.workloads?.find((w) => w.name === candidate.metadata.name);
  if (!saved) return existing.spec.replicas;
  if (
    resumeToken !== journal.token ||
    !(saved.role === 'execution' && journal.cooperativeScaling?.workload === candidate.metadata.name
      ? existing.spec.replicas >= saved.replicas && existing.spec.replicas <= journal.cooperativeScaling.maxReplicas
      : [
          saved.replicas,
          saved.replicas +
            (saved.role === 'maintenance' || (saved.role === 'backend' && journal.controlPlaneMode === 'singleton')
              ? 0
              : 1),
        ].includes(existing.spec.replicas))
  )
    throw new Error('HA recovery capacity or token changed; no templates were applied.');
  return saved.replicas; // The extra owner is this operation's retained surge.
}

/** Do not reset HPA-grown frontend capacity to static values while Helm changes
 * images. Freeze its HPA during the roll and carry API-server preconditions in
 * the same update, just as for the owned execution StatefulSets. */
export async function captureHaFrontendCapacity(kube, resources, release) {
  const targets = new Set(
    resources
      .filter((r) => r.kind === 'HorizontalPodAutoscaler' && r.spec.scaleTargetRef?.kind === 'Deployment')
      .map((r) => r.spec.scaleTargetRef.name),
  );
  const candidates = resources.filter((r) => r.kind === 'Deployment' && targets.has(r.metadata.name));
  const identities = [];
  const read = async (name) => JSON.parse((await kube(['get', 'deployment', name, '-o', 'json'])).stdout);
  for (const candidate of candidates) {
    const component = candidate.metadata.labels?.['app.kubernetes.io/component'];
    const current = await read(candidate.metadata.name);
    if (
      !['proxy', 'web'].includes(component) ||
      !current.metadata.uid ||
      current.metadata.labels?.['app.kubernetes.io/instance'] !== release ||
      current.metadata.labels?.['app.kubernetes.io/component'] !== component
    )
      throw new Error('Autoscaled frontend identity is unconfirmed.');
    identities.push({ name: candidate.metadata.name, uid: current.metadata.uid, component });
  }
  return async () => {
    const replicas = {},
      versions = {};
    for (const identity of identities) {
      const current = await read(identity.name);
      if (
        current.metadata.uid !== identity.uid ||
        !current.metadata.resourceVersion ||
        !Number.isSafeInteger(current.spec.replicas) ||
        current.spec.replicas < 1
      )
        throw new Error('Autoscaled frontend identity or capacity changed; no templates were applied.');
      replicas[identity.component] = current.spec.replicas;
      versions[identity.name] = current.metadata.resourceVersion;
    }
    return { replicas, versions };
  };
}

/** Kubernetes plumbing only; retirement policy stays independently testable. */
export async function runHaKubernetesRollout({
  kube,
  release,
  namespace,
  manifestDigest,
  resources,
  applyTemplates,
  restoreAutoscalers,
  resumeToken,
  timeoutMs = 900_000,
  artifact = async () => {},
  beforeRetirement = async () => {},
  afterWithdrawal = async () => {},
  routingWithdrawalClock,
  settle,
  safety,
  previousManifestDigest,
  ownerPoolTransition,
  verifyDeveloperReady,
  prepareReplacements = prepareHaReplacements,
  createProxyContinuity = createKubernetesProxyContinuity,
}) {
  requireDeploymentSafety(safety, 'rolling', { release, namespace, manifestDigest });
  settle = safety.requireSettlement(settle);
  const overlapBackend = resources.find(
    (r) =>
      r.kind === 'StatefulSet' &&
      r.metadata.labels?.['app.kubernetes.io/component'] === 'backend' &&
      r.spec.template.spec.containers.some((c) =>
        c.env?.some((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE' && e.value === 'singleton-overlap'),
      ),
  );
  if (overlapBackend && typeof verifyDeveloperReady !== 'function')
    throw Error('singleton-overlap requires authenticated per-backend developer acceptance before cluster access.');
  const name = releaseOperationJournalName(release);
  let observedJournalVersion;
  const readJournal = async () => {
    const raw = (await kube(['get', 'configmap', name, '--ignore-not-found', '-o', 'json'])).stdout;
    if (!raw.trim()) {
      observedJournalVersion = undefined;
      return null;
    }
    const cm = JSON.parse(raw);
    observedJournalVersion = cm.metadata.resourceVersion;
    return journalForReleaseOperation(
      { ...JSON.parse(cm.data.record), resourceVersion: observedJournalVersion },
      'ha',
      { release, namespace },
    );
  };
  const initialJournal = await readJournal();
  const frontendCapacity = await captureHaFrontendCapacity(kube, resources, release);
  const selector = `app.kubernetes.io/instance=${release}`;
  const publicServices = new Set(
    resources.filter((r) => r.kind === 'Service' && !r.spec.publishNotReadyAddresses).map((r) => r.metadata.name),
  );
  const inventory = JSON.parse((await kube(['get', 'statefulset', '-l', selector, '-o', 'json'])).stdout).items;
  const poolPreparationControllers = ownerPoolTransition
    ? JSON.parse((await kube(['get', 'deployment', '-l', selector, '-o', 'json'])).stdout)
        .items.map((r) => ({ name: r.metadata.name, uid: r.metadata.uid }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : undefined;
  const controlMode = (template) =>
    template?.spec?.containers
      ?.find((c) => c.name === 'backend')
      ?.env?.find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE')?.value ?? 'replicated';
  const backend = resources.find(
    (r) => r.kind === 'StatefulSet' && r.metadata.labels?.['app.kubernetes.io/component'] === 'backend',
  );
  const controlPlaneMode = controlMode(backend?.spec.template);
  const oldBackend = inventory.find((r) => r.metadata.labels?.['app.kubernetes.io/component'] === 'backend');
  if (controlMode(oldBackend?.spec.template) !== controlPlaneMode)
    throw new Error(
      'Control-plane mode changed: use the separate journaled topology transition, not an ordinary upgrade.',
    );
  const services = JSON.parse((await kube(['get', 'service', '-l', selector, '-o', 'json'])).stdout).items;
  const desiredClaim =
    overlapBackend &&
    resources.find(
      (r) =>
        r.kind === 'PersistentVolumeClaim' &&
        r.metadata.name ===
          backend.spec.template.spec.volumes.find((v) => v.name === 'legacy-restore')?.persistentVolumeClaim?.claimName,
    );
  if (overlapBackend && !desiredClaim) throw Error('Candidate maintenance claim is missing.');
  const housekeepingDisk = overlapBackend
    ? await inspectBackendOverlap({
        kube,
        backend,
        installed: oldBackend,
        namespace,
        desiredClaim,
        expectedDisk: initialJournal?.phase !== 'complete' ? initialJournal?.housekeepingDisk : undefined,
        capacity: !initialJournal || initialJournal.phase === 'complete',
      })
    : undefined;
  const checkHousekeepingDisk = () =>
    overlapBackend
      ? inspectBackendOverlap({
          kube,
          backend,
          installed: oldBackend,
          namespace,
          expectedDisk: housekeepingDisk,
          desiredClaim,
        })
      : Promise.resolve();
  for (const current of services) {
    const candidate = resources.find((r) => r.kind === 'Service' && r.metadata.name === current.metadata.name);
    if (!candidate || !hasSameHaServiceRouting(current, candidate))
      throw new Error('HA Service routing changed. Use a maintenance cutover; no templates were applied.');
  }
  const workloads = resources
    .filter((r) => r.kind === 'StatefulSet')
    .map((candidate) => {
      const role = candidate.metadata.labels?.['app.kubernetes.io/component'];
      const existing = inventory.find((w) => w.metadata.name === candidate.metadata.name);
      if (!existing || existing.spec.updateStrategy.type !== 'OnDelete')
        throw new Error('First HA conversion requires an explicit maintenance cutover.');
      if (!existing.metadata.uid) throw new Error('HA StatefulSet identity is unavailable.');
      if (!hasSameHaOwnerIdentity(existing.spec.template, candidate.spec.template, ownerPoolTransition))
        throw new Error(
          'HA storage/authentication/owner configuration changed. Use a separate maintenance operation; no templates were applied.',
        );
      return {
        name: candidate.metadata.name,
        uid: existing.metadata.uid,
        role,
        replicas: resolveHaWorkloadCapacity(candidate, existing, initialJournal, resumeToken),
        updateStrategy: candidate.spec.updateStrategy.type,
        image: candidate.spec.template.spec.containers.find((c) => ['backend', 'api'].includes(c.name))?.image,
      };
    });
  const controller = resources.find(
    (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === 'autoscaler',
  );
  const config =
    controller &&
    JSON.parse(
      controller.spec.template.spec.containers
        .find((c) => c.name === 'autoscaler')
        .env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
    );
  const elastic = config && workloads.find((w) => w.name === config.workload && w.role === 'execution');
  const cooperativeScaling = elastic
    ? {
        protocol: 1,
        workload: elastic.name,
        uid: elastic.uid,
        image: elastic.image,
        previousImage: inventory
          .find((w) => w.metadata.uid === elastic.uid)
          ?.spec.template.spec.containers.find((c) => c.name === 'api')?.image,
        maxReplicas: config.policy.maxReplicas,
        policyDigest: autoscalerPolicyDigest(config.policy),
      }
    : undefined;
  if (elastic && (elastic.replicas > config.policy.maxReplicas || config.policy.maxReplicas < 3))
    throw new Error(
      'Cooperative HA scaling requires capacity for at least three execution owners within the approved maximum.',
    );
  const deadlineWait = async (check, description) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}; no owner was force deleted.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const desiredRevision = async (workloadName) => {
    const workload = JSON.parse((await kube(['get', 'statefulset', workloadName, '-o', 'json'])).stdout);
    if (workload.metadata.uid !== workloads.find((w) => w.name === workloadName)?.uid)
      throw new Error('HA StatefulSet identity changed.');
    return workload.status.observedGeneration >= workload.metadata.generation ? workload.status.updateRevision : null;
  };
  const observePod = async (podName) => {
    const raw = (await kube(['get', 'pod', podName, '--ignore-not-found', '-o', 'json'])).stdout;
    if (!raw.trim()) return null;
    const pod = JSON.parse(raw);
    if (pod.metadata.labels?.['app.kubernetes.io/instance'] !== release) throw new Error('Foreign HA pod.');
    const workloadName = podName.slice(0, podName.lastIndexOf('-'));
    const workload = workloads.find((w) => w.name === workloadName);
    if (
      !workload ||
      !pod.metadata.ownerReferences?.some(
        (owner) => owner.kind === 'StatefulSet' && owner.controller === true && owner.uid === workload.uid,
      )
    )
      throw new Error('HA pod controller ownership changed; observation/retirement blocked.');
    const container = pod.spec.containers.find((c) => ['backend', 'api'].includes(c.name));
    if (!container) throw new Error('Missing HA owner container.');
    return {
      name: podName,
      uid: pod.metadata.uid,
      nodeName: pod.spec.nodeName,
      container: container.name,
      image: container.image,
      revision: pod.metadata.labels?.['controller-revision-hash'],
      ready:
        !pod.metadata.deletionTimestamp &&
        pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    };
  };
  const exec = async (pod, args = []) =>
    JSON.parse(
      (await kube(['exec', pod.name, '-c', pod.container, '--', 'node', '/opt/rivet/retire-backend.mjs', ...args]))
        .stdout,
    );
  const waitForRoutingWithdrawal = (pod) =>
    waitForHaRoutingWithdrawal({
      pod,
      publicServices,
      observePod,
      timeoutMs,
      clock: routingWithdrawalClock,
      readSlices: async () => JSON.parse((await kube(['get', 'endpointslice', '-o', 'json'])).stdout).items,
    });
  const guardedTemplateValues = async (continuityValues = {}) => {
    const versions = {};
    const replicas = {};
    for (const w of workloads) {
      const current = JSON.parse((await kube(['get', 'statefulset', w.name, '-o', 'json'])).stdout);
      if (current.metadata.uid !== w.uid) throw new Error('HA StatefulSet identity changed.');
      const valid =
        w === elastic
          ? current.spec.replicas >= w.replicas && current.spec.replicas <= config.policy.maxReplicas
          : current.spec.replicas === w.replicas;
      if (!valid || !current.metadata.resourceVersion)
        throw new Error('HA capacity changed before template update; no templates were applied.');
      versions[w.name] = current.metadata.resourceVersion;
      if (w.role !== 'maintenance') replicas[w.role] = current.spec.replicas;
    }
    // Helm's patch must carry this resourceVersion. A scale/status change after
    // the read conflicts at the API server rather than overwriting new owners.
    const frontends = await frontendCapacity();
    return {
      ...continuityValues,
      replicaCount: { ...replicas, ...frontends.replicas },
      ha: { rolloutResourceVersions: { ...versions, ...frontends.versions } },
    };
  };
  const checkExecutionHeadroom = createHaExecutionHeadroomGuard({
    kube,
    release,
    namespace,
    resources,
    workloads,
    inventory,
    artifact,
  });
  const checkProxyHeadroom = createHaProxyHeadroomGuard({ kube, release, namespace, resources, artifact });
  const continuity = continuityFromResources(resources);
  const proxyContinuity = continuity
    ? createProxyContinuity({
        kube,
        config: {
          ...continuity,
          release,
          namespace,
          hpaSpec: resources.find(
            (r) => r.kind === 'HorizontalPodAutoscaler' && r.spec.scaleTargetRef.name === continuity.proxyName,
          )?.spec,
        },
        timeoutMs,
      })
    : undefined;
  const result = await runHaRollingUpgrade({
    identity: {
      release,
      namespace,
      manifestDigest,
      controlPlaneMode,
      configurationDigest: getHaConfigurationDigest(resources),
      ...(cooperativeScaling ? { cooperativeScaling } : {}),
      ...(previousManifestDigest ? { previousManifestDigest } : {}),
      ...(housekeepingDisk ? { housekeepingDisk } : {}),
      ...(ownerPoolTransition ? { ownerPoolTransition } : {}),
      ...(poolPreparationControllers ? { poolPreparationControllers } : {}),
      ...(proxyContinuity ? { proxyContinuityIdentity: proxyContinuity.identity } : {}),
    },
    proxyContinuity,
    workloads,
    safety,
    resumeToken,
    timeoutMs,
    readJournal,
    saveJournal: async (record, resourceVersion) => {
      if (!record.resourceVersion) {
        const latest = await readJournal();
        if (latest && latest.phase !== 'complete')
          throw Error('Another release operation acquired the journal during preflight.');
        resourceVersion = observedJournalVersion;
      }
      const { resourceVersion: _, ...data } = record;
      const expectedVersion = resourceVersion ?? observedJournalVersion;
      const cm = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace, ...(expectedVersion ? { resourceVersion: expectedVersion } : {}) },
        data: { record: JSON.stringify(data) },
      };
      const saved = JSON.parse(
        (await kube([expectedVersion ? 'replace' : 'create', '-f', '-', '-o', 'json'], { input: JSON.stringify(cm) }))
          .stdout,
      );
      return { ...data, resourceVersion: saved.metadata.resourceVersion };
    },
    afterCheckpoint: async ({ resourceVersion: _version, ...data }) => {
      // Five-minute request observations must not block lease renewal.
      await artifact('ha-rollout.json', JSON.stringify(data, null, 2));
    },
    snapshotCapacity: async () => {
      const old = inventory.filter((w) =>
        ['backend', 'execution', 'evaluation', 'maintenance'].includes(
          w.metadata.labels?.['app.kubernetes.io/component'],
        ),
      );
      if (old.length !== workloads.length) throw new Error('HA reader inventory changed; no templates applied.');
      for (const w of old)
        if (w.status.readyReplicas !== w.spec.replicas) throw new Error('Existing HA owners are not all ready.');
      await artifact('ha-inventory.json', JSON.stringify(inventory, null, 2));
    },
    observePod,
    status: (pod) => exec(pod),
    handoverHousekeeping: (args) =>
      handoverHousekeeping({
        ...args,
        status: exec,
        command: (pod, action, id, incarnation) => exec(pod, [id, incarnation, `--housekeeping-${action}`]),
        confirmReady: async (pod) => {
          await checkHousekeepingDisk();
          const current = await observePod(pod.name);
          const source = await observePod(args.source.name);
          if (current?.uid !== pod.uid || !current.ready || !current.nodeName || current.nodeName !== source?.nodeName)
            throw Error('Developer backend identity or same-node disk placement changed before acceptance.');
          const observed = await exec(pod);
          await verifyDeveloperReady({ ...current, incarnation: observed.incarnation });
        },
        timeoutMs,
      }),
    isCurrentPod: async (pod, workload) => {
      const revision = await desiredRevision(workload.name);
      return !!revision && pod.image === workload.image && pod.revision === revision;
    },
    prepareRetirement: beforeRetirement,
    checkHeadroom: async ({ stage, departing, workload }) => {
      await waitForHaHeadroom(
        async () => {
          await checkExecutionHeadroom({ stage, departing: workload?.role === 'execution' ? departing : undefined });
          await checkProxyHeadroom({ stage });
        },
        { timeoutMs },
      );
    },
    prepareReplacements: (operation) =>
      prepareReplacements({ operation, kube, resources, namespace, release, timeoutMs }),
    withdraw: (pod, op, inc) => exec(pod, [op, inc, '--withdraw-only']),
    begin: (pod, op, inc) => exec(pod, [op, inc, '--begin-only']),
    waitForRoutingWithdrawal,
    removePod: async (pod) => {
      const current = await observePod(pod.name);
      if (current?.uid !== pod.uid) throw new Error('HA pod UID changed before deletion.');
      await kube(['delete', '--raw', `/api/v1/namespaces/${namespace}/pods/${pod.name}`, '-f', '-'], {
        input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: pod.uid } }),
      });
    },
    scale: async (workload, replicas, expectedReplicas, owner) => {
      const current = JSON.parse((await kube(['get', 'statefulset', workload, '-o', 'json'])).stdout);
      if (current.metadata.uid !== workloads.find((w) => w.name === workload)?.uid || !current.metadata.resourceVersion)
        throw new Error('HA StatefulSet identity is unconfirmed before scaling.');
      if (current.spec.replicas === replicas) return;
      if (workload === elastic?.name && replicas > expectedReplicas && current.spec.replicas > replicas) return;
      if (current.spec.replicas !== expectedReplicas) throw new Error('HA capacity changed before scaling.');
      if (owner && (await observePod(owner.name))?.uid !== owner.uid)
        throw new Error('HA surge identity changed before scaling.');
      await kube([
        'scale',
        `statefulset/${workload}`,
        `--replicas=${replicas}`,
        `--current-replicas=${expectedReplicas}`,
        `--resource-version=${current.metadata.resourceVersion}`,
      ]);
    },
    waitForScaleDown: (workload, owner) =>
      deadlineWait(async () => {
        const current = JSON.parse((await kube(['get', 'statefulset', workload.name, '-o', 'json'])).stdout);
        if (current.metadata.uid !== workload.uid) throw new Error('HA StatefulSet identity changed.');
        if (current.spec.replicas !== workload.replicas)
          throw new Error('HA surge scale-down is unconfirmed; inspect the recorded operation before recovery.');
        const pod = await observePod(owner.name);
        if (pod && pod.uid !== owner.uid) throw new Error('HA surge was replaced during scale-down.');
        return !pod;
      }, `surge removal for ${owner.name}`),
    applyTemplates: async (operation) =>
      applyTemplates(workloads, await guardedTemplateValues(proxyContinuity?.templateValues(operation))),
    ...(ownerPoolTransition
      ? {
          verifyPoolPreparationTemplates: async () => {
            if (resources.some((r) => r.kind === 'Job')) return false;
            for (const desired of resources.filter((r) => ['StatefulSet', 'Deployment'].includes(r.kind))) {
              const live = JSON.parse(
                (await kube(['get', desired.kind.toLowerCase(), desired.metadata.name, '-o', 'json'])).stdout,
              );
              const expected = desired.kind === 'StatefulSet' ? workloads : poolPreparationControllers;
              if (
                live.metadata.uid !== expected.find((w) => w.name === desired.metadata.name)?.uid ||
                live.metadata.deletionTimestamp ||
                !matchesKubernetesTemplate(live.spec.template, desired.spec.template)
              )
                return false;
            }
            for (const desired of resources.filter((r) => r.kind === 'HorizontalPodAutoscaler')) {
              const live = JSON.parse((await kube(['get', 'hpa', desired.metadata.name, '-o', 'json'])).stdout);
              if (
                live.spec.scaleTargetRef.name !== desired.spec.scaleTargetRef.name ||
                live.spec.behavior?.scaleDown?.selectPolicy !== 'Disabled'
              )
                return false;
            }
            return true;
          },
        }
      : {}),
    restoreAutoscalers: async (operation) =>
      restoreAutoscalers(workloads, await guardedTemplateValues(proxyContinuity?.templateValues(operation))),
    settle: async () => {
      const { replicaCount } = await guardedTemplateValues();
      const effective = structuredClone(resources);
      for (const resource of effective) {
        if (!['StatefulSet', 'Deployment'].includes(resource.kind)) continue;
        const role = resource.metadata.labels?.['app.kubernetes.io/component'];
        const count =
          resource.kind === 'StatefulSet'
            ? workloads.find((workload) => workload.name === resource.metadata.name)?.replicas
            : replicaCount[role];
        if (count !== undefined) resource.spec.replicas = count;
      }
      await checkHousekeepingDisk();
      return settle(effective);
    },
    waitForReady: (podName, image) =>
      deadlineWait(async () => {
        const pod = await observePod(podName);
        const revision = await desiredRevision(podName.slice(0, podName.lastIndexOf('-')));
        return !!revision && pod?.ready && pod.image === image && pod.revision === revision;
      }, `candidate owner ${podName}`),
    waitForWithdrawal: async (pod) => {
      // Propagation was observed before admission closed. Recheck the route,
      // without needlessly waiting another full minute after work has drained.
      await deadlineWait(
        async () =>
          !hasHaPublicEndpoint(
            JSON.parse((await kube(['get', 'endpointslice', '-o', 'json'])).stdout).items,
            publicServices,
            pod.uid,
          ),
        `endpoint withdrawal for ${pod.name}`,
      );
      await afterWithdrawal(pod);
    },
  });
  return result;
}
