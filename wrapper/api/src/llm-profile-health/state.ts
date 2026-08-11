import { randomUUID } from 'node:crypto';

import type {
  RivetLLMProfileCircuitBreakerPolicy,
  RivetLLMProfileHealthBeginRequest,
  RivetLLMProfileHealthBeginResult,
  RivetLLMProfileHealthFinishRequest,
  RivetLLMProfileHealthIdentity,
  RivetLLMProfileHealthRenewRequest,
  RivetLLMProfileHealthSnapshot,
  RivetLLMProfileHealthState,
} from '@valerypopoff/rivet2-node';

export type StoredLLMProfileHealthEntry = {
  identity: RivetLLMProfileHealthIdentity;
  failureTimestamps: number[];
  openUntil?: number;
  halfOpenPermitId?: string;
  halfOpenLeaseUntil?: number;
  closedPermits: Record<string, number>;
  updatedAt: number;
  policy: RivetLLMProfileCircuitBreakerPolicy;
};

/**
 * Closed-state permits normally live for one provider candidate execution.
 * Keep a generous floor for slow/retrying requests, but eventually discard
 * permits abandoned by a crashed executor so durable rows stay bounded.
 */
export const LLM_PROFILE_CLOSED_PERMIT_RETENTION_FLOOR_MS = 24 * 60 * 60 * 1_000;

function closedPermitRetentionMs(policy: RivetLLMProfileCircuitBreakerPolicy): number {
  return Math.max(
    LLM_PROFILE_CLOSED_PERMIT_RETENTION_FLOOR_MS,
    policy.failureWindowMs,
    policy.openDurationMs,
    policy.halfOpenLeaseMs,
  );
}

function pruneFailures(
  entry: StoredLLMProfileHealthEntry,
  policy: RivetLLMProfileCircuitBreakerPolicy,
  now: number,
): void {
  const windowStart = now - policy.failureWindowMs;
  entry.failureTimestamps = entry.failureTimestamps
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= windowStart);
}

