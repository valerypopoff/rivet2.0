import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { journalForReleaseOperation } from './release-operation-journal.mjs';
import { verifyRecoveryReceipt, verifyRetainedMaintenanceMigration } from './maintenance-deployment-plan.mjs';
import { releaseReplicaBounds } from './kubernetes-release-settlement.mjs';

/** Only GETs may wait for an idle controller's sampling lease. A newly busy
 * operation or a CAS race still fails closed; no write is retried here.
 * previousResource pins a prior admission; explicit null pins its absence. */
export async function readAvailableReleaseJournal({
  kube,
  name,
  kind,
  release,
  namespace,
  timeoutMs,
  previousResource,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw Error('Journal admission requires a bounded positive timeout.');
  const deadline = now() + Math.min(timeoutMs, 30_000);
  let observedUid;
  while (true) {
    const result = await kube(['get', 'configmap', name, '--ignore-not-found', '-o', 'json']);
    if (!result.stdout.trim()) {
      if (observedUid || previousResource) throw Error('Release operation journal disappeared during admission.');
      return { resource: null, record: null };
    }
    const resource = JSON.parse(result.stdout);
    if (
      resource.metadata?.name !== name ||
      resource.metadata.namespace !== namespace ||
      !resource.metadata.uid ||
      !resource.metadata.resourceVersion
    )
      throw Error('Release operation journal resource identity is unconfirmed.');
    if (observedUid && resource.metadata.uid !== observedUid)
      throw Error('Release operation journal immutable identity changed during admission.');
    observedUid = resource.metadata.uid;
    const observed = { ...JSON.parse(resource.data.record), resourceVersion: resource.metadata.resourceVersion };
    if (previousResource !== undefined) {
      if (!previousResource || previousResource.metadata.uid !== resource.metadata.uid)
        throw Error('Release operation journal immutable identity changed during admission.');
      const previous = JSON.parse(previousResource.data.record);
      for (const field of [
        'release',
        'namespace',
        'manifestDigest',
        'policyDigest',
        'autoscalingProtocol',
        'protocol',
        'formatVersion',
      ])
        if (!isDeepStrictEqual(previous[field], observed[field]))
          throw Error('Release operation journal binding changed during admission.');
      // Only completed sampling may change its operation identity between reads.
      if (
        observed.autoscalingProtocol !== 1 &&
        (previous.token !== observed.token || previous.runner !== observed.runner)
      )
        throw Error('Release operation journal owner changed during admission.');
    }
    if (
      observed.autoscalingProtocol === 1 &&
      observed.phase === 'complete' &&
      ['scale', 'target', 'fence', 'fenceRepair', 'removal'].some((field) => observed[field] != null)
    )
      throw Error('Completed autoscaler journal retains unfinished work; no ownership write was attempted.');
    if (observed.autoscalingProtocol === 1 && kind !== 'autoscaling') {
      const controller = journalForReleaseOperation(observed, 'autoscaling', { release, namespace }, now);
      if (controller.phase === 'complete' && controller.leaseExpiresAt > now()) {
        if (now() >= deadline)
          throw Error('Autoscaler sampling lease did not settle; no ownership write was attempted.');
        await sleep(1000);
        continue;
      }
    }
    return { resource, record: journalForReleaseOperation(observed, kind, { release, namespace }, now) };
  }
}

export function parseReleaseResources(text) {
  return parseAllDocuments(text)
    .map((document) => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON();
    })
    .filter(Boolean);
}

/** Helm's stored manifest has no API-defaulted fields. Compare all declarative
 * settings, not just image tags. Hooks are separately executed, not installed
 * manifest objects; transient CAS versions are never application settings.
 * With installation identity, reuse settlement's bounds for elastic counts. */
