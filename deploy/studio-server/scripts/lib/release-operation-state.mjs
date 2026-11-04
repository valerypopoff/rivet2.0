/** Runtime journal predicates only. No deployment implementation or provider IO. */
export function executionPoolSettled(record) {
  return (
    (record.executionPoolPlan === undefined && record.executionPool === undefined) ||
    (record.executionPoolPlan?.protocol === 1 &&
      record.executionPool === undefined &&
      record.abortedBeforeTemplates === true &&
      !record.owner &&
      record.completed?.length === 0) ||
    (record.executionPoolPlan?.protocol === 1 &&
      record.executionPool?.protocol === 1 &&
      record.executionPool.phase === 'complete' &&
      record.executionPool.scaleIssued === true &&
      record.executionPool.candidateUid &&
      record.executionPool.owners?.length === 2 &&
      record.executionPool.owners.every((owner) => owner.beginIssued && owner.withdrawIssued))
  );
}
export function proxyContinuitySettled(record) {
  const state = record.proxyContinuity;
  return (
    state === undefined ||
    (state.phase === 'complete' &&
      state.routeRestored === true &&
      (!state.hpaFreezeIntent || state.hpaReleased) &&
      Array.isArray(state.entries) &&
      state.entries.every((entry) => !entry.intent || entry.absent))
  );
}
