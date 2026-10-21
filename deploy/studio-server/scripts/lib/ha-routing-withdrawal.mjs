import { performance } from 'node:perf_hooks';

export const HA_ROUTING_PROPAGATION_MS = 60_000;

export const hasHaPublicEndpoint = (slices, publicServices, uid) => slices.some(slice =>
  publicServices.has(slice.metadata?.labels?.['kubernetes.io/service-name']) &&
  slice.endpoints?.some(endpoint => endpoint.targetRef?.uid === uid && endpoint.conditions?.ready !== false));

/** EndpointSlice acknowledgement is control-plane state, not kube-proxy/NEG
 * convergence. Keep admission open during one continuous propagation window.
 * A route returning resets the window; recovery starts a fresh observation.
 * The clock dependency permits deterministic tests, not a shorter CLI policy. */
export async function waitForHaRoutingWithdrawal({
  readSlices, observePod, pod, publicServices, timeoutMs,
  clock = { now: () => performance.now(), wait: () => new Promise(resolve => setTimeout(resolve, 1000)) },
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !pod?.uid ||
      !(publicServices instanceof Set) || !publicServices.size)
    throw Error('Invalid HA endpoint withdrawal observation.');
  let deadline = clock.now() + timeoutMs;
  let absentSince = null, propagationBudgetAdded = false;
  while (true) {
    if ((await observePod(pod.name))?.uid !== pod.uid)
      throw Error('HA owner changed during endpoint withdrawal; admission was not fenced.');
    const slices = await readSlices();
    const routed = hasHaPublicEndpoint(slices, publicServices, pod.uid);
    const now = clock.now();
    if (routed) absentSince = null;
    else {
      absentSince ??= now;
      if (!propagationBudgetAdded) { deadline += HA_ROUTING_PROPAGATION_MS; propagationBudgetAdded = true; }
      if (now - absentSince >= HA_ROUTING_PROPAGATION_MS) return;
    }
    if (now >= deadline)
      throw Error('Timed out waiting for endpoint withdrawal propagation; admission was not fenced.');
    await clock.wait();
  }
}
