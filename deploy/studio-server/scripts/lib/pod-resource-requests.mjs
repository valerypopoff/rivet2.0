import { cpuQuantity } from './execution-autoscaler-kubernetes.mjs';

export function resourceQuantity(value, resource) {
  if (resource === 'cpu') return cpuQuantity(value);
  const match = /^(\d+(?:\.\d+)?)([KMGTPE]i?|[kMGTPE]|m)?$/.exec(String(value));
  if (!match) throw Error(`Pod ${resource} quantity is unconfirmed.`);
  const suffix = match[2] ?? '';
  const power = 'KMGTPE'.indexOf(suffix[0]?.toUpperCase()) + 1;
  return Number(match[1]) * (suffix === 'm' ? 0.001 : suffix ? (suffix.endsWith('i') ? 1024 : 1000) ** power : 1);
}

/** Kubernetes effective requests include restartable init sidecars and overhead. */
export function podResourceRequest(spec, resource) {
  const parse = (value) => resourceQuantity(value, resource);
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
}
