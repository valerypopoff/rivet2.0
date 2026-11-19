import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { inspectBackendOverlap } from './backend-overlap-preflight.mjs';
import {
  assertNoExecutionStartupFences,
  claimHaReleaseJournal,
  readAvailableReleaseJournal,
} from './deployment-readiness.mjs';
import { autoscalerPolicyDigest } from './execution-autoscaler.mjs';
import { getHaConfigurationDigest, hasSameHaServiceRouting } from './ha-kubernetes-rollout.mjs';
import { hasHaPublicEndpoint, waitForHaRoutingWithdrawal } from './ha-routing-withdrawal.mjs';
import { matchesKubernetesTemplate } from './kubernetes-template-match.mjs';
import { runOnlineEditorAdoption } from './online-editor-adoption.mjs';
import { releaseOperationJournalName } from './release-operation-journal.mjs';

const component = (resource) => resource.metadata.labels?.['app.kubernetes.io/component'];
const find = (resources, kind, role) => resources.find((r) => r.kind === kind && component(r) === role);
const key = (r) => `${r.kind}/${r.metadata.name}`;
const backendContainer = (template) => template.spec.containers.find((c) => c.name === 'backend');
const mode = (template) => backendContainer(template)?.env.find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE')?.value;
const fence = 'RIVET_EXECUTION_STARTUP_FENCE';
const admission = 'rivet.dev/editor-adoption';
const podNameLabel = 'statefulset.kubernetes.io/pod-name';
const ownedBy = (pod, uid) =>
  pod.metadata.ownerReferences?.some((owner) => owner.kind === 'StatefulSet' && owner.uid === uid && owner.controller);

export function assertOnlineEditorResources(installed, desired) {
  const source = find(installed, 'StatefulSet', 'backend');
  const backend = find(desired, 'StatefulSet', 'backend');
  assert.ok(source && backend && key(source) === key(backend));
  assert.equal(source.spec.updateStrategy.type, 'OnDelete');
  assert.equal(source.spec.podManagementPolicy, 'Parallel');
  assert.ok(source.spec.replicas === 1 && backend.spec.replicas === 1);
  assert.equal(mode(source.spec.template), 'singleton');
  assert.equal(mode(backend.spec.template), 'singleton-overlap');
  const claimName = backend.spec.template.spec.volumes?.find((v) => v.name === 'legacy-restore')?.persistentVolumeClaim
    ?.claimName;
  const claim = desired.find((r) => r.kind === 'PersistentVolumeClaim' && r.metadata.name === claimName);
  assert.ok(claim && isDeepStrictEqual(claim.spec.accessModes, ['ReadWriteOnce']));
  assert.ok(
    ['memory', 'ephemeral-storage'].every((name) => backendContainer(backend.spec.template).resources.limits?.[name]),
    'Explicit overlap memory and ephemeral-storage limits are required',
  );
  const placement = backend.spec.template.spec.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
  assert.ok(
    placement?.some(
      (term) =>
        term.topologyKey === 'kubernetes.io/hostname' &&
        isDeepStrictEqual(term.labelSelector?.matchLabels, backend.spec.selector.matchLabels),
    ),
    'Same-node editor affinity is required',
  );
  const neutralBackend = (resource) => {
    const copy = structuredClone(resource);
    const spec = copy.spec.template.spec;
    delete spec.affinity;
    delete spec.topologySpreadConstraints;
    const container = backendContainer(copy.spec.template);
    delete container.resources;
    container.env = container.env.filter(
      (entry) =>
        ![
          'RIVET_HA_CONTROL_PLANE_MODE',
          'RIVET_DEPLOYMENT_RESOURCE_MONITORING',
          'RIVET_RESOURCE_CPU_REQUEST',
          'RIVET_RESOURCE_CPU_LIMIT',
          'RIVET_RESOURCE_MEMORY_REQUEST',
          'RIVET_RESOURCE_MEMORY_LIMIT',
          'RIVET_POD_UID',
          'RIVET_POD_IP',
          'RIVET_NAMESPACE_UID',
          'RIVET_HOUSEKEEPING_PORT',
        ].includes(entry.name),
    );
    return copy;
  };
  assert.ok(
    isDeepStrictEqual(neutralBackend(source), neutralBackend(backend)),
    'Editor image, storage, credentials or owner identity changed',
  );
  const unchanged = (resources) =>
    resources.filter(
      (r) =>
        key(r) !== key(backend) &&
        // The installed checkpoint may have had a schema Job. This operation
        // verifies the existing schema and never installs a migration hook.
        !(
          r.metadata.annotations?.['helm.sh/hook'] && /-(schema-guard|workflow-schema-migration)$/.test(r.metadata.name)
        ),
    );
  assert.ok(
    !desired.some(
      (r) =>
        component(r) === 'workflow-schema-migration' || (r.metadata.annotations?.['helm.sh/hook'] && r.kind === 'Job'),
    ),
    'Online adoption requires schema verification only',
  );
  assert.equal(
    getHaConfigurationDigest(unchanged(installed)),
    getHaConfigurationDigest(unchanged(desired)),
    'Online editor adoption changes a non-editor resource',
  );
  const services = ['api', 'executor'].map((role) => find(desired, 'Service', role));
  assert.ok(
    services.every(
      (service) =>
        service &&
        !service.spec.publishNotReadyAddresses &&
        service.spec.type === 'ClusterIP' &&
        isDeepStrictEqual(service.spec.selector, backend.spec.selector.matchLabels),
    ),
    'Editor API and executor must use ordinary readiness-aware Services',
  );
  const execution = desired.filter((r) => r.kind === 'StatefulSet' && component(r) === 'execution');
  const inactive = execution.find((r) => r.spec.replicas === 0);
  const active = execution.find((r) => r.spec.replicas >= 2);
  assert.ok(
    execution.length === 2 &&
      inactive &&
      active &&
      new Set(execution.map((r) => r.metadata.labels['rivet.dev/execution-pool'])).size === 2,
    'Online adoption requires settled paired execution pools',
  );
  const controller = find(desired, 'Deployment', 'autoscaler');
  const policy = JSON.parse(
    controller?.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
  );
  const runtimeService = desired.find((r) => r.kind === 'Service' && r.metadata.name === policy.service);
  assert.ok(
    policy.workload === active.metadata.name &&
      runtimeService?.metadata.annotations?.['rivet.dev/active-execution-workload'] === policy.workload,
  );
  return { source, backend, claim, services, active, inactive, policy, runtimeService };
}

