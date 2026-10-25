/** Runs under the existing deployment journal/lease. Commands are recorded
 * before sending; an uncertain acknowledgement is observed, never replayed. */
export async function handoverHousekeeping({
  source,
  target,
  operation,
  status,
  command,
  confirmReady,
  timeoutMs,
  now = Date.now,
  wait = () => new Promise((resolve) => setTimeout(resolve, 250)),
}) {
  if (!source?.uid || !target?.uid || source.uid === target.uid || typeof confirmReady !== 'function')
    throw Error('Housekeeping handover requires distinct confirmed owners and developer acceptance.');
  const matches = (actual, pod, incarnation = actual?.incarnation) =>
    Boolean(incarnation) &&
    actual?.incarnation === incarnation &&
    actual.housekeeping?.protocol === 1 &&
    actual.housekeeping.podUid === pod.uid &&
    actual.housekeeping.incarnation === incarnation;
  const assertAcquirable = (peer) => {
    if (!['standby', 'released'].includes(peer.housekeeping.state))
      throw Error('Housekeeping target cannot acquire ownership; old owner retained.');
  };
  await confirmReady(target);
  let saved = operation.record.owner.housekeeping;
  if (!saved) {
    const before = await status(source),
      peer = await status(target);
    if (!matches(before, source) || !matches(peer, target) || before.housekeeping.state !== 'owner')
      throw Error('Housekeeping protocol/owner is unconfirmed; no backend was retired.');
    assertAcquirable(peer);
    saved = {
      sourceUid: source.uid,
      targetUid: target.uid,
      sourceIncarnation: before.incarnation,
      targetIncarnation: peer.incarnation,
      releaseIssued: false,
      acquireIssued: false,
    };
    await operation.checkpoint({ owner: { ...operation.record.owner, housekeeping: saved } });
  }
  if (saved.sourceUid !== source.uid || saved.targetUid !== target.uid)
    throw Error('Housekeeping handover pod identity changed.');
  const checkpoint = async (patch) => {
    saved = { ...saved, ...patch };
    await operation.checkpoint({ owner: { ...operation.record.owner, housekeeping: saved } });
  };
  const observe = async (pod, incarnation, desired) => {
    const deadline = now() + timeoutMs;
    while (true) {
      operation.assertLease();
      const actual = await status(pod);
      if (!matches(actual, pod, incarnation)) throw Error('Housekeeping process incarnation changed.');
      if (actual.housekeeping.operationId !== operation.record.token)
        throw Error('Housekeeping operation identity changed; backends and disk were retained.');
      if (actual.housekeeping.state === desired) return;
      if (actual.housekeeping.state === 'failed' || now() >= deadline)
        throw Error('Housekeeping handover is unsettled; backends and disk were retained.');
      await wait();
    }
  };
  if (!saved.releaseIssued) {
    const peer = await status(target);
    if (!matches(peer, target, saved.targetIncarnation)) throw Error('Housekeeping process incarnation changed.');
    assertAcquirable(peer);
    await checkpoint({ releaseIssued: true });
    operation.assertLease();
    await command(source, 'release', operation.record.token, saved.sourceIncarnation);
  }
  await observe(source, saved.sourceIncarnation, 'released');
  if (!saved.acquireIssued) {
    await checkpoint({ acquireIssued: true });
    operation.assertLease();
    await command(target, 'acquire', operation.record.token, saved.targetIncarnation);
  }
  await observe(target, saved.targetIncarnation, 'owner');
  await confirmReady(target);
  await checkpoint({ complete: true });
}
