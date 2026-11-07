import { performance } from 'node:perf_hooks';
import { kubernetesReadRetryReason } from './kubernetes-read-errors.mjs';

export const HA_ROUTING_PROPAGATION_MS = 60_000;

export const hasHaPublicEndpoint = (slices, publicServices, uid) =>
  slices.some(
    (slice) =>
      publicServices.has(slice.metadata?.labels?.['kubernetes.io/service-name']) &&
      slice.endpoints?.some((endpoint) => endpoint.targetRef?.uid === uid && endpoint.conditions?.ready !== false),
  );

/** EndpointSlice acknowledgement is control-plane state, not kube-proxy/NEG
 * convergence. Keep admission open during one continuous propagation window.
 * A route returning resets the window; recovery starts a fresh observation.
 * The clock dependency permits deterministic tests, not a shorter CLI policy. */
export async function waitForHaRoutingWithdrawal({
  readSlices,
  observePod,
  pod,
  publicServices,
  timeoutMs,
  protectedResponseMs = 0,
  routingReady = () => true,
  clock = { now: () => performance.now(), wait: () => new Promise((resolve) => setTimeout(resolve, 1000)) },
}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    ![0, 300_000].includes(protectedResponseMs) ||
    !pod?.uid ||
    !(publicServices instanceof Set) ||
    !publicServices.size
  )
    throw Error('Invalid HA endpoint withdrawal observation.');
  let deadline = clock.now() + timeoutMs;
  let absentSince = null,
    propagationBudgetAdded = false;
  while (true) {
    if (clock.now() >= deadline)
      throw Error('Timed out waiting for endpoint withdrawal propagation; admission was not fenced.');
    let owner, slices;
    try {
      owner = await observePod(pod.name);
      if (owner?.uid !== pod.uid) throw Error('HA owner changed during endpoint withdrawal; admission was not fenced.');
      slices = await readSlices();
    } catch (error) {
      if (!kubernetesReadRetryReason(error)) throw error;
      absentSince = null;
      if (clock.now() >= deadline)
        throw new Error('Timed out waiting for endpoint withdrawal propagation; admission was not fenced.', {
          cause: error,
        });
      await clock.wait();
      continue;
    }
    const routed = hasHaPublicEndpoint(slices, publicServices, pod.uid) || !(await routingReady(slices));
    const now = clock.now();
    if (routed) absentSince = null;
    else {
      absentSince ??= now;
      if (!propagationBudgetAdded) {
        deadline += HA_ROUTING_PROPAGATION_MS + protectedResponseMs;
        propagationBudgetAdded = true;
      }
      if (now - absentSince >= HA_ROUTING_PROPAGATION_MS + protectedResponseMs && now < deadline) return;
    }
    if (now >= deadline)
      throw Error('Timed out waiting for endpoint withdrawal propagation; admission was not fenced.');
    await clock.wait();
  }
}
