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
import type {
  LLMProfileHealthContributorRun,
  LLMProfileHealthRecordingAvailability,
  LLMProfileHealthRecordingOutcome,
} from '../../../studio-server-shared/llmProfileHealthTypes.js';

export type StoredLLMProfileFailureEvidence = {
  id: string;
  occurredAt: number;
  correlationId?: string;
  recordingId?: string;
  recordingAvailability: LLMProfileHealthRecordingAvailability;
};

export type StoredLLMProfileActiveSuspension = {
  id: string;
  contributorEventIds: string[];
  triggerEventId: string;
};

export type StoredLLMProfileHealthEntry = {
  identity: RivetLLMProfileHealthIdentity;
  failureTimestamps: number[];
  /**
   * Short-lived evidence for failures in the active circuit generation. These
   * references are deliberately metadata-only: the normal recording pipeline
   * continues to own the replay payload and its persistence lifecycle.
   */
  failureEvidence: StoredLLMProfileFailureEvidence[];
  /** Present only while this health entry is actively suspended. */
  activeSuspension?: StoredLLMProfileActiveSuspension;
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

function isRecordingAvailability(value: unknown): value is LLMProfileHealthRecordingAvailability {
  return value === 'available'
    || value === 'pending'
    || value === 'disabled'
    || value === 'queue-dropped'
    || value === 'persistence-failed'
    || value === 'deleted'
    || value === 'not-recorded';
}

function normalizeFailureEvidence(value: unknown): StoredLLMProfileFailureEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): StoredLLMProfileFailureEvidence[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const item = candidate as Partial<StoredLLMProfileFailureEvidence>;
    const occurredAt = Number(item.occurredAt);
    if (typeof item.id !== 'string' || item.id === '' || !Number.isFinite(occurredAt)) return [];
    return [{
      id: item.id,
      occurredAt,
      ...(typeof item.correlationId === 'string' && item.correlationId !== ''
        ? { correlationId: item.correlationId }
        : {}),
      ...(typeof item.recordingId === 'string' && item.recordingId !== ''
        ? { recordingId: item.recordingId }
        : {}),
      recordingAvailability: isRecordingAvailability(item.recordingAvailability)
        ? item.recordingAvailability
        : typeof item.correlationId === 'string' && item.correlationId !== ''
          ? 'pending'
          : 'not-recorded',
    }];
  });
}

function normalizeActiveSuspension(
  value: unknown,
  evidence: readonly StoredLLMProfileFailureEvidence[],
): StoredLLMProfileActiveSuspension | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<StoredLLMProfileActiveSuspension>;
  if (typeof candidate.id !== 'string' || candidate.id === '' || typeof candidate.triggerEventId !== 'string') {
    return undefined;
  }
  const knownIds = new Set(evidence.map((item) => item.id));
  const contributorEventIds = Array.isArray(candidate.contributorEventIds)
    ? candidate.contributorEventIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id))
    : [];
  if (!knownIds.has(candidate.triggerEventId) || !contributorEventIds.includes(candidate.triggerEventId)) {
    return undefined;
  }
  return { id: candidate.id, contributorEventIds, triggerEventId: candidate.triggerEventId };
}

/** Normalizes legacy JSON rows without rewriting history until they transition. */
export function normalizeStoredLLMProfileHealthEntry(
  entry: StoredLLMProfileHealthEntry,
): StoredLLMProfileHealthEntry {
  const { activeSuspension: storedActiveSuspension, ...persisted } = entry;
  const failureEvidence = normalizeFailureEvidence(entry.failureEvidence);
  const activeSuspension = normalizeActiveSuspension(storedActiveSuspension, failureEvidence);
  return {
    ...persisted,
    failureTimestamps: Array.isArray(entry.failureTimestamps) ? entry.failureTimestamps : [],
    failureEvidence,
    ...(activeSuspension == null ? {} : { activeSuspension }),
    closedPermits: { ...(entry.closedPermits ?? {}) },
  };
}

function pruneFailures(
  entry: StoredLLMProfileHealthEntry,
  policy: RivetLLMProfileCircuitBreakerPolicy,
  now: number,
): void {
  const windowStart = now - policy.failureWindowMs;
  entry.failureTimestamps = entry.failureTimestamps
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= windowStart);
  const activeEvidenceIds = new Set(entry.activeSuspension?.contributorEventIds ?? []);
  entry.failureEvidence = entry.failureEvidence.filter((evidence) =>
    activeEvidenceIds.has(evidence.id) || evidence.occurredAt >= windowStart,
  );
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
      `LLM profile reliability key ${identity.key} belongs to a different project scope.`,
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

/** Presents active-suspension evidence without exposing correlation IDs to the browser. */
export function getLLMProfileHealthContributorRuns(
  entry: StoredLLMProfileHealthEntry,
): readonly LLMProfileHealthContributorRun[] {
  const suspension = entry.activeSuspension;
  if (suspension == null) return [];
  const contributors = new Set(suspension.contributorEventIds);
  const groups = new Map<string, {
    occurredAt: number;
    contributionCount: number;
    triggeredSuspension: boolean;
    availability: LLMProfileHealthRecordingAvailability;
    recordingId?: string;
  }>();
  for (const evidence of entry.failureEvidence) {
    if (!contributors.has(evidence.id)) continue;
    const groupKey = evidence.recordingId == null ? evidence.id : `recording:${evidence.recordingId}`;
    const existing = groups.get(groupKey);
    if (existing == null) {
      groups.set(groupKey, {
        occurredAt: evidence.occurredAt,
        contributionCount: 1,
        triggeredSuspension: evidence.id === suspension.triggerEventId,
        availability: evidence.recordingAvailability,
        ...(evidence.recordingId == null ? {} : { recordingId: evidence.recordingId }),
      });
    } else {
      existing.occurredAt = Math.min(existing.occurredAt, evidence.occurredAt);
      existing.contributionCount += 1;
      existing.triggeredSuspension ||= evidence.id === suspension.triggerEventId;
      if (existing.availability !== 'available' && evidence.recordingAvailability === 'available') {
        existing.availability = 'available';
        existing.recordingId = evidence.recordingId;
      }
    }
  }
  return [...groups.values()].sort((left, right) => left.occurredAt - right.occurredAt);
}

