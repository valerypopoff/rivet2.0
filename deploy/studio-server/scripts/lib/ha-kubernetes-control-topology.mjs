import { isDeepStrictEqual } from 'node:util';
import { runHaControlTopologyTransition } from './ha-control-topology.mjs';
import { getHaConfigurationDigest, hasSameHaOwnerIdentity, hasSameHaServiceRouting } from './ha-kubernetes-rollout.mjs';
import { releaseOperationJournalName, journalForReleaseOperation } from './release-operation-journal.mjs';
import { waitForHaRoutingWithdrawal } from './ha-routing-withdrawal.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';

const role = (r) => r.metadata?.labels?.['app.kubernetes.io/component'];
const container = (r) => r.spec?.template?.spec?.containers?.find((c) => ['backend', 'api'].includes(c.name));
const mode = (r) => {
  const env = container(r)?.env?.find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE');
  const value = env?.value ?? 'replicated';
  if (env?.valueFrom || !['replicated', 'singleton', 'singleton-overlap'].includes(value))
    throw new Error('Control topology mode must be an explicit deployment-owned literal.');
  return value;
};
const ready = (p) =>
  !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');

// API defaults may add fields and omit empty strings. Named Kubernetes arrays
// are sets keyed by name; commands/args remain ordered. Never ignore a changed
// desired field when reconciling a lost Helm acknowledgement.
export function matchesTopologyTemplate(actual, desired) {
  if ((desired === '' || desired === null) && actual === undefined) return true;
  if (
    actual === undefined &&
    desired &&
    typeof desired === 'object' &&
    !Array.isArray(desired) &&
    Object.keys(desired).length === 0
  )
    return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length < desired.length) return false;
    if (desired.every((v) => v && typeof v === 'object' && typeof v.name === 'string')) {
      const used = new Set();
      return desired.every((v) => {
        const index = actual.findIndex((a, i) => !used.has(i) && a.name === v.name && matchesTopologyTemplate(a, v));
        if (index < 0) return false;
        used.add(index);
        return true;
      });
    }
    return actual.length === desired.length && desired.every((v, i) => matchesTopologyTemplate(actual[i], v));
  }
  if (desired && typeof desired === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([k, v]) => matchesTopologyTemplate(actual[k], v))
    );
  return isDeepStrictEqual(actual, desired);
}

/** Same-image bridge-only transfer. The adapter never calls a public endpoint,
 * reads a Secret, deletes a PVC, drains a node, or changes a runtime replica. */
