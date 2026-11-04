import { journalForReleaseOperation } from './release-operation-journal.mjs';

/** A completed autoscaler tick briefly holds the shared journal while sampling.
 * Wait using reads only; never take an unfinished operation or override a lease. */
export async function readReleaseOperationJournal({
  read,
  kind,
  identity,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 30000,
}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw Error('Journal sampling wait must be bounded.');
  const deadline = now() + waitMs;
  let sampling;
  for (;;) {
    const { record, uid } = await read();
    if (
      sampling &&
      (!record ||
        uid !== sampling.uid ||
        ['release', 'namespace', 'manifestDigest', 'policyDigest', 'autoscalingProtocol'].some(
          (key) => record[key] !== sampling.record[key],
        ))
    )
      throw Error('Release journal identity changed while waiting for an autoscaler sample.');
    try {
      return journalForReleaseOperation(record, kind, identity, now);
    } catch (error) {
      if (kind === 'autoscaling' || record?.autoscalingProtocol !== 1 || record.phase !== 'complete') throw error;
      // Validate the full original format and installation before waiting.
      journalForReleaseOperation(record, 'autoscaling', identity, now);
      if (!uid || record.leaseExpiresAt <= now() || now() >= deadline) throw error;
      sampling ??= { uid, record };
      await sleep(Math.min(250, deadline - now()));
    }
  }
}
