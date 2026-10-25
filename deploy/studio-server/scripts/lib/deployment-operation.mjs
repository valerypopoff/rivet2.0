import { isDeepStrictEqual } from 'node:util';

const leaseMs = 120_000;
const heartbeatMs = 30_000;
const message = (error) => (error instanceof Error ? error.message : String(error));

/** Keep both failures, without hiding an operation's recovery instructions. */
export function preserveDeploymentFailure(primary, secondary, description) {
  if (secondary === primary || secondary?.cause === primary || secondary?.errors?.includes(primary)) return secondary;
  return new AggregateError([primary, secondary], description ?? `${message(primary)}\n${message(secondary)}`);
}

/** Shared journal lifecycle; mode-specific validation and rollout policy stay
 * with the strategy. No journal schema changes or retries of uncertain writes.
 * `initial` is supplied only after fresh-operation admission; an existing
 * unfinished record must already have passed exact-token recovery validation. */
export async function runDeploymentOperation({
  name,
  record,
  initial,
  runner,
  resumeToken,
  safety,
  readJournal,
  saveJournal,
  now = Date.now,
  setHeartbeat = setInterval,
  clearHeartbeat = clearInterval,
  run,
  onFailure,
}) {
  if (record?.leaseExpiresAt > now()) throw Error(`Another ${name} runner still owns the operation.`);
  const recovering = Boolean(record && record.phase !== 'complete');
  if (recovering) {
    if (!resumeToken || record.token !== resumeToken)
      throw Error('Recover the exact unfinished deployment token before claiming ownership.');
    safety.assertRecovery(record);
  } else if (resumeToken) throw Error('No unfinished deployment matches the recovery token.');
  if (initial) {
    if (recovering) throw Error('An unfinished deployment cannot be replaced with fresh ownership.');
    const next = { ...initial, runner, leaseExpiresAt: now() + leaseMs };
    safety.assertRecovery(next);
    try {
      record = await saveJournal(next, record?.resourceVersion);
    } catch (cause) {
      throw Error(
        `${name} ownership write is unconfirmed; no workloads were changed. Inspect journal token ${next.token} before recovery.`,
        { cause },
      );
    }
  } else if (!recovering) throw Error('Exact unfinished deployment ownership is required.');

  let failure, pendingWrite, heartbeatFailure;
  let chain = Promise.resolve();
  let stopped = false;
  let timer;
  const assertLease = () => {
    if (failure) throw failure;
    if (record.runner !== runner || record.leaseExpiresAt <= now())
      throw Error(`${name} lease expired or ownership is unconfirmed; explicit recovery is required.`);
  };
  const checkpoint = (changes = {}, heartbeat = false) => {
    const queued = chain
      .then(async () => {
        if (failure) throw failure;
        // The first write may claim an explicitly validated expired predecessor.
        // This runner can never renew its own expired lease.
        if (record.runner === runner && record.leaseExpiresAt <= now())
          throw Error(`${name} lease expired; explicit recovery is required.`);
        const next = { ...record, ...changes, runner, leaseExpiresAt: now() + leaseMs };
        if (next.token !== record.token) throw Error('Deployment checkpoint cannot replace operation identity.');
        safety.assertRecovery(next);
        pendingWrite = { next, heartbeat };
        record = await saveJournal(next, record.resourceVersion);
        pendingWrite = undefined;
      })
      .catch((error) => {
        failure ??= error;
        if (heartbeat) heartbeatFailure ??= error;
        throw error;
      });
    // Keep one serialized queue, including failed acknowledgements. The rejection
    // is observed here as well as by the caller to avoid orphaned timer promises.
    chain = queued;
    void queued.catch(() => {});
    return queued;
  };
  const stopHeartbeat = async () => {
    if (!stopped) {
      stopped = true;
      if (timer !== undefined) clearHeartbeat(timer);
    }
    await chain.catch(() => {});
  };
  const operation = Object.freeze({
    get record() {
      return record;
    },
    get failure() {
      return failure;
    },
    assertLease,
    checkpoint,
    async step(phase, action) {
      await checkpoint({ phase });
      assertLease();
      return action();
    },
    async complete(changes = {}) {
      await stopHeartbeat();
      assertLease();
      await checkpoint({ ...changes, phase: 'complete' });
    },
    async reloadOwned() {
      // Cleanup must wait for all in-flight heartbeats. Failed heartbeats fence
      // cleanup too; a same-name journal is not permission to steal ownership.
      await stopHeartbeat();
      if (heartbeatFailure) throw heartbeatFailure;
      const current = await readJournal();
      if (!current || current.runner !== runner || current.token !== record.token || current.leaseExpiresAt <= now())
        throw Error(`${name} ownership is no longer confirmed; no further workload mutations are allowed.`);
      safety.assertRecovery(current);
      if (failure) {
        // The only failed journal write reconciled during this invocation is an
        // exact, committed completion acknowledgement. Never replay it or infer
        // success from an older phase after a failed CAS.
        const withoutVersion = ({ resourceVersion: _version, ...value }) => value;
        if (
          !pendingWrite ||
          pendingWrite.heartbeat ||
          pendingWrite.next.phase !== 'complete' ||
          !isDeepStrictEqual(withoutVersion(current), withoutVersion(pendingWrite.next))
        )
          throw failure;
        failure = undefined;
        pendingWrite = undefined;
        chain = Promise.resolve();
      }
      record = current;
      return current;
    },
  });
  const operationFailure = (cause) => {
    const error = cause instanceof Error && Object.isExtensible(cause) ? cause : Error(message(cause), { cause });
    Object.defineProperty(error, 'deploymentOperation', {
      configurable: true,
      value: Object.freeze({
        token: record.token,
        phase: record.phase,
        acknowledgement: failure ? 'unconfirmed' : 'confirmed',
        aborted:
          !failure &&
          record.phase === 'complete' &&
          Boolean(
            record.abortedBeforeTemplates || record.abortedBeforeQuiescence || record.abortedBeforeTopologyChanges,
          ),
      }),
    });
    return error;
  };
  try {
    await checkpoint();
    timer = setHeartbeat(() => {
      if (!stopped && !failure) void checkpoint({}, true).catch(() => {});
    }, heartbeatMs);
    timer?.unref?.();
    await run(operation);
    if (record.phase !== 'complete') throw Error(`${name} returned without a durable completion checkpoint.`);
    assertLease();
  } catch (error) {
    await stopHeartbeat();
    if (onFailure) {
      try {
        await onFailure(error, operation);
      } catch (cleanupError) {
        throw operationFailure(preserveDeploymentFailure(error, cleanupError));
      }
    }
    throw operationFailure(error);
  } finally {
    await stopHeartbeat();
    // Releasing is best effort, CAS-bound, and never changes the saved phase.
    // An unconfirmed write or expired lease remains for explicit recovery.
    if (!failure && record.runner === runner && record.leaseExpiresAt > now()) {
      try {
        record = await saveJournal({ ...record, leaseExpiresAt: now() }, record.resourceVersion);
      } catch {
        /* The durable lease remains authoritative; never retry blindly. */
      }
    }
  }
  return record;
}