export async function runHaKubernetesControlTopology({
  kube,
  release,
  namespace,
  manifestDigest,
  resources,
  resumeToken,
  applyTemplates,
  artifact = async () => {},
  timeoutMs = 900_000,
  routingWithdrawalClock,
  safety,
  settle,
}) {
  requireDeploymentSafety(safety, 'topology', { release, namespace, manifestDigest });
  settle = safety.requireSettlement(settle);
  const selector = `app.kubernetes.io/instance=${release}`;
  const json = async (args) => JSON.parse((await kube(args)).stdout);
  const list = async (kind) => (await json(['get', kind, '-l', selector, '-o', 'json'])).items;
  const journalName = releaseOperationJournalName(release);
  let observedVersion;
  const readJournal = async () => {
    const raw = (await kube(['get', 'configmap', journalName, '--ignore-not-found', '-o', 'json'])).stdout;
    if (!raw.trim()) return null;
    const cm = JSON.parse(raw);
    observedVersion = cm.metadata.resourceVersion;
    return journalForReleaseOperation({ ...JSON.parse(cm.data.record), resourceVersion: observedVersion }, 'ha', {
      release,
      namespace,
    });
  };
  const saved = await readJournal();
  const current = await list('statefulset');
  const target = resources.filter((r) => r.kind === 'StatefulSet');
  const sourceBackend = current.find((r) => role(r) === 'backend');
  const targetBackend = target.find((r) => role(r) === 'backend');
  if (!sourceBackend || !targetBackend) throw new Error('Missing control topology owner.');
  const from = saved?.phase !== 'complete' && saved?.topologyProtocol === 1 ? saved.from : mode(sourceBackend);
  const to = mode(targetBackend);
  const currentFrontends = await list('deployment');
  const sourceProxy = currentFrontends.find((r) => role(r) === 'proxy');
  const targetProxy = resources.find((r) => r.kind === 'Deployment' && role(r) === 'proxy');
  const edgeProfile = targetProxy?.metadata.annotations?.['rivet.studio/gke-edge-profile'] ?? 'regional';
  if (!['regional', 'compact'].includes(edgeProfile)) throw new Error('Unknown GKE edge profile.');
  const proxyFloor = edgeProfile === 'compact' ? 2 : 6;
  if (
    !sourceProxy?.metadata.uid ||
    !targetProxy ||
    sourceProxy.spec.replicas < proxyFloor ||
    sourceProxy.spec.replicas !== targetProxy.spec.replicas
  )
    throw new Error(
      `${proxyFloor} identity-pinned proxies are required; change edge capacity separately from ownership transfer.`,
    );
  const runtimeProxyTemplate = from === 'replicated' ? targetProxy.spec.template : sourceProxy.spec.template;
  const proxyEnvironment = (template) => template.spec.containers.find((c) => c.name === 'proxy')?.env ?? [];
  // Reverse Helm restores control-owned health. Once templates were issued,
  // recovery only inspects their exact result; the source-edge rule no longer
  // applies. Keep it for every owner-phase resume, including an already-prepared edge.
  const inspectingTemplates = saved?.topologyProtocol === 1 && ['templates', 'preflight'].includes(saved.phase);
  if (
    !inspectingTemplates &&
    proxyEnvironment(runtimeProxyTemplate).find((e) => e.name === 'RIVET_PROXY_HEALTH_OWNER')?.value !== 'execution'
  )
    throw new Error('Ownership transfer requires execution-owned proxy health before developer withdrawal.');
  const proxyPort = runtimeProxyTemplate.spec.containers
    .find((c) => c.name === 'proxy')
    ?.ports?.find((p) => p.name === 'proxy-http')?.containerPort;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
    throw new Error('Proxy health port is unavailable.');
  const desiredOwner = target.filter((r) => r.spec.template.spec.volumes?.some((v) => v.name === 'legacy-restore'));
  if (
    desiredOwner.length !== 1 ||
    role(desiredOwner[0]) !== (to !== 'replicated' ? 'backend' : 'maintenance') ||
    desiredOwner[0].spec.replicas !== 1 ||
    target.some((r) => r.spec.updateStrategy?.type !== 'OnDelete')
  )
    throw new Error('Candidate has ambiguous maintenance storage ownership.');
  if (from === to) throw new Error('Topology transition requires two different control modes.');
  const claimName = `${release}-legacy-restore`;
  // Fullname overrides are allowed; derive the authoritative claim from the
  // single source owner, not by discovering prefix matches.
  const owner = current.find((r) => role(r) === (from !== 'replicated' ? 'backend' : 'maintenance'));
  const claims = owner?.spec.template.spec.volumes?.filter((v) => v.name === 'legacy-restore');
  const claim = await json([
    'get',
    'pvc',
    saved?.phase !== 'complete' && saved?.topologyProtocol === 1
      ? saved.claimName
      : claims?.[0]?.persistentVolumeClaim?.claimName ?? claimName,
    '-o',
    'json',
  ]);
  if (
    !claim.metadata.uid ||
    claim.metadata.deletionTimestamp ||
    claim.metadata.labels?.['app.kubernetes.io/instance'] !== release ||
    !claim.spec.volumeName ||
    claim.spec.accessModes?.length !== 1 ||
    claim.spec.accessModes[0] !== 'ReadWriteOnce'
  )
    throw new Error('Restore claim identity or exclusive ownership is unavailable.');
  const volume = await json(['get', 'pv', claim.spec.volumeName, '-o', 'json']);
  if (!volume.metadata.uid || volume.metadata.deletionTimestamp || volume.spec.claimRef?.uid !== claim.metadata.uid)
    throw new Error('Restore volume binding is unconfirmed.');
  if (volume.spec.hostPath || volume.spec.local) {
    const terms = volume.spec.nodeAffinity?.required?.nodeSelectorTerms ?? [];
    const hosts = terms.map(
      (t) =>
        t.matchExpressions?.find(
          (e) => e.key === 'kubernetes.io/hostname' && e.operator === 'In' && e.values?.length === 1,
        )?.values[0],
    );
    if (!hosts.length || hosts.some((h) => !h || h !== hosts[0]))
      throw new Error(
        'Node-local restore storage requires exact single-host PV affinity; RWO alone cannot preserve its bytes across nodes.',
      );
  }
  if (
    !desiredOwner[0].spec.template.spec.volumes.some(
      (v) => v.name === 'legacy-restore' && v.persistentVolumeClaim?.claimName === claim.metadata.name,
    )
  )
    throw new Error('Candidate must retain the existing restore claim.');
  const targetClaim = resources.find(
    (r) => r.kind === 'PersistentVolumeClaim' && r.metadata.name === claim.metadata.name,
  );
  if (!targetClaim || !matchesTopologyTemplate(claim.spec, targetClaim.spec))
    throw new Error('Topology transfer may not change restore storage configuration.');
  const inventory =
    saved?.phase !== 'complete' && saved?.topologyProtocol === 1
      ? saved.inventory
      : current
          .filter((r) => ['backend', 'maintenance'].includes(role(r)))
          .map((r) => ({
            name: r.metadata.name,
            uid: r.metadata.uid,
            role: role(r),
            replicas: r.spec.replicas,
          }))
          .sort((a, b) => (a.role === 'backend' ? -1 : 1) - (b.role === 'backend' ? -1 : 1));
  const runtimePods =
    safety.binding.scope === 'production' && !(saved?.phase !== 'complete' && saved?.topologyProtocol === 1)
      ? (await json(['get', 'pods', '-o', 'json'])).items
      : [];
  const runtime =
    saved?.phase !== 'complete' && saved?.topologyProtocol === 1
      ? saved.runtime
      : current
          .filter((r) => role(r) === 'execution')
          .map((r) => ({
            name: r.metadata.name,
            uid: r.metadata.uid,
            replicas: r.spec.replicas,
            image: container(r)?.image,
            ...(safety.binding.scope === 'production'
              ? {
                  revision: r.status?.updateRevision,
                  pods: runtimePods
                    .filter((p) => p.metadata.ownerReferences?.some((o) => o.controller && o.uid === r.metadata.uid))
                    .map((p) => p.metadata.uid)
                    .sort(),
                }
              : {}),
          }));
  const identity = {
    release,
    namespace,
    manifestDigest,
    topologyProtocol: 1,
    from,
    to,
    configurationDigest: getHaConfigurationDigest(resources),
    claimUid: claim.metadata.uid,
    claimName: claim.metadata.name,
    volumeName: claim.spec.volumeName,
    volumeUid: volume.metadata.uid,
    volumeSpecDigest: getHaConfigurationDigest([volume.spec]),
    proxyUid: sourceProxy.metadata.uid,
    runtime,
  };
  if (safety.binding.scope === 'production' && runtime.some((w) => !w.revision || w.pods?.length !== w.replicas))
    throw Error('Topology transfer requires the exact original execution revision and pod UIDs.');
  const until = async (check, message) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() >= deadline)
        throw new Error(`${typeof message === 'function' ? message() : message}; nothing was force removed.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const checkRuntime = async () => {
    if (runtime.length !== 1 || runtime[0].replicas < 2)
      throw new Error('Two frozen production execution owners are required.');
    for (const w of runtime) {
      const live = await json(['get', 'statefulset', w.name, '-o', 'json']);
      if (
        live.metadata.uid !== w.uid ||
        live.spec.replicas !== w.replicas ||
        container(live)?.image !== w.image ||
        !Number.isInteger(live.status?.readyReplicas) ||
        live.status.readyReplicas < 2
      )
        throw new Error('Production execution identity/capacity changed; topology transfer blocked.');
      const runtimePods = (await allPods()).filter((p) => p.metadata.ownerReferences?.some((o) => o.uid === w.uid));
      if (runtimePods.filter(ready).length < 2)
        throw new Error(
          'Two actually ready production execution pods are required; stale controller status is insufficient.',
        );
      if (
        w.pods &&
        (runtimePods.length !== w.pods.length ||
          runtimePods.some(
            (p) =>
              !w.pods.includes(p.metadata.uid) ||
              !ready(p) ||
              p.metadata.labels?.['controller-revision-hash'] !== w.revision,
          ))
      )
        throw Error('Retained topology execution pod identities changed.');
    }
    const currentClaim = await json(['get', 'pvc', identity.claimName, '-o', 'json']);
    if (
      currentClaim.metadata.uid !== identity.claimUid ||
      currentClaim.metadata.deletionTimestamp ||
      currentClaim.spec.volumeName !== identity.volumeName
    )
      throw new Error('Restore claim changed; transfer blocked.');
    const currentVolume = await json(['get', 'pv', identity.volumeName, '-o', 'json']);
    if (
      currentVolume.metadata.uid !== identity.volumeUid ||
      currentVolume.metadata.deletionTimestamp ||
      currentVolume.spec.claimRef?.uid !== identity.claimUid ||
      getHaConfigurationDigest([currentVolume.spec]) !== identity.volumeSpecDigest
    )
      throw new Error('Restore PV identity changed; transfer blocked.');
  };
  const waitForRuntimeEdge = () =>
    until(async () => {
      await checkRuntime();
      const deployment = await json(['get', 'deployment', sourceProxy.metadata.name, '-o', 'json']);
      if (deployment.metadata.uid !== identity.proxyUid || deployment.spec.replicas !== sourceProxy.spec.replicas)
        throw new Error('Proxy identity/capacity changed before developer withdrawal.');
      if (
        !matchesTopologyTemplate(deployment.spec.template, runtimeProxyTemplate) ||
        !Number.isInteger(deployment.status?.observedGeneration) ||
        deployment.status?.observedGeneration < deployment.metadata.generation ||
        deployment.status?.availableReplicas !== sourceProxy.spec.replicas
      )
        return false;
      const proxies = (await allPods()).filter(
        (p) => p.metadata.labels?.['app.kubernetes.io/instance'] === release && role(p) === 'proxy',
      );
      if (
        proxies.length !== sourceProxy.spec.replicas ||
        proxies.some((p) => !ready(p) || !matchesTopologyTemplate(p.spec, runtimeProxyTemplate.spec))
      )
        return false;
      if (
        proxies.some(
          (p) =>
            p.spec.readinessGates?.some((g) => g.conditionType === 'cloud.google.com/load-balancer-neg-ready') &&
            !p.status.conditions?.some(
              (c) =>
                c.type === 'cloud.google.com/load-balancer-neg-ready' &&
                c.status === 'True' &&
                c.reason === 'LoadBalancerNegReady',
            ),
        )
      )
        return false;
      for (const proxy of proxies) {
        const health = await kube(
          [
            'exec',
            proxy.metadata.name,
            '-c',
            'proxy',
            '--',
            'wget',
            '-q',
            '-O',
            '-',
            `http://127.0.0.1:${proxyPort}/readyz`,
          ],
          { allowFailure: true },
        );
        try {
          const status = JSON.parse(health.stdout);
          if (health.exitCode || !status.ok || status.profile !== 'execution') return false;
        } catch {
          return false;
        }
      }
      return true;
    }, 'Execution-owned proxy health has not settled; no developer was withdrawn');
  const pod = async (name) => {
    const raw = (await kube(['get', 'pod', name, '--ignore-not-found', '-o', 'json'])).stdout;
    if (!raw.trim()) return null;
    const p = JSON.parse(raw);
    if (p.metadata.labels?.['app.kubernetes.io/instance'] !== release) throw new Error('Foreign topology owner.');
    const workload = inventory.find((w) =>
      Array.from({ length: w.replicas }, (_, ordinal) => `${w.name}-${ordinal}`).includes(name),
    );
    if (
      !workload ||
      p.metadata.name !== name ||
      !p.metadata.uid ||
      role(p) !== workload.role ||
      !p.metadata.ownerReferences?.some((o) => o.uid === workload.uid)
    )
      throw new Error('Recorded developer pod ownership changed; retirement blocked.');
    return {
      name,
      uid: p.metadata.uid,
      container: p.spec.containers.find((c) => ['backend', 'api'].includes(c.name))?.name,
      raw: p,
    };
  };
  const exec = async (p, args = []) =>
    JSON.parse(
      (await kube(['exec', p.name, '-c', p.container, '--', 'node', '/opt/rivet/retire-backend.mjs', ...args])).stdout,
    );
  const publicServices = new Set(
    resources.filter((r) => r.kind === 'Service' && !r.spec.publishNotReadyAddresses).map((r) => r.metadata.name),
  );
  const routingGone = (target) =>
    waitForHaRoutingWithdrawal({
      pod: target,
      publicServices,
      observePod: pod,
      timeoutMs,
      clock: routingWithdrawalClock,
      readSlices: async () => (await json(['get', 'endpointslice', '-o', 'json'])).items,
    });
  const allPods = async () => (await json(['get', 'pods', '-o', 'json'])).items;
  const templatesApplied = async () => {
    const live = await list('statefulset');
    if (live.length !== target.length) return false;
    if (
      !target.every((t) => {
        const l = live.find((r) => r.metadata.name === t.metadata.name);
        const original = [...inventory, ...runtime].find((w) => w.name === t.metadata.name);
        if (l && original && l.metadata.uid !== original.uid)
          throw new Error('Topology workload UID changed after template transfer; recovery blocked.');
        return (
          l &&
          l.spec.replicas === t.spec.replicas &&
          mode(l) === mode(t) &&
          isDeepStrictEqual(container(l)?.image, container(t)?.image) &&
          hasSameHaOwnerIdentity(l.spec.template, t.spec.template) &&
          isDeepStrictEqual(
            l.spec.template.spec.volumes?.filter((v) => v.name === 'legacy-restore'),
            t.spec.template.spec.volumes?.filter((v) => v.name === 'legacy-restore'),
          ) &&
          matchesTopologyTemplate(l.spec.template, t.spec.template)
        );
      })
    )
      return false;
    const frontends = await list('deployment');
    return resources
      .filter((r) => r.kind === 'Deployment')
      .every((t) => {
        const l = frontends.find((r) => r.metadata.name === t.metadata.name);
        return l && l.spec.replicas === t.spec.replicas && matchesTopologyTemplate(l.spec.template, t.spec.template);
      });
  };
  return runHaControlTopologyTransition({
    identity,
    safety,
    inventory,
    resumeToken,
    timeoutMs,
    readJournal,
    saveJournal: async (record, rv) => {
      if (!record.resourceVersion) {
        // An idle autoscaler may advance a completed journal during preflight.
        // Refresh before the first CAS; never retry an uncertain ownership write.
        const latest = await readJournal();
        if (latest && latest.phase !== 'complete') throw Error('Another release operation acquired the journal during preflight.');
        rv = observedVersion;
      }
      const { resourceVersion: _, ...data } = record;
      const version = rv ?? observedVersion;
      const cm = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: journalName, namespace, ...(version ? { resourceVersion: version } : {}) },
        data: { record: JSON.stringify(data) },
      };
      const saved = JSON.parse(
        (await kube([version ? 'replace' : 'create', '-f', '-', '-o', 'json'], { input: JSON.stringify(cm) })).stdout,
      );
      await artifact('ha-control-topology.json', JSON.stringify(data, null, 2));
      return { ...data, resourceVersion: saved.metadata.resourceVersion };
    },
    preflight: async () => {
      await checkRuntime();
      // This cluster-scoped read is needed after source owners stop. Discover
      // insufficient operator permissions before any edge patch or withdrawal.
      await json(['get', 'volumeattachments', '-o', 'json']);
      for (const w of inventory)
        for (let ordinal = 0; ordinal < w.replicas; ordinal++) {
          const p = await pod(`${w.name}-${ordinal}`);
          if (!p || !ready(p.raw)) throw new Error('Recorded developer owner is missing or not ready.');
        }
      if (current.some((r) => !['backend', 'maintenance', 'execution'].includes(role(r))))
        throw new Error('Unsupported topology reader.');
      // Do not combine storage/credential/image changes with an owner transfer.
      for (const c of current.filter((r) => role(r) !== 'maintenance')) {
        const t = target.find((r) => r.metadata.name === c.metadata.name);
        const normalize = (template) => {
          const copy = structuredClone(template);
          const owner = copy.spec.containers.find((c) => ['backend', 'api'].includes(c.name));
          owner.env = owner.env.filter((e) => e.name !== 'RIVET_HA_CONTROL_PLANE_MODE');
          return copy;
        };
        if (
          !t ||
          container(c)?.image !== container(t)?.image ||
          !hasSameHaOwnerIdentity(normalize(c.spec.template), normalize(t.spec.template))
        )
          throw new Error('Install the same-image bridge first; topology may not change serving identity.');
      }
      const services = await list('service');
      for (const s of services.filter((s) => role(s) !== 'maintenance')) {
        const t = resources.find((r) => r.kind === 'Service' && r.metadata.name === s.metadata.name);
        if (!t || !hasSameHaServiceRouting(s, t))
          throw new Error('Topology may not change existing public Service routing.');
      }
      const frontends = await list('deployment');
      for (const c of frontends) {
        const t = resources.find((r) => r.kind === 'Deployment' && r.metadata.name === c.metadata.name);
        if (role(c) === 'autoscaler') {
          if (!t || role(t) !== 'autoscaler' || c.spec.replicas !== t.spec.replicas ||
              !matchesTopologyTemplate(c.spec.template, t.spec.template))
            throw Error('Topology transfer may not change the independent autoscaler.');
          continue;
        }
        if (
          !t ||
          !['web', 'proxy'].includes(role(c)) ||
          (role(c) === 'proxy' && c.spec.replicas !== t.spec.replicas) ||
          !isDeepStrictEqual(
            c.spec.template.spec.containers.map((c) => c.image),
            t.spec.template.spec.containers.map((c) => c.image),
          )
        )
          throw new Error('Topology may not change frontend images or proxy capacity.');
      }
      for (const p of (await allPods()).filter(
        (p) =>
          p.metadata.labels?.['app.kubernetes.io/instance'] === release &&
          ['backend', 'maintenance', 'execution'].includes(role(p)),
      )) {
        if (!ready(p)) throw new Error('Bridge owner is not ready.');
        const code =
          "const {createHash}=await import('node:crypto');const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/internal/ha/runtime-contract',{headers:{'x-rivet-proxy-auth':createHash('sha256').update(process.env.RIVET_KEY+':proxy-auth').digest('hex')},signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);console.log(await r.text())";
        const contract = JSON.parse(
          (
            await kube([
              'exec',
              p.metadata.name,
              '-c',
              p.spec.containers.find((c) => ['backend', 'api'].includes(c.name)).name,
              '--',
              'node',
              '--input-type=module',
              '-e',
              code,
            ])
          ).stdout,
        );
        if (
          contract.protocol !== 1 ||
          ((from === 'singleton-overlap' || to === 'singleton-overlap') &&
            contract.housekeepingOverlapProtocol !== 1) ||
          (role(p) === 'backend' && contract.scheduledRunScope !== 'latest') ||
          (role(p) === 'execution' &&
            (!contract.executionOwnedProxySettings || contract.scheduledRunScope !== 'published'))
        )
          throw new Error('Bridge runtime contract is missing; no owner was changed.');
        if (from === 'singleton' && to === 'singleton-overlap' && role(p) === 'backend' && contract.maintenanceIdle !== true)
          throw Error('Bridge maintenance is busy or unconfirmed; no developer owner was withdrawn.');
      }
      await artifact('ha-control-topology-preflight.json', JSON.stringify(identity, null, 2));
    },
    prepareRuntimeEdge: async () => {
      if (from !== 'replicated') return; // Already runtime-owned; reverse switches back only after control recovers.
      await checkRuntime();
      const live = await json(['get', 'deployment', sourceProxy.metadata.name, '-o', 'json']);
      if (live.metadata.uid !== identity.proxyUid || live.spec.replicas !== sourceProxy.spec.replicas)
        throw new Error('Proxy identity/capacity changed before runtime health handoff.');
      const patch = [
        { op: 'test', path: '/metadata/uid', value: identity.proxyUid },
        { op: 'test', path: '/metadata/resourceVersion', value: live.metadata.resourceVersion },
        { op: 'test', path: '/spec/replicas', value: sourceProxy.spec.replicas },
        { op: 'replace', path: '/spec/template', value: runtimeProxyTemplate },
      ];
      await kube(['patch', 'deployment', sourceProxy.metadata.name, '--type=json', '-p', JSON.stringify(patch)]);
    },
    waitForRuntimeEdge,
    observePod: pod,
    status: (p) => exec(p),
    withdraw: (p, op, inc) => exec(p, [op, inc, '--withdraw-only']),
    begin: (p, op, inc) => exec(p, [op, inc, '--begin-only']),
    waitForRoutingWithdrawal: routingGone,
    scaleToZero: async (w, drained) => {
      await checkRuntime();
      const live = await json(['get', 'statefulset', w.name, '-o', 'json']);
      if (live.metadata.uid !== w.uid || ![0, w.replicas].includes(live.spec.replicas))
        throw new Error('Developer capacity/UID changed.');
      if (live.spec.replicas === 0) return;
      for (let i = 0; i < w.replicas; i++) {
        const p = await pod(`${w.name}-${i}`);
        if (!p || !drained.some((d) => d.name === p.name && d.uid === p.uid) || (await exec(p)).state !== 'drained')
          throw new Error('Developer drain/UID is not confirmed.');
      }
      await kube([
        'scale',
        `statefulset/${w.name}`,
        '--replicas=0',
        `--current-replicas=${w.replicas}`,
        `--resource-version=${live.metadata.resourceVersion}`,
      ]);
    },
    waitForNoOwners: (w) =>
      until(async () => {
        const live = await json(['get', 'statefulset', w.name, '-o', 'json']);
        if (live.metadata.uid !== w.uid || live.spec.replicas !== 0)
          throw new Error('Stopped owner identity/capacity changed.');
        return !(await allPods()).some((p) => p.metadata.ownerReferences?.some((o) => o.uid === w.uid));
      }, 'Developer processes have not exited'),
    waitForVolumeRelease: async () => {
      await checkRuntime();
      await until(async () => {
        if (
          (await allPods()).some((p) =>
            p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === identity.claimName),
          )
        )
          return false;
        const attachments = (await json(['get', 'volumeattachments', '-o', 'json'])).items;
        return !attachments.some(
          (a) => a.spec.source?.persistentVolumeName === identity.volumeName && a.status?.attached !== false,
        );
      }, 'Restore volume is still owned/attached');
    },
    applyTemplates: async () => {
      await checkRuntime();
      const versions = {};
      for (const w of await list('statefulset')) {
        const recorded = [...inventory, ...runtime].find((r) => r.name === w.metadata.name);
        if (!recorded || recorded.uid !== w.metadata.uid || !w.metadata.resourceVersion)
          throw new Error('Topology workload UID changed before template transfer.');
        if (role(w) !== 'execution' && w.spec.replicas !== 0) throw new Error('Developer workload is not stopped.');
        if (role(w) === 'maintenance' && to !== 'replicated') {
          // Helm's omission must not delete an unobserved replacement object.
          await kube(
            ['delete', '--raw', `/apis/apps/v1/namespaces/${namespace}/statefulsets/${w.metadata.name}`, '-f', '-'],
            {
              input: JSON.stringify({
                apiVersion: 'v1',
                kind: 'DeleteOptions',
                preconditions: { uid: w.metadata.uid, resourceVersion: w.metadata.resourceVersion },
              }),
            },
          );
        } else versions[w.metadata.name] = w.metadata.resourceVersion;
      }
      await applyTemplates({
        ha: { rolloutResourceVersions: versions },
        workflowSchema: { migrationJob: { enabled: false } },
      });
    },
    templatesApplied,
    verify: async () => {
      let pending = 'templates';
      await until(
        async () => {
          await checkRuntime();
          if (!(await templatesApplied())) {
            pending = 'template acknowledgement';
            return false;
          }
          const pods = (await allPods()).filter((p) => p.metadata.labels?.['app.kubernetes.io/instance'] === release);
          const desired = resources.filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind));
          for (const w of desired) {
            const selected = pods.filter((p) =>
              Object.entries(w.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels?.[k] === v),
            );
            if (selected.length !== w.spec.replicas || selected.some((p) => !ready(p))) {
              pending = `${w.metadata.name} ready owners (${selected.length}/${w.spec.replicas})`;
              return false;
            }
            if (
              w.kind === 'Deployment' &&
              selected.some((p) => !matchesTopologyTemplate(p.spec, w.spec.template.spec))
            ) {
              pending = `${w.metadata.name} current frontend template`;
              return false;
            }
          }
          const mounts = pods.filter((p) =>
            p.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === identity.claimName),
          );
          if (mounts.length !== 1 || role(mounts[0]) !== (to !== 'replicated' ? 'backend' : 'maintenance')) {
            pending = 'one maintenance volume owner';
            return false;
          }
          if (to === 'singleton-overlap') {
            const owner = mounts[0];
            const status = JSON.parse((await kube(['exec', owner.metadata.name, '-c', 'backend', '--', 'node', '/opt/rivet/retire-backend.mjs'])).stdout);
            if (status.housekeeping?.state !== 'owner' || status.housekeeping.podUid !== owner.metadata.uid) {
              pending = 'confirmed exclusive housekeeping worker'; return false;
            }
          }
          return true;
        },
        () => `Final topology is pending ${pending}`,
      );
      const settlement = await settle({ retainedExecution: runtime });
      safety.confirmSettlement(settlement);
      await artifact('ha-control-topology-verified.json', JSON.stringify(identity, null, 2));
      return settlement;
    },
  });
}