export function assertInstalledReleaseManifest(expected, installed, { release, namespace } = {}) {
  const bounds = release && namespace ? releaseReplicaBounds(expected, release, namespace) : new Map();
  const normalize = (resources, checkCapacity = false) =>
    resources
      .filter((r) => !r.metadata?.annotations?.['helm.sh/hook'])
      .map((resource) => {
        const value = structuredClone(resource);
        delete value.metadata.resourceVersion;
        const capacity = bounds.get(`${value.kind}/${value.metadata.name}`);
        if (capacity?.automatic) {
          const replicas = value.spec.replicas ?? 1;
          if (checkCapacity && (!Number.isInteger(replicas) || replicas < capacity.min || replicas > capacity.max))
            throw Error('Installed Helm capacity is outside the approved autoscaling policy.');
          // Helm deliberately preserves grown capacity during upgrades. Its
          // historical replica count is not a different application setting.
          delete value.spec.replicas;
        }
        return value;
      })
      .sort((a, b) => `${a.kind}/${a.metadata.name}`.localeCompare(`${b.kind}/${b.metadata.name}`));
  if (!isDeepStrictEqual(normalize(expected), normalize(installed, true)))
    throw Error(
      'Installed Helm configuration differs from the exact final candidate; verification cannot replace a deployment.',
    );
}

/** API defaulting adds fields to mounts/volumes. Check declared settings while
 * requiring complete ordered env/command arrays: a same-image manual edit is
 * not proof that the approved execution configuration is running. */
export function assertInstalledExecutionSettings(resources, items) {
  const declared = (expected, actual) => {
    if (Array.isArray(expected))
      return (
        Array.isArray(actual) &&
        expected.length === actual.length &&
        expected.every((value, index) => declared(value, actual[index]))
      );
    if (expected && typeof expected === 'object')
      return actual && Object.entries(expected).every(([key, value]) => declared(value, actual[key]));
    return isDeepStrictEqual(expected, actual);
  };
  const environment = (expected, actual) =>
    Array.isArray(actual) &&
    expected.length === actual.length &&
    expected.every((entry, index) => {
      const live = actual[index];
      if (!live || entry.name !== live.name) return false;
      if (entry.valueFrom !== undefined)
        return (live.value === undefined || live.value === '') && declared(entry.valueFrom, live.valueFrom);
      // EnvVar.value has omitempty semantics in Kubernetes. Do not apply this
      // equivalence to args, arbitrary settings, or valueFrom references.
      return (
        live.valueFrom === undefined &&
        (entry.value === undefined || typeof entry.value === 'string') &&
        (live.value === undefined || typeof live.value === 'string') &&
        (entry.value === undefined ? '' : entry.value) === (live.value === undefined ? '' : live.value)
      );
    });
  for (const resource of resources.filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind))) {
    const matches = items.filter(
      (item) => item.kind === resource.kind && item.metadata.name === resource.metadata.name,
    );
    if (matches.length !== 1) throw Error('Live workload configuration identity is missing or ambiguous.');
    const expected = resource.spec.template.spec,
      actual = matches[0].spec.template.spec;
    const fields = ['envFrom', 'command', 'args', 'volumeMounts'];
    for (const group of ['containers', 'initContainers']) {
      const wanted = expected[group] ?? [],
        live = actual[group] ?? [];
      if (
        wanted.length !== live.length ||
        wanted.some((container) => {
          const current = live.find((c) => c.name === container.name);
          return (
            !current ||
            !environment(container.env ?? [], current.env ?? []) ||
            fields.some((field) => !declared(container[field] ?? [], current[field] ?? []))
          );
        })
      )
        throw Error('Live workload execution settings differ from the approved candidate.');
    }
    if (
      !declared(expected.volumes ?? [], actual.volumes ?? []) ||
      (expected.serviceAccountName && expected.serviceAccountName !== actual.serviceAccountName)
    )
      throw Error('Live workload storage or identity settings differ from the approved candidate.');
  }
}

/** Retained bytes are checked again, not trusted because verified.json exists.
 * This proves the original frozen checkpoint, not a new capture or restore. */