function pruneClosedPermits(
  entry: StoredLLMProfileHealthEntry,
  policy: RivetLLMProfileCircuitBreakerPolicy,
  now: number,
): void {
  entry.closedPermits = Object.fromEntries(
    Object.entries(entry.closedPermits ?? {}).filter(
      ([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > now,
    ),
  );
}

function requireMatchingProjectScope(
  existing: StoredLLMProfileHealthEntry,
  identity: RivetLLMProfileHealthIdentity,
): void {
  const storedProjectId = existing.identity.projectId == null
    ? undefined
    : String(existing.identity.projectId);
  const requestProjectId = identity.projectId == null ? undefined : String(identity.projectId);
  if (storedProjectId !== requestProjectId) {
    throw new Error(
      `LLM Profile health key ${identity.key} belongs to a different project scope.`,
    );
  }
}

function pruneEntry(
  entry: StoredLLMProfileHealthEntry,
  policy: RivetLLMProfileCircuitBreakerPolicy,
  now: number,
): void {
  pruneFailures(entry, policy, now);
  pruneClosedPermits(entry, policy, now);
}

function getState(entry: StoredLLMProfileHealthEntry, now: number): RivetLLMProfileHealthState {
  if (entry.openUntil == null) return 'closed';
  if (entry.openUntil > now) return 'open';
  return 'half-open';
}

export function createEmptyLLMProfileHealthSnapshot(
  identity: RivetLLMProfileHealthIdentity,
  now: number,
): RivetLLMProfileHealthSnapshot {
  return { identity, state: 'closed', failureCount: 0, updatedAt: now };
}

export function createLLMProfileHealthSnapshot(
  entry: StoredLLMProfileHealthEntry,
  now: number,
): RivetLLMProfileHealthSnapshot {
  pruneEntry(entry, entry.policy, now);
  const state = getState(entry, now);
  return {
    identity: entry.identity,
    state,
    failureCount: entry.failureTimestamps.length,
    ...(entry.openUntil == null ? {} : { openUntil: entry.openUntil }),
    ...(state !== 'half-open' || entry.halfOpenLeaseUntil == null
      ? {}
      : { halfOpenLeaseUntil: entry.halfOpenLeaseUntil }),
    updatedAt: entry.updatedAt,
  };
}

function copyEntry(
  existing: StoredLLMProfileHealthEntry,
  identity: RivetLLMProfileHealthIdentity,
  policy: RivetLLMProfileCircuitBreakerPolicy,
): StoredLLMProfileHealthEntry {
  return {
    ...existing,
    identity,
    policy,
    failureTimestamps: [...existing.failureTimestamps],
    closedPermits: { ...(existing.closedPermits ?? {}) },
  };
}

export function beginLLMProfileHealthAttempt(
  existing: StoredLLMProfileHealthEntry | null,
  request: RivetLLMProfileHealthBeginRequest,
  now: number,
): { entry: StoredLLMProfileHealthEntry; result: RivetLLMProfileHealthBeginResult } {
  const { identity, policy } = request;
  if (existing != null) requireMatchingProjectScope(existing, identity);
  const entry: StoredLLMProfileHealthEntry = existing == null
    ? { identity, failureTimestamps: [], closedPermits: {}, updatedAt: now, policy }
    : copyEntry(existing, identity, policy);
  pruneEntry(entry, policy, now);

  if (entry.openUntil != null && entry.openUntil > now) {
    return {
      entry,
      result: {
        disposition: 'deny', state: 'open', retryAt: entry.openUntil,
        snapshot: createLLMProfileHealthSnapshot(entry, now),
      },
    };
  }

  if (entry.openUntil != null) {
    if (entry.halfOpenPermitId != null && (entry.halfOpenLeaseUntil ?? 0) > now) {
      return {
        entry,
        result: {
          disposition: 'deny', state: 'half-open', retryAt: entry.halfOpenLeaseUntil,
          snapshot: createLLMProfileHealthSnapshot(entry, now),
        },
      };
    }

    const permitId = randomUUID();
    entry.halfOpenPermitId = permitId;
    entry.halfOpenLeaseUntil = now + policy.halfOpenLeaseMs;
    entry.updatedAt = now;
    return {
      entry,
      result: {
        disposition: 'allow', state: 'half-open', permitId,
        snapshot: createLLMProfileHealthSnapshot(entry, now),
      },
    };
  }

  const permitId = randomUUID();
  entry.closedPermits[permitId] = now + closedPermitRetentionMs(policy);
  entry.updatedAt = now;
  return {
    entry,
    result: {
      disposition: 'allow', state: 'closed', permitId,
      snapshot: createLLMProfileHealthSnapshot(entry, now),
    },
  };
}

export function finishLLMProfileHealthAttempt(
  existing: StoredLLMProfileHealthEntry | null,
  request: RivetLLMProfileHealthFinishRequest,
  now: number,
): { entry: StoredLLMProfileHealthEntry | null; snapshot: RivetLLMProfileHealthSnapshot } {
  const { identity, policy, permitId, outcome } = request;
  if (existing == null) {
    return { entry: null, snapshot: createEmptyLLMProfileHealthSnapshot(identity, now) };
  }
  requireMatchingProjectScope(existing, identity);

  const entry = copyEntry(existing, identity, policy);
  pruneEntry(entry, policy, now);

  const ownsHalfOpenLease = entry.halfOpenPermitId === permitId;
  const ownsClosedPermit = Object.prototype.hasOwnProperty.call(entry.closedPermits, permitId);
  if (!ownsHalfOpenLease && !ownsClosedPermit) {
    return { entry, snapshot: createLLMProfileHealthSnapshot(entry, now) };
  }
  if (ownsClosedPermit) delete entry.closedPermits[permitId];

  if (outcome === 'healthy' && ownsHalfOpenLease) {
    entry.failureTimestamps = [];
    entry.openUntil = undefined;
    entry.halfOpenPermitId = undefined;
    entry.halfOpenLeaseUntil = undefined;
    // Closed requests admitted before the circuit opened belong to the old
    // health generation. Their late results must not poison a recovered route.
    entry.closedPermits = {};
  } else if (outcome === 'unhealthy') {
    const wasOpen = entry.openUntil != null;
    entry.failureTimestamps.push(now);
    pruneFailures(entry, policy, now);
    if (ownsHalfOpenLease || (!wasOpen && entry.failureTimestamps.length >= policy.failureThreshold)) {
      entry.openUntil = now + policy.openDurationMs;
    }
    if (ownsHalfOpenLease) {
      entry.halfOpenPermitId = undefined;
      entry.halfOpenLeaseUntil = undefined;
    }
  } else if (outcome === 'ignored' && ownsHalfOpenLease) {
    entry.halfOpenPermitId = undefined;
    entry.halfOpenLeaseUntil = undefined;
  }

  entry.updatedAt = now;
  return { entry, snapshot: createLLMProfileHealthSnapshot(entry, now) };
}

export function renewLLMProfileHealthPermit(
  existing: StoredLLMProfileHealthEntry | null,
  request: RivetLLMProfileHealthRenewRequest,
  now: number,
): { entry: StoredLLMProfileHealthEntry | null; snapshot: RivetLLMProfileHealthSnapshot } {
  if (existing == null) {
    return { entry: null, snapshot: createEmptyLLMProfileHealthSnapshot(request.identity, now) };
  }
  requireMatchingProjectScope(existing, request.identity);

  const entry = copyEntry(existing, request.identity, existing.policy);
  pruneEntry(entry, entry.policy, now);
  if (entry.halfOpenPermitId === request.permitId) {
    entry.halfOpenLeaseUntil = Math.max(
      entry.halfOpenLeaseUntil ?? 0,
      now + request.leaseDurationMs,
    );
    entry.updatedAt = now;
  } else if (Object.prototype.hasOwnProperty.call(entry.closedPermits, request.permitId)) {
    entry.closedPermits[request.permitId] = Math.max(
      entry.closedPermits[request.permitId] ?? 0,
      now + closedPermitRetentionMs(entry.policy),
    );
    entry.updatedAt = now;
  }
  return { entry, snapshot: createLLMProfileHealthSnapshot(entry, now) };
}
