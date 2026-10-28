import { isDeepStrictEqual } from 'node:util';
import { resourceQuantity, podResourceRequest as request } from './pod-resource-requests.mjs';

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
  for (const resource of ['cpu', 'memory']) {
    const parse = (value) => resourceQuantity(value, resource);
    const available =
      parse(node.status.allocatable[resource]) - pods.reduce((sum, p) => sum + request(p.spec, resource), 0);
    if (available < request(backend.spec.template.spec, resource))
      throw Error(`Insufficient ${resource} on the existing backend node for temporary overlap; old backend retained.`);
  }
  if (pods.length >= Number(node.status.allocatable.pods)) throw Error('No pod slot remains on the backend node.');
  return disk;
}
