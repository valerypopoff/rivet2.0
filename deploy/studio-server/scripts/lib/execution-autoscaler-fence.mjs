/** A template fence is copied to every new ordinal, but applies only to its name. */
export function classifyStartupFence(value, name, workload) {
  if (value === undefined) return 'absent';
  const ordinal = typeof value === 'string' && value.startsWith(`${workload}-`) ? value.slice(workload.length + 1) : '';
  if (!/^(0|[1-9]\d*)$/.test(ordinal) || !Number.isSafeInteger(Number(ordinal)))
    throw Error('Malformed or foreign execution startup fence.');
  return value === name ? 'self' : 'inherited';
}

export function assertFenceIntent(intent, target) {
  if (
    intent?.protocol !== 1 ||
    intent.name !== target.name ||
    intent.uid !== target.uid ||
    intent.workloadUid !== target.workloadUid ||
    intent.incarnation !== target.incarnation ||
    intent.operationId !== target.operationId ||
    !intent.steps ||
    Object.keys(intent.steps).sort().join(',') !== 'pod,template'
  )
    throw Error('Startup fence intent identity or version is unconfirmed.');
  for (const step of Object.values(intent.steps))
    if (!step || !(step.before === null || typeof step.before === 'string') || typeof step.confirmed !== 'boolean')
      throw Error('Startup fence step is invalid.');
}