export function onlineEditorTemplates(source, backend) {
  const final = backend.spec.template;
  const bootstrap = structuredClone(final);
  const name = backend.metadata.name;
  const container = backendContainer(bootstrap);
  assert.deepEqual(container.command, ['node', '/opt/rivet/backend-supervisor.mjs']);
  assert.ok(!container.args && !container.env.some((entry) => entry.name === fence));
  assert.match(name, /^[a-z0-9-]+$/);
  container.command = ['/bin/sh', '-ec'];
  container.args = [
    `case "$RIVET_POD_NAME" in ${name}-0) export RIVET_HA_CONTROL_PLANE_MODE=singleton ;; ${name}-1) ;; *) exit 1 ;; esac
exec node /opt/rivet/backend-supervisor.mjs`,
  ];
  const fenced = structuredClone(bootstrap);
  backendContainer(fenced).env.push({ name: fence, value: `${name}-0` });
  return { source: source.spec.template, bootstrap, fenced, final };
}

export function onlineEditorSettlementValues(live, desired) {
  const versions = {},
    replicas = {};
  for (const workload of live) {
    const role = component(workload);
    const expected = desired.find((r) => key(r) === key(workload));
    assert.ok(
      expected &&
        workload.metadata.uid &&
        workload.metadata.resourceVersion &&
        !workload.metadata.deletionTimestamp &&
        matchesKubernetesTemplate(workload.spec.template, expected.spec.template),
      'A serving workload drifted before online editor settlement',
    );
    versions[workload.metadata.name] = workload.metadata.resourceVersion;
    if (['backend', 'proxy', 'web', 'execution'].includes(role) && (role !== 'execution' || expected.spec.replicas > 0))
      replicas[role] = workload.spec.replicas;
  }
  assert.ok(
    desired.filter((r) => ['StatefulSet', 'Deployment'].includes(r.kind)).every((r) => versions[r.metadata.name]),
    'Online editor settlement is missing a controller',
  );
  return { replicaCount: replicas, ha: { rolloutResourceVersions: versions } };
}

