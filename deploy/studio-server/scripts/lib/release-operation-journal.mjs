import { createHash } from 'node:crypto';

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
  if (actualKind === kind) return record;
  if (record.phase !== 'complete' || record.leaseExpiresAt > now())
    throw new Error(`The ${actualKind} operation owns this release; recover it before starting ${kind}.`);
  // The caller retains resourceVersion and CAS-replaces a completed foreign-kind
  // journal, never deletes it or turns an expired unfinished operation into null.
  return null;
}