/** Recording IDs held only while their suspension episode remains active. */
export function getLLMProfileHealthHeldRecordingIds(
  entry: StoredLLMProfileHealthEntry,
): readonly string[] {
  return getLLMProfileHealthContributorRuns(entry)
    .filter((run) => run.availability === 'available' && run.recordingId != null)
    .map((run) => run.recordingId!);
}
function copyEntry(
  existing: StoredLLMProfileHealthEntry,
  identity: RivetLLMProfileHealthIdentity,
  policy: RivetLLMProfileCircuitBreakerPolicy,
): StoredLLMProfileHealthEntry {
  const normalized = normalizeStoredLLMProfileHealthEntry(existing);
  return {
    ...normalized,
    identity,
    policy,
    failureTimestamps: [...normalized.failureTimestamps],
    failureEvidence: normalized.failureEvidence.map((evidence) => ({ ...evidence })),
    ...(normalized.activeSuspension == null
      ? {}
      : {
        activeSuspension: {
          ...normalized.activeSuspension,
          contributorEventIds: [...normalized.activeSuspension.contributorEventIds],
        },
      }),
    closedPermits: { ...(normalized.closedPermits ?? {}) },
  };
}

function createFailureEvidence(
  request: RivetLLMProfileHealthFinishRequest,
  now: number,
): StoredLLMProfileFailureEvidence {
  const correlationId = request.executionCorrelationId;
  return {
    id: randomUUID(),
    occurredAt: now,
    ...(correlationId == null || correlationId === '' ? {} : { correlationId }),
    recordingAvailability: correlationId == null || correlationId === '' ? 'not-recorded' : 'pending',
  };
}

function openOrExtendActiveSuspension(
  entry: StoredLLMProfileHealthEntry,
  triggeringEvidenceId: string,
  now: number,
): void {
  const windowStart = now - entry.policy.failureWindowMs;
  const currentWindowEvidence = entry.failureEvidence
    .filter((evidence) => evidence.occurredAt >= windowStart)
    .map((evidence) => evidence.id);
  if (entry.activeSuspension == null) {
    entry.activeSuspension = {
      id: randomUUID(),
      contributorEventIds: currentWindowEvidence,
      triggerEventId: triggeringEvidenceId,
    };
    return;
  }
  const contributors = new Set(entry.activeSuspension.contributorEventIds);
  for (const evidenceId of currentWindowEvidence) contributors.add(evidenceId);
  entry.activeSuspension.contributorEventIds = [...contributors];
}

export function applyLLMProfileHealthRecordingOutcome(
  entry: StoredLLMProfileHealthEntry,
  outcome: LLMProfileHealthRecordingOutcome,
  now: number,
): boolean {
  let changed = false;
  for (const evidence of entry.failureEvidence) {
    if (evidence.correlationId !== outcome.correlationId || evidence.recordingAvailability !== 'pending') {
      continue;
    }
    evidence.recordingAvailability = outcome.availability;
    if (outcome.availability === 'available' && outcome.recordingId != null) {
      evidence.recordingId = outcome.recordingId;
    } else {
      delete evidence.recordingId;
    }
    changed = true;
  }
  if (changed) entry.updatedAt = now;
  return changed;
}

export function markLLMProfileHealthRecordingDeleted(
  entry: StoredLLMProfileHealthEntry,
  recordingId: string,
  now: number,
): boolean {
  let changed = false;
  for (const evidence of entry.failureEvidence) {
    if (evidence.recordingId !== recordingId || evidence.recordingAvailability === 'deleted') continue;
    evidence.recordingAvailability = 'deleted';
    delete evidence.recordingId;
    changed = true;
  }
  if (changed) entry.updatedAt = now;
  return changed;
}

export function beginLLMProfileHealthAttempt(
  existing: StoredLLMProfileHealthEntry | null,
  request: RivetLLMProfileHealthBeginRequest,
  now: number,
): { entry: StoredLLMProfileHealthEntry; result: RivetLLMProfileHealthBeginResult } {
  const { identity, policy } = request;
  if (existing != null) requireMatchingProjectScope(existing, identity);
  const entry: StoredLLMProfileHealthEntry = existing == null
    ? {
      identity,
      failureTimestamps: [],
      failureEvidence: [],
      closedPermits: {},
      updatedAt: now,
      policy,
    }
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
    entry.failureEvidence = [];
    entry.activeSuspension = undefined;
    entry.openUntil = undefined;
    entry.halfOpenPermitId = undefined;
    entry.halfOpenLeaseUntil = undefined;
    // Closed requests admitted before the circuit opened belong to the old
    // health generation. Their late results must not poison a recovered route.
    entry.closedPermits = {};
  } else if (outcome === 'unhealthy') {
    const wasOpen = entry.openUntil != null;
    const evidence = createFailureEvidence(request, now);
    entry.failureTimestamps.push(now);
    entry.failureEvidence.push(evidence);
    pruneFailures(entry, policy, now);
    const opened = ownsHalfOpenLease || (!wasOpen && entry.failureTimestamps.length >= policy.failureThreshold);
    if (opened) {
      entry.openUntil = now + policy.openDurationMs;
      openOrExtendActiveSuspension(entry, evidence.id, now);
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
