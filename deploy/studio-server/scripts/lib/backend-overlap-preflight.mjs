import { isDeepStrictEqual } from 'node:util';
import { cpuQuantity } from './execution-autoscaler-kubernetes.mjs';

const bytes = (value) => {
  const match = /^(\d+(?:\.\d+)?)([KMGTPE]i?|[kMGTPE]|m)?$/.exec(String(value));
  if (!match) throw Error('Backend overlap storage/memory quantity is unconfirmed.');
  const suffix = match[2] ?? '';
  const power = 'KMGTPE'.indexOf(suffix[0]?.toUpperCase()) + 1;
  return Number(match[1]) * (suffix === 'm' ? 0.001 : suffix ? (suffix.endsWith('i') ? 1024 : 1000) ** power : 1);
};
const request = (spec, resource, parse) => {
  const amount = (c) => parse(c.resources?.requests?.[resource] ?? c.resources?.limits?.[resource] ?? '0');
  let sidecars = 0,
    initPeak = 0;
  for (const container of spec.initContainers ?? []) {
    if (container.restartPolicy === 'Always') sidecars += amount(container);
    initPeak = Math.max(initPeak, sidecars + (container.restartPolicy === 'Always' ? 0 : amount(container)));
  }
  return (
    Math.max(initPeak, sidecars + spec.containers.reduce((sum, c) => sum + amount(c), 0)) +
    parse(spec.overhead?.[resource] ?? '0')
  );
};

/** Read-only preflight and invariant checks. Kubernetes remains the final scheduler. */
export async function inspectBackendOverlap({
  kube,
  backend,
  installed,
  namespace,
  expectedDisk,
  desiredClaim,
  capacity = false,
}) {
  const claimName = backend.spec.template.spec.volumes?.find((v) => v.name === 'legacy-restore')?.persistentVolumeClaim
    ?.claimName;
  const oldClaim = installed.spec.template.spec.volumes?.find((v) => v.name === 'legacy-restore')?.persistentVolumeClaim
    ?.claimName;
  if (!claimName || claimName !== oldClaim) throw Error('Backend overlap must retain the exact maintenance claim.');
  const claim = JSON.parse((await kube(['get', 'pvc', claimName, '-o', 'json'])).stdout);
  const disk = {
    name: claimName,
    uid: claim.metadata.uid,
    volume: claim.spec.volumeName,
    requestedStorage: claim.spec.resources.requests.storage,
    accessModes: claim.spec.accessModes,
  };
  if (
    desiredClaim &&
    (desiredClaim.spec.resources.requests.storage !== disk.requestedStorage ||
      !isDeepStrictEqual(desiredClaim.spec.accessModes, disk.accessModes))
  )
    throw Error('Backend overlap may not change maintenance claim size or access mode.');
  if (!disk.volume) throw Error('Backend maintenance volume is unbound.');
  const volume = JSON.parse((await kube(['get', 'pv', disk.volume, '-o', 'json'])).stdout);
  disk.volumeUid = volume.metadata.uid;
  if (!disk.volumeUid || volume.metadata.deletionTimestamp || volume.spec.claimRef?.uid !== disk.uid)
    throw Error('Backend maintenance volume binding changed or is unconfirmed.');
  if (
    !disk.uid ||
    !disk.volume ||
    claim.metadata.deletionTimestamp ||
    claim.status?.phase !== 'Bound' ||
    !isDeepStrictEqual(disk.accessModes, ['ReadWriteOnce']) ||
    (expectedDisk && !isDeepStrictEqual(disk, expectedDisk))
  )
    throw Error('Backend maintenance claim identity/access mode changed or is unconfirmed.');
  const ns = JSON.parse((await kube(['get', 'namespace', namespace, '-o', 'json'])).stdout);
  const uid = backend.spec.template.spec.containers
    .find((c) => c.name === 'backend')
    ?.env.find((e) => e.name === 'RIVET_NAMESPACE_UID')?.value;
  if (!uid || ns.metadata.uid !== uid || ns.metadata.deletionTimestamp)
    throw Error('Backend overlap namespace identity changed.');
  if (!capacity) return disk;
  const pod = JSON.parse((await kube(['get', 'pod', `${backend.metadata.name}-0`, '-o', 'json'])).stdout);
  if (
    !pod.spec.nodeName ||
    pod.metadata.deletionTimestamp ||
    !pod.metadata.ownerReferences?.some((o) => o.controller && o.uid === installed.metadata.uid)
  )
    throw Error('Original backend node/controller is unconfirmed.');
  const node = JSON.parse((await kube(['get', 'node', pod.spec.nodeName, '-o', 'json'])).stdout);
  if (node.spec?.unschedulable || !node.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'))
    throw Error('Original backend node cannot accept overlap capacity.');
  const pods = JSON.parse(
    (
      await kube([
        'get',
        'pods',
        '--all-namespaces',
        '--field-selector',
        `spec.nodeName=${pod.spec.nodeName}`,
        '-o',
        'json',
      ])
    ).stdout,
  ).items.filter((p) => p.spec.nodeName === pod.spec.nodeName && !['Succeeded', 'Failed'].includes(p.status?.phase));
  for (const [resource, parse] of [
    ['cpu', cpuQuantity],
    ['memory', bytes],
  ]) {
    const available =
      parse(node.status.allocatable[resource]) - pods.reduce((sum, p) => sum + request(p.spec, resource, parse), 0);
    if (available < request(backend.spec.template.spec, resource, parse))
      throw Error(`Insufficient ${resource} on the existing backend node for temporary overlap; old backend retained.`);
  }
  if (pods.length >= Number(node.status.allocatable.pods)) throw Error('No pod slot remains on the backend node.');
  return disk;
}
