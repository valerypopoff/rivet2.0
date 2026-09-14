/**
 * Returns only the compact pod state needed to explain why a disposable
 * dependency did not start. Deliberately omit container log and waiting
 * messages here: those can be lengthy or operator-specific and are retained
 * in the gate artifact instead.
 */
export function summarizePodStartupState(podListJson) {
  let pods;
  try {
    const parsed = JSON.parse(podListJson);
    pods = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return 'Kubernetes did not return a readable pod list';
  }

  if (pods.length === 0) return 'no matching dependency pod was created';

  const summaries = pods.map((pod) => {
    const initContainerStatuses = Array.isArray(pod?.status?.initContainerStatuses)
      ? pod.status.initContainerStatuses
      : [];
    const containerStatuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
    const statuses = [...initContainerStatuses, ...containerStatuses];
    const containerStates = statuses.flatMap((status) => {
      const reason = status?.state?.waiting?.reason ?? status?.state?.terminated?.reason;
      if (typeof reason !== 'string' || reason.length === 0) return [];
      const containerName = typeof status?.name === 'string' && status.name.length > 0 ? `${status.name}=` : '';
      return `${containerName}${reason}`;
    });
    const conditions = Array.isArray(pod?.status?.conditions) ? pod.status.conditions : [];
    const unschedulableReason = conditions.find(
      (condition) =>
        condition?.type === 'PodScheduled' &&
        condition?.status !== 'True' &&
        typeof condition?.reason === 'string' &&
        condition.reason.length > 0,
    )?.reason;
    const phase = typeof pod?.status?.phase === 'string' ? pod.status.phase : 'Unknown';
    const podName = typeof pod?.metadata?.name === 'string' ? pod.metadata.name : '<unnamed pod>';
    const reasons = [...containerStates, ...(unschedulableReason ? [unschedulableReason] : [])];
    return reasons.length > 0 ? `${podName} (${phase}): ${reasons.join(', ')}` : `${podName} (${phase})`;
  });

  return summaries.join('; ');
}