const sameTemplate = (actual, desired) => {
  if (!actual) return false;
  const a = backendContainer(actual);
  const b = backendContainer(desired);
  return (
    !!a &&
    !!b &&
    isDeepStrictEqual(a.args, b.args) &&
    a.env?.length === b.env.length &&
    matchesKubernetesTemplate(actual, desired)
  );
};

/** A safe abort may leave a bootstrap -0 running in legacy mode under the
 * restored OnDelete template. Verify the exact retained Pod for preflight. */
export async function readRetainedOnlineEditor({ kube, installed, desired }) {
  const { source, backend } = assertOnlineEditorResources(installed, desired);
  const name = source.metadata.name;
  const get = async (kind, resource) => {
    const { stdout } = await kube(['get', kind, resource, '--ignore-not-found', '-o', 'json']);
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const [controller, pod] = await Promise.all([get('statefulset', name), get('pod', `${name}-0`)]);
  const revision = pod?.metadata.labels?.['controller-revision-hash'];
  const uid = controller?.metadata.uid;
  if (
    !revision ||
    !uid ||
    !pod.metadata.uid ||
    !ownedBy(pod, uid) ||
    pod.metadata.labels[podNameLabel] !== `${name}-0` ||
    pod.metadata.labels[admission] ||
    controller.spec.replicas !== 1 ||
    controller.spec.updateStrategy.type !== 'OnDelete' ||
    !sameTemplate(controller.spec.template, source.spec.template)
  )
    return;
  const liveRevision = await get('controllerrevision', revision);
  if (
    liveRevision &&
    ownedBy(liveRevision, uid) &&
    sameTemplate(liveRevision.data.spec.template, onlineEditorTemplates(source, backend).bootstrap)
  )
    return { name, uid, revision, replicas: 1, pods: [pod.metadata.uid] };
}

/** Adapt Kubernetes reads and conditional writes to the existing lease and
 * admission protocol. Only the editor StatefulSet, its Pods and the two
 * ordinary editor Service selectors are changed before final Helm settlement. */
export async function runKubernetesOnlineEditorAdoption({
  kube,
  release,
  namespace,
  manifestDigest,
  installed,
  desired,
  safety,
  timeoutMs,
  resumeToken,
  abort,
  openRestoreGuard,
  verifyDeveloperReady,
  verifyTraffic,
  settle,
  routingWithdrawalClock,
}) {
  const { source, backend, claim, services, active, inactive, policy, runtimeService } = assertOnlineEditorResources(
    installed,
    desired,
  );
  const templates = onlineEditorTemplates(source, backend);
  const json = async (args, options) => {
    const { stdout } = await kube(args, options);
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const get = (kind, name) => json(['get', kind, name, '--ignore-not-found', '-o', 'json']);
  const workload = (name = backend.metadata.name) => get('statefulset', name);
  const originalBackend = await workload();
  const runningActive = await workload(active.metadata.name);
  const runningInactive = await workload(inactive.metadata.name);
  assert.ok(originalBackend?.metadata.uid && runningActive?.metadata.uid && runningInactive?.metadata.uid);
  const name = releaseOperationJournalName(release);
  let lastJournal;
  const readJournal = async () => {
    const result = await readAvailableReleaseJournal({ kube, name, kind: 'ha', release, namespace, timeoutMs });
    lastJournal = result.resource;
    return result.record;
  };
  const previous = await readJournal();
  const recovering = previous && previous.phase !== 'complete';
  const initialPod = await get('pod', `${backend.metadata.name}-0`);
  const nodeName = recovering ? previous.nodeName : initialPod?.spec.nodeName;
  assert.ok(nodeName, 'Editor adoption requires the original backend node');
  const observedServices = await Promise.all(services.map((service) => get('service', service.metadata.name)));
  assert.ok(
    observedServices.every(
      (service) => service?.metadata.uid && service.spec.clusterIP && service.spec.clusterIP !== 'None',
    ),
  );
  const serviceNames = new Set(services.map((service) => service.metadata.name));
  const disk = await inspectBackendOverlap({
    kube,
    backend,
    installed: originalBackend,
    namespace,
    desiredClaim: claim,
    capacity: !recovering,
  });
  const identity = {
    release,
    namespace,
    manifestDigest,
    previousManifestDigest: manifestDigest,
    configurationDigest: getHaConfigurationDigest([...desired, ...Object.values(templates)]),
    backendUid: originalBackend.metadata.uid,
    nodeName,
    housekeepingDisk: disk,
    editorServices: observedServices.map((service) => service.metadata.uid),
    inactiveExecutionUid: runningInactive.metadata.uid,
    workloads: [{ name: active.metadata.name, uid: runningActive.metadata.uid, role: 'execution' }],
    cooperativeScaling: {
      protocol: 1,
      workload: active.metadata.name,
      uid: runningActive.metadata.uid,
      image: active.spec.template.spec.containers.find((c) => c.name === 'api').image,
      policyDigest: autoscalerPolicyDigest(policy.policy),
      maxReplicas: policy.policy.maxReplicas,
    },
  };
  const pods = async () =>
    (await json(['get', 'pods', '-l', `app.kubernetes.io/instance=${release}`, '-o', 'json'])).items;
  const inspectPools = async () => {
    const [a, b, route, members] = await Promise.all([
      workload(active.metadata.name),
      workload(inactive.metadata.name),
      get('service', runtimeService.metadata.name),
      pods(),
    ]);
    assert.ok(
      a?.metadata.uid === runningActive.metadata.uid &&
        !a.metadata.deletionTimestamp &&
        b?.metadata.uid === runningInactive.metadata.uid &&
        !b.metadata.deletionTimestamp &&
        sameExecution(a, active) &&
        sameExecution(b, inactive) &&
        a.spec.replicas >= 2 &&
        a.spec.replicas <= policy.policy.maxReplicas &&
        b.spec.replicas === 0 &&
        members.filter(
          (pod) =>
            ownedBy(pod, a.metadata.uid) &&
            !pod.metadata.deletionTimestamp &&
            pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
        ).length >= 2 &&
        !members.some(
          (pod) => ownedBy(pod, b.metadata.uid) || (component(pod) === 'execution' && !ownedBy(pod, a.metadata.uid)),
        ) &&
        route?.metadata.annotations?.['rivet.dev/active-execution-workload'] === active.metadata.name &&
        hasSameHaServiceRouting(route, runtimeService),
      'Published execution ownership or capacity changed during editor adoption',
    );
    assertNoExecutionStartupFences([a, b, ...members]);
  };
  const sameExecution = (actual, expected) =>
    matchesKubernetesTemplate(actual.spec.template, expected.spec.template) &&
    isDeepStrictEqual(actual.spec.updateStrategy, expected.spec.updateStrategy);
  const getBackend = async () => {
    const current = await workload();
    assert.ok(
      current?.metadata.uid === originalBackend.metadata.uid &&
        !current.metadata.deletionTimestamp &&
        current.metadata.resourceVersion &&
        current.spec.updateStrategy.type === 'OnDelete',
      'Editor StatefulSet identity changed',
    );
    return current;
  };
  const observe = async (ordinal) => {
    const name = `${backend.metadata.name}-${ordinal}`;
    const pod = await get('pod', name);
    if (!pod) return null;
    assert.ok(
      pod.metadata.uid &&
        pod.metadata.resourceVersion &&
        ownedBy(pod, originalBackend.metadata.uid) &&
        pod.metadata.labels?.[podNameLabel] === name &&
        (!pod.spec.nodeName || pod.spec.nodeName === nodeName),
      'Editor pod ownership or same-node placement changed',
    );
    let revision;
    return {
      ordinal,
      name,
      uid: pod.metadata.uid,
      resourceVersion: pod.metadata.resourceVersion,
      nodeName: pod.spec.nodeName,
      container: 'backend',
      image: backendContainer(backend.spec.template).image,
      ip: pod.status?.podIP,
      admitted: !!pod.metadata.labels?.[admission],
      hasAdmission: (token) => pod.metadata.labels?.[admission] === token,
      matchesSelector: (selector) =>
        Object.entries(selector).every(([label, value]) => pod.metadata.labels[label] === value),
      terminating: !!pod.metadata.deletionTimestamp,
      ready:
        !pod.metadata.deletionTimestamp &&
        !!pod.spec.nodeName &&
        pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
      async isTemplate(...stages) {
        const revisionName = pod.metadata.labels?.['controller-revision-hash'];
        if (!revisionName || backendContainer(pod)?.image !== backendContainer(backend.spec.template).image)
          return false;
        revision ??= await get('controllerrevision', revisionName);
        return (
          !!revision &&
          ownedBy(revision, originalBackend.metadata.uid) &&
          stages.some((stage) => sameTemplate(revision.data.spec.template, templates[stage]))
        );
      },
    };
  };
  const getSingleton = async () => {
    const live = await getBackend();
    assert.equal(live.spec.replicas, 1);
    assert.ok(!(await observe(1)), 'The standby ordinal is still present');
    return live;
  };
  const exec = (pod, args = []) =>
    json(['exec', pod.name, '-c', 'backend', '--', 'node', '/opt/rivet/retire-backend.mjs', ...args]);
  const slices = async () => (await json(['get', 'endpointslice', '-o', 'json'])).items;
  const routed = (items, owner) =>
    [...serviceNames].every((service) => hasHaPublicEndpoint(items, new Set([service]), owner.uid));
  const waitForRoute = async (owner) => {
    const deadline = Date.now() + timeoutMs;
    while (!routed(await slices(), owner)) {
      if (Date.now() >= deadline) throw Error('Verified editor has not reached both routed Services');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const patch = (kind, object, fields) =>
    kube([
      'patch',
      kind,
      object.metadata.name,
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: object.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: object.metadata.resourceVersion },
        ...fields,
      ]),
    ]);
  const verifyDisk = () =>
    inspectBackendOverlap({
      kube,
      backend,
      installed: originalBackend,
      namespace,
      desiredClaim: claim,
      expectedDisk: disk,
    });
  const guard = async () => {
    await inspectPools();
    await verifyDisk();
  };
  return runOnlineEditorAdoption({
    identity,
    safety,
    resumeToken,
    abort,
    timeoutMs,
    readJournal,
    observe,
    status: exec,
    saveJournal: async (record, resourceVersion) => {
      const { resourceVersion: _rv, ...data } = record;
      const saved = resourceVersion
        ? await json(['replace', '-f', '-', '-o', 'json'], {
            input: JSON.stringify({
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: { name, namespace, uid: lastJournal?.metadata.uid, resourceVersion },
              data: { record: JSON.stringify(data) },
            }),
          })
        : await claimHaReleaseJournal({
            kube,
            name,
            release,
            namespace,
            timeoutMs,
            previousResource: lastJournal,
            record: data,
          });
      lastJournal = saved;
      return { ...data, resourceVersion: saved.metadata.resourceVersion };
    },
    preflight: async () => {
      assert.equal(originalBackend.spec.replicas, 1);
      assert.ok(sameTemplate(originalBackend.spec.template, templates.source) && !(await observe(1)));
      assert.ok(observedServices.every((service, index) => hasSameHaServiceRouting(service, services[index])));
      await guard();
    },
    acquireRestoreGuard: () => openRestoreGuard(`${active.metadata.name}-0`),
    observeTraffic: async (stage, owner) => {
      if (owner) await waitForRoute(owner);
      await guard();
      await verifyTraffic(stage, owner);
    },
    accept: verifyDeveloperReady,
    setRoute: async (stage, token, survivor) => {
      for (let i = 0; i < services.length; i++) {
        const desiredService = services[i];
        const live = await get('service', desiredService.metadata.name);
        assert.ok(live?.metadata.uid === observedServices[i].metadata.uid);
        const normal = desiredService.spec.selector;
        const sourceOnly = { ...normal, [podNameLabel]: `${backend.metadata.name}-0` };
        const overlap = { ...normal, [admission]: token };
        const selector = { normal, source: sourceOnly, overlap }[stage];
        assert.ok(
          [normal, sourceOnly, overlap].some((known) =>
            hasSameHaServiceRouting(live, { spec: { ...desiredService.spec, selector: known } }),
          ),
          'Editor Service routing drifted',
        );
        if (isDeepStrictEqual(live.spec.selector, selector)) continue;
        if (stage === 'normal') await getSingleton();
        const pod = await observe(survivor.ordinal);
        assert.ok(pod?.uid === survivor.uid && pod.ready, 'Serving editor changed before Service selector update');
        const observed = await exec(pod);
        assert.ok(
          observed.incarnation === survivor.incarnation && observed.state === 'serving' && !observed.operationId,
          'Serving editor changed before Service selector update',
        );
        const current = await observe(survivor.ordinal);
        assert.ok(
          current?.uid === survivor.uid && current.ready && current.matchesSelector(selector),
          'Serving editor no longer matches the proposed Service selector',
        );
        await patch('service', live, [{ op: 'replace', path: '/spec/selector', value: selector }]);
      }
    },
    setAdmission: async (pod, label, token) => {
      const live = await get('pod', pod.name);
      assert.ok(
        live?.metadata.uid === pod.uid &&
          !live.metadata.deletionTimestamp &&
          ownedBy(live, originalBackend.metadata.uid),
      );
      const current = live.metadata.labels[admission] ?? null;
      assert.ok(!current || current === token, 'Foreign editor admission label');
      if (label) {
        const observed = await exec(pod);
        assert.ok(
          live.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') &&
            pod.incarnation &&
            observed.incarnation === pod.incarnation &&
            observed.state === 'serving' &&
            !observed.operationId,
          'Accepted editor incarnation changed before admission',
        );
      }
      if (current !== label) {
        await guard();
        await patch('pod', live, [
          {
            op: 'replace',
            path: '/metadata/labels',
            value: {
              ...Object.fromEntries(Object.entries(live.metadata.labels).filter(([name]) => name !== admission)),
              ...(label ? { [admission]: label } : {}),
            },
          },
        ]);
      }
    },
    setTemplate: async (stage, { undoFence = false } = {}) => {
      const live = await (stage === 'source' ? getSingleton() : getBackend());
      const before = Object.keys(templates).find((key) => sameTemplate(live.spec.template, templates[key]));
      assert.ok(
        before &&
          {
            source: ['source', 'bootstrap', 'fenced'],
            bootstrap: undoFence ? ['bootstrap', 'fenced'] : ['source', 'bootstrap'],
            fenced: ['bootstrap', 'fenced'],
            final: ['fenced', 'final'],
          }[stage].includes(before),
        'Unexpected editor controller template',
      );
      if (stage !== before)
        await patch('statefulset', live, [{ op: 'replace', path: '/spec/template', value: templates[stage] }]);
    },
    setReplicas: async (count, pod, { verifyOnly = false } = {}) => {
      const live = await getBackend();
      if (live.spec.replicas === count) return;
      assert.ok(!verifyOnly && live.spec.replicas === 3 - count, 'Editor scale outcome is unconfirmed');
      if (pod) {
        const current = await observe(pod.ordinal);
        assert.ok(
          current?.uid === pod.uid && !current.terminating && !current.admitted,
          'Editor Pod changed before scale-down',
        );
        const observed = await exec(current);
        assert.ok(
          observed.incarnation === pod.incarnation &&
            observed.operationId === pod.operationId &&
            observed.state === 'drained',
          'Editor drain proof changed before scale-down',
        );
      }
      await patch('statefulset', live, [{ op: 'replace', path: '/spec/replicas', value: count }]);
    },
    withdraw: (pod, id, incarnation) => exec(pod, [id, incarnation, '--withdraw-only']),
    begin: (pod, id, incarnation) => exec(pod, [id, incarnation, '--begin-only']),
    waitForWithdrawal: (pod, survivor, check) =>
      waitForHaRoutingWithdrawal({
        readSlices: slices,
        observePod: () => observe(pod.ordinal),
        pod,
        publicServices: serviceNames,
        timeoutMs,
        clock: routingWithdrawalClock,
        routingReady: async (items) => {
          await check();
          return routed(items, survivor);
        },
      }),
    remove: async (pod) => {
      const current = await observe(pod.ordinal);
      assert.ok(
        current?.uid === pod.uid && !current.terminating && !current.admitted,
        'Editor deletion identity is unconfirmed',
      );
      const node = await get('node', nodeName);
      assert.ok(
        node &&
          !node.metadata.deletionTimestamp &&
          node.status.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'),
      );
      await kube(['delete', '--raw', `/api/v1/namespaces/${namespace}/pods/${pod.name}`, '-f', '-'], {
        input: JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: pod.uid, resourceVersion: pod.resourceVersion },
        }),
      });
    },
    verify: async (operation, verifyServing) => {
      const verifyLayout = async () => {
        const live = await getSingleton();
        assert.ok(sameTemplate(live.spec.template, templates.final));
      };
      const receipt = await settle(operation, async () => {
        await verifyLayout();
        await verifyServing();
      });
      await verifyLayout();
      return receipt;
    },
  });
}
