/** Runtime journal predicates only. No deployment implementation or provider IO. */
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
