import { createHash } from 'node:crypto';
import { proxyContinuitySettled } from './proxy-continuity-transition.mjs';

export function haPreparationSettled(record) {
  const preparation = record.preparation;
  return (
    preparation === undefined ||
    (preparation?.protocol === 1 &&
      ['complete', 'cleaned-failed'].includes(preparation.state) &&
      Array.isArray(preparation.jobs) &&
      preparation.jobs.every((job) => !job.createIssued || job.absent === true))
  );
}

/** Older installed controllers could close an expired preflight without
 * understanding its proxy handoff. Keep that exact token recovery-only; the
 * caller still validates identity, lease expiry and explicit resume authority
 * before this view is ever persisted by a CAS. */
export function haJournalForRecovery(record) {
  if (!record || record.phase !== 'complete') return record;
  if (!haPreparationSettled(record)) throw Error('Completed HA journal has unfinished replacement preparation.');
  if (proxyContinuitySettled(record)) return record;
  if (
    record.abortedBeforeTemplates !== true ||
    !record.runner?.startsWith('preflight-recovery-') ||
    record.owner ||
    !Array.isArray(record.completed) ||
    record.completed.length !== 0
  )
    throw Error('Completed HA journal has an unfinished proxy handoff; inspect its original ownership.');
  const { abortedBeforeTemplates: _aborted, ...original } = record;
  return { ...original, phase: 'preflight' };
}

// Both mutation paths must CAS the same resource. Checking two independent
// journals before acquiring either one leaves a maintenance/HA start race.
export function releaseOperationJournalName(release) {
  return `${release.slice(0, 32)}-${createHash('sha256').update(release).digest('hex').slice(0, 8)}-cutover`;
}

export function journalForReleaseOperation(record, kind, identity, now = Date.now) {
  if (!record) return null;
  const actualKind =
    record.autoscalingProtocol === 1 && record.protocol === undefined && record.formatVersion === undefined
      ? 'autoscaling'
      : record.autoscalingProtocol !== undefined
        ? null
        : record.protocol === 1 && record.formatVersion === undefined
          ? 'ha'
          : record.formatVersion === 1 && record.protocol === undefined
            ? 'cutover'
            : null;
  if (
    !actualKind ||
    record.release !== identity.release ||
    record.namespace !== identity.namespace ||
    !record.resourceVersion ||
    !Number.isFinite(record.leaseExpiresAt) ||
    typeof record.token !== 'string' ||
    !record.token ||
    typeof record.runner !== 'string' ||
    !record.runner ||
    typeof record.manifestDigest !== 'string' ||
    !record.manifestDigest ||
    !(
      actualKind === 'ha'
        ? ['preflight', 'templates', 'owners', 'complete']
        : actualKind === 'autoscaling'
          ? ['complete', 'scaling', 'fencing', 'withdrawing', 'draining', 'removing', 'unfencing']
          : ['quiescing', 'quiesced', 'validating', 'resuming', 'complete']
    ).includes(record.phase)
  )
    throw new Error('Release operation journal identity or format is unconfirmed.');
  const selected = actualKind === 'ha' ? haJournalForRecovery(record) : record;
  if (actualKind === kind) return selected;
  if (selected.phase !== 'complete' || selected.leaseExpiresAt > now())
    throw new Error(`The ${actualKind} operation owns this release; recover it before starting ${kind}.`);
  // The caller retains resourceVersion and CAS-replaces a completed foreign-kind
  // journal, never deletes it or turns an expired unfinished operation into null.
  return null;
}
