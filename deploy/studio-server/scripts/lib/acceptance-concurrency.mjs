/** Independent acceptance reads may overlap; never return while a started
 * journey can still use credentials, sockets, database or browser resources. */
export async function settleAcceptanceReads(reads) {
  const results = await Promise.allSettled(reads.map((read) => Promise.resolve().then(read)));
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Application acceptance journeys failed');
  return results.map((result) => result.value);
}

/** Closing long-probe admission does not close short availability observation.
 * Every accepted cohort finishes before final observer shutdown. */
export async function runLongProbeCohorts({ shouldStop, shouldStopLong, runCohort, wait }) {
  while (!(await shouldStop()) && !(await shouldStopLong())) await runCohort();
  while (!(await shouldStop())) await wait();
}