export async function verifyRetainedCutoverCheckpoint(root, directory, context, token, planDigest, maintenance) {
  const contained = (base, file) => {
    const relative = path.relative(base, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  directory = path.resolve(root, directory ?? '');
  if (!contained(root, directory)) throw Error('Recovery checkpoint escaped the original repository.');
  const initial = await fs.lstat(directory, { bigint: true });
  if (!initial.isDirectory() || !contained(await fs.realpath(root), await fs.realpath(directory)))
    throw Error('Recovery checkpoint must remain a private directory inside the original repository.');
  const read = async (name) => {
    const file = path.join(directory, name);
    if (!(await fs.lstat(file)).isFile()) throw Error('Recovery receipt must be a regular file.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  };
  const request = await read('request.json'),
    receipt = await read('receipt.json');
  if (
    request.formatVersion !== 1 ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    request.token !== token ||
    request.consistency !== 'quiesced' ||
    request.operationPlanDigest !== planDigest ||
    ['release', 'namespace', 'context', 'namespaceUid', 'installedManifestDigest', 'candidateManifestDigest'].some(
      (key) => request[key] !== context[key],
    )
  )
    throw Error('Retained checkpoint belongs to another installation or cutover.');
  const verified = await verifyRecoveryReceipt(receipt, directory, request);
  if (maintenance?.plan.schemaMigration)
    await verifyRetainedMaintenanceMigration(maintenance, directory, request, receipt);
  const final = await fs.lstat(directory, { bigint: true });
  if (
    !final.isDirectory() ||
    final.dev !== initial.dev ||
    final.ino !== initial.ino ||
    !contained(await fs.realpath(root), await fs.realpath(directory))
  )
    throw Error('Retained recovery directory identity changed during verification.');
  return verified;
}

/** When final inventory inspection was lost, freeze observed target identities
 * only after matching every controller name/kind and retained original claim.
 * Subsequent settlement must reconfirm this same observed inventory. */
export function assertCutoverVerificationTarget(resources, current, originalClaims) {
  const expected = resources
    .filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind))
    .map((r) => `${r.kind.toLowerCase()}/${r.metadata.name}`)
    .sort();
  const actual = current.workloads.map((r) => `${r.kind}/${r.name}`).sort();
  if (!isDeepStrictEqual(expected, actual) || new Set(actual).size !== actual.length)
    throw Error('Observed final controllers do not match the complete approved candidate.');
  const wantedHpas = resources
    .filter((r) => r.kind === 'HorizontalPodAutoscaler')
    .map((r) => r.metadata.name)
    .sort();
  if (
    !Array.isArray(current.autoscalers) ||
    current.autoscalers.some((item) => !item.uid) ||
    !isDeepStrictEqual(wantedHpas, current.autoscalers.map((item) => item.name).sort())
  )
    throw Error('Observed final autoscalers do not match the complete approved candidate.');
  assertCutoverVerificationInventory({ workloads: current.workloads, claims: originalClaims }, current);
  return current;
}

export function assertCutoverVerificationInventory(expected, current) {
  const identities = (inventory) =>
    inventory.workloads
      .map(({ kind, name, uid }) => ({ kind, name, uid }))
      .sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  if (
    !expected?.workloads?.length ||
    expected.workloads.some((item) => !item.uid) ||
    !isDeepStrictEqual(identities(expected), identities(current))
  )
    throw Error('Final workload identities changed; verification-only recovery is not admitted.');
  const claims = (inventory) => [...inventory.claims].sort((a, b) => a.name.localeCompare(b.name));
  if (
    !Array.isArray(expected.claims) ||
    expected.claims.some((item) => !item.uid) ||
    !Array.isArray(current.claims) ||
    !isDeepStrictEqual(claims(expected), claims(current))
  )
    throw Error('Final persistent claim identities changed; verification-only recovery is not admitted.');
  if (expected.autoscalers) {
    const legacy = expected.autoscalers.every((item) => typeof item === 'string');
    const identities = (items) =>
      items
        .map((item) =>
          typeof item === 'string' ? { name: item } : { name: item.name, ...(legacy ? {} : { uid: item.uid }) },
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    if (
      !Array.isArray(current.autoscalers) ||
      !isDeepStrictEqual(identities(expected.autoscalers), identities(current.autoscalers))
    )
      throw Error('Final autoscaler identities changed; verification-only recovery is not admitted.');
  }
}

export function assertNoExecutionStartupFences(items) {
  const key = 'rivet.dev/execution-retirement-fence';
  if (items.some((item) => item.metadata?.annotations?.[key] || item.spec?.template?.metadata?.annotations?.[key]))
    throw Error(
      'An execution startup fence remains. Inspect its exact controller operation before deployment; preflight never repairs or removes fences.',
    );
}
