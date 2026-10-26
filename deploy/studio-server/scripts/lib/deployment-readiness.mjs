import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { journalForReleaseOperation } from './release-operation-journal.mjs';
import { verifyRecoveryReceipt } from './maintenance-deployment-plan.mjs';

/** Only GETs may wait for an idle controller's sampling lease. A newly busy
 * operation or a CAS race still fails closed; no write is retried here. */
export async function readAvailableReleaseJournal({
  kube,
  name,
  kind,
  release,
  namespace,
  timeoutMs,
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
      if (observedUid) throw Error('Release operation journal disappeared during admission.');
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
 * manifest objects; transient CAS versions are never application settings. */
export function assertInstalledReleaseManifest(expected, installed) {
  const normalize = (resources) =>
    resources
      .filter((r) => !r.metadata?.annotations?.['helm.sh/hook'])
      .map((resource) => {
        const value = structuredClone(resource);
        delete value.metadata.resourceVersion;
        return value;
      })
      .sort((a, b) => `${a.kind}/${a.metadata.name}`.localeCompare(`${b.kind}/${b.metadata.name}`));
  if (!isDeepStrictEqual(normalize(expected), normalize(installed)))
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
  for (const resource of resources.filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind))) {
    const matches = items.filter(
      (item) => item.kind === resource.kind && item.metadata.name === resource.metadata.name,
    );
    if (matches.length !== 1) throw Error('Live workload configuration identity is missing or ambiguous.');
    const expected = resource.spec.template.spec,
      actual = matches[0].spec.template.spec;
    const fields = ['env', 'envFrom', 'command', 'args', 'volumeMounts'];
    for (const group of ['containers', 'initContainers']) {
      const wanted = expected[group] ?? [],
        live = actual[group] ?? [];
      if (
        wanted.length !== live.length ||
        wanted.some((container) => {
          const current = live.find((c) => c.name === container.name);
          return !current || fields.some((field) => !declared(container[field] ?? [], current[field] ?? []));
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
export async function verifyRetainedCutoverCheckpoint(root, directory, context, token, planDigest) {
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
}

export function assertNoExecutionStartupFences(items) {
  const key = 'rivet.dev/execution-retirement-fence';
  if (items.some((item) => item.metadata?.annotations?.[key] || item.spec?.template?.metadata?.annotations?.[key]))
    throw Error(
      'An execution startup fence remains. Inspect its exact controller operation before deployment; preflight never repairs or removes fences.',
    );
}
