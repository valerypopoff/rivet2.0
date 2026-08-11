import { nanoid } from 'nanoid/non-secure';
import CryptoJS from 'crypto-js';
import stableStringify from 'safe-stable-stringify';
import type { NodeId } from '../NodeBase.js';
import type { ProjectId } from '../Project.js';
import type { ChatV2CredentialResult } from './chatV2ProviderProfile.js';
import type { LLMChatV2ProfileData } from './llmChatV2NodeData.js';
import type { ChatV2Provider } from './chatV2ProviderTypes.js';
import type { CustomProviderApi } from './customProviderApi.js';

export const DEFAULT_LLM_PROFILE_FIRST_OUTPUT_TIMEOUT_MS = 30_000;
export const DEFAULT_LLM_PROFILE_STREAM_INACTIVITY_TIMEOUT_MS = 30_000;
export const DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_WINDOW_MS = 300_000;
export const DEFAULT_LLM_PROFILE_CIRCUIT_OPEN_DURATION_MS = 300_000;
const LLM_PROFILE_HALF_OPEN_LEASE_SAFETY_MARGIN_MS = 5_000;
const LLM_PROFILE_CLOSED_PERMIT_MIN_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class RivetLLMProfileHealthPolicyError extends Error {
  constructor(message: string) {
    super(`LLM Profile health policy is invalid: ${message}`);
    this.name = 'RivetLLMProfileHealthPolicyError';
  }
}

export type RivetLLMProfileCircuitBreakerPolicy = {
  failureThreshold: number;
  failureWindowMs: number;
  openDurationMs: number;
  halfOpenLeaseMs: number;
};

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RivetLLMProfileHealthPolicyError(`${label} must be a positive integer.`);
  }
  return value;
}

export function resolveRivetLLMProfileCircuitBreakerPolicy(
  configuration: LLMChatV2ProfileData,
): RivetLLMProfileCircuitBreakerPolicy | undefined {
  if (configuration.enableCircuitBreaker !== true) {
    return undefined;
  }

  const firstOutputTimeoutMs = requirePositiveInteger(
    configuration.firstOutputTimeoutMs ?? DEFAULT_LLM_PROFILE_FIRST_OUTPUT_TIMEOUT_MS,
    'First useful output timeout',
  );
  const streamInactivityTimeoutMs = requirePositiveInteger(
    configuration.streamInactivityTimeoutMs ?? DEFAULT_LLM_PROFILE_STREAM_INACTIVITY_TIMEOUT_MS,
    'Stream inactivity timeout',
  );
  const failureThreshold = requirePositiveInteger(
    configuration.circuitBreakerFailureThreshold ?? DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_THRESHOLD,
    'Failure threshold',
  );
  const failureWindowMs = requirePositiveInteger(
    configuration.circuitBreakerFailureWindowMs ?? DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_WINDOW_MS,
    'Failure window',
  );
  const openDurationMs = requirePositiveInteger(
    configuration.circuitBreakerOpenDurationMs ?? DEFAULT_LLM_PROFILE_CIRCUIT_OPEN_DURATION_MS,
    'Open duration',
  );

  return {
    failureThreshold,
    failureWindowMs,
    openDurationMs,
    // A live streaming probe renews this lease on useful output. The bounded
    // safety margin lets a dead owner recover promptly without coupling the
    // probe lease to the (usually much longer) circuit cooldown.
    halfOpenLeaseMs:
      Math.max(firstOutputTimeoutMs, streamInactivityTimeoutMs) + LLM_PROFILE_HALF_OPEN_LEASE_SAFETY_MARGIN_MS,
  };
}

/**
 * Stable, privacy-bounded identity for one resolved LLM Profile configuration.
 * `key` and `configurationFingerprint` are SHA-256 routing/auth digests;
 * credentials and provider configuration are never exposed through this
 * contract.
 */
export type RivetLLMProfileHealthIdentity = {
  key: string;
  projectId?: ProjectId;
  profileNodeId?: NodeId;
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
  configurationFingerprint: string;
};

function sha256(value: string): string {
  return `sha256:${CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex)}`;
}

export function createRivetLLMProfileHealthIdentity(params: {
  configuration: LLMChatV2ProfileData;
  credential: ChatV2CredentialResult;
  /** Project-wide Chat headers merged into every physical provider request. */
  chatNodeHeaders?: Record<string, string> | undefined;
  projectId?: ProjectId;
  profileNodeId?: NodeId;
}): RivetLLMProfileHealthIdentity {
  // Circuit health belongs to the physical provider route and credentials,
  // not to generation policy. A temperature/cooldown edit must not silently
  // create a fresh circuit, while changing the model, endpoint, auth, or
  // routing headers must never inherit another route's outage history.
  const routingConfiguration = {
    provider: params.configuration.provider,
    model: params.configuration.model,
    ...(params.configuration.provider !== 'custom'
      ? {}
      : {
          customProviderApi: params.configuration.customProviderApi ?? 'completions',
          customProviderBaseURL: params.configuration.customProviderBaseURL,
        }),
    headers: canonicalizeEffectiveRoutingHeaders(params.chatNodeHeaders, params.configuration.headers),
  };
  const serialized =
    stableStringify({
      routingConfiguration,
      credential: params.credential,
    }) ?? '';
  const configurationFingerprint = sha256(serialized);
  const projectId = params.projectId == null ? undefined : String(params.projectId);
  const profileNodeId = params.profileNodeId == null ? undefined : String(params.profileNodeId);
  const key = sha256(
    stableStringify({
      kind: 'rivet-llm-profile-health',
      projectId,
      profileNodeId,
      configurationFingerprint,
    }) ?? '',
  );

  return {
    key: `llm-profile:${key}`,
    ...(params.projectId == null ? {} : { projectId: params.projectId }),
    ...(params.profileNodeId == null ? {} : { profileNodeId: params.profileNodeId }),
    provider: params.configuration.provider,
    model: params.configuration.model,
    ...(params.configuration.provider !== 'custom'
      ? {}
      : { customProviderApi: params.configuration.customProviderApi ?? 'completions' }),
    configurationFingerprint,
  };
}

function canonicalizeEffectiveRoutingHeaders(
  chatNodeHeaders: Record<string, string> | undefined,
  profileHeaders: LLMChatV2ProfileData['headers'],
): Array<[string, string]> {
  // Provider resolution spreads project-wide headers first and profile
  // headers second. Normalize names here because HTTP field names are
  // case-insensitive, while preserving that same profile-wins precedence.
  // Values remain confined to the SHA-256 input and never enter the public
  // identity or store key in plaintext.
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(chatNodeHeaders ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey) headers.set(normalizedKey, value);
  }
  for (const { key, value } of profileHeaders) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey) headers.set(normalizedKey, value);
  }
  return [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export type RivetLLMProfileHealthState = 'closed' | 'open' | 'half-open';

export type RivetLLMProfileHealthSnapshot = {
  identity: RivetLLMProfileHealthIdentity;
  state: RivetLLMProfileHealthState;
  failureCount: number;
  openUntil?: number;
  halfOpenLeaseUntil?: number;
  updatedAt: number;
};

export type RivetLLMProfileHealthBeginRequest = {
  identity: RivetLLMProfileHealthIdentity;
  policy: RivetLLMProfileCircuitBreakerPolicy;
};

export type RivetLLMProfileHealthBeginResult = {
  disposition: 'allow' | 'deny';
  state: RivetLLMProfileHealthState;
  /** Opaque permit returned to `finish`; present only when execution is allowed. */
  permitId?: string;
  retryAt?: number;
  snapshot: RivetLLMProfileHealthSnapshot;
};

export type RivetLLMProfileHealthOutcome = 'healthy' | 'unhealthy' | 'ignored';

export type RivetLLMProfileHealthFinishRequest = {
  identity: RivetLLMProfileHealthIdentity;
  policy: RivetLLMProfileCircuitBreakerPolicy;
  permitId: string;
  outcome: RivetLLMProfileHealthOutcome;
};

export type RivetLLMProfileHealthRenewRequest = {
  identity: RivetLLMProfileHealthIdentity;
  permitId: string;
  leaseDurationMs: number;
};

export type RivetLLMProfileHealthResetRequest =
  | { key: string; projectId?: never }
  | { key?: never; projectId: ProjectId };

export type RivetLLMProfileHealthListRequest = {
  projectId?: ProjectId;
};

/**
 * Host persistence seam for LLM Profile health. Implementations must make
 * each method atomic. In particular, `begin` must allow at most one probe
 * while an open circuit is half-open across all processes using the store.
 */
export interface RivetLLMProfileHealthStore {
  begin(
    request: RivetLLMProfileHealthBeginRequest,
  ): RivetLLMProfileHealthBeginResult | Promise<RivetLLMProfileHealthBeginResult>;
  finish(
    request: RivetLLMProfileHealthFinishRequest,
  ): RivetLLMProfileHealthSnapshot | Promise<RivetLLMProfileHealthSnapshot>;
  renew(
    request: RivetLLMProfileHealthRenewRequest,
  ): RivetLLMProfileHealthSnapshot | Promise<RivetLLMProfileHealthSnapshot>;
  reset(request: RivetLLMProfileHealthResetRequest): void | Promise<void>;
  list(
    request?: RivetLLMProfileHealthListRequest,
  ): RivetLLMProfileHealthSnapshot[] | Promise<RivetLLMProfileHealthSnapshot[]>;
}

type MutableHealthEntry = {
  identity: RivetLLMProfileHealthIdentity;
  failureTimestamps: number[];
  openUntil?: number;
  halfOpenPermitId?: string;
  halfOpenLeaseUntil?: number;
  updatedAt: number;
  policy: RivetLLMProfileCircuitBreakerPolicy;
  closedPermits: Map<string, number>;
};

function requireMatchingProjectScope(
  existing: MutableHealthEntry,
  identity: RivetLLMProfileHealthIdentity,
): void {
  const storedProjectId =
    existing.identity.projectId == null ? undefined : String(existing.identity.projectId);
  const requestProjectId = identity.projectId == null ? undefined : String(identity.projectId);
  if (storedProjectId !== requestProjectId) {
    throw new Error(`LLM Profile health key ${identity.key} belongs to a different project scope.`);
  }
}

function closedPermitRetentionMs(policy: RivetLLMProfileCircuitBreakerPolicy): number {
  return Math.max(
    LLM_PROFILE_CLOSED_PERMIT_MIN_RETENTION_MS,
    policy.failureWindowMs,
    policy.openDurationMs,
    policy.halfOpenLeaseMs,
  );
}

function pruneClosedPermits(entry: MutableHealthEntry, now: number): void {
  for (const [permitId, expiresAt] of entry.closedPermits) {
    if (expiresAt <= now) entry.closedPermits.delete(permitId);
  }
}

function pruneFailures(entry: MutableHealthEntry, policy: RivetLLMProfileCircuitBreakerPolicy, now: number): void {
  const windowStart = now - policy.failureWindowMs;
  entry.failureTimestamps = entry.failureTimestamps.filter((timestamp) => timestamp >= windowStart);
}

function getState(entry: MutableHealthEntry, now: number): RivetLLMProfileHealthState {
  if (entry.openUntil == null) return 'closed';
  if (entry.openUntil > now) return 'open';
  return 'half-open';
}

function toSnapshot(
  entry: MutableHealthEntry,
  policy: RivetLLMProfileCircuitBreakerPolicy,
  now: number,
): RivetLLMProfileHealthSnapshot {
  pruneFailures(entry, policy, now);
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

/** Process-local reference implementation used when a host does not supply durable shared storage. */
export class InMemoryRivetLLMProfileHealthStore implements RivetLLMProfileHealthStore {
  readonly #entries = new Map<string, MutableHealthEntry>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #pruneStaleEntries(now: number): void {
    for (const [key, entry] of this.#entries) {
      pruneFailures(entry, entry.policy, now);
      pruneClosedPermits(entry, now);
      const isEmptyClosedEntry =
        entry.failureTimestamps.length === 0 &&
        entry.openUntil == null &&
        entry.halfOpenPermitId == null &&
        entry.closedPermits.size === 0;
      if (isEmptyClosedEntry && entry.updatedAt + closedPermitRetentionMs(entry.policy) <= now) {
        this.#entries.delete(key);
      }
    }
  }

  begin(request: RivetLLMProfileHealthBeginRequest): RivetLLMProfileHealthBeginResult {
    const { identity, policy } = request;
    const now = this.#now();
    this.#pruneStaleEntries(now);
    let entry = this.#entries.get(identity.key);
    if (entry == null) {
      entry = { identity, failureTimestamps: [], updatedAt: now, policy, closedPermits: new Map() };
      this.#entries.set(identity.key, entry);
    } else {
      requireMatchingProjectScope(entry, identity);
      entry.identity = identity;
      entry.policy = policy;
    }
    pruneFailures(entry, policy, now);
    pruneClosedPermits(entry, now);

    if (entry.openUntil != null && entry.openUntil > now) {
      return {
        disposition: 'deny',
        state: 'open',
        retryAt: entry.openUntil,
        snapshot: toSnapshot(entry, policy, now),
      };
    }

    if (entry.openUntil != null) {
      if (entry.halfOpenPermitId != null && (entry.halfOpenLeaseUntil ?? 0) > now) {
        return {
          disposition: 'deny',
          state: 'half-open',
          retryAt: entry.halfOpenLeaseUntil,
          snapshot: toSnapshot(entry, policy, now),
        };
      }

      const permitId = nanoid();
      entry.halfOpenPermitId = permitId;
      entry.halfOpenLeaseUntil = now + policy.halfOpenLeaseMs;
      entry.updatedAt = now;
      return {
        disposition: 'allow',
        state: 'half-open',
        permitId,
        snapshot: toSnapshot(entry, policy, now),
      };
    }

    const permitId = nanoid();
    entry.closedPermits.set(permitId, now + closedPermitRetentionMs(policy));
    entry.updatedAt = now;
    return {
      disposition: 'allow',
      state: 'closed',
      permitId,
      snapshot: toSnapshot(entry, policy, now),
    };
  }

  finish(request: RivetLLMProfileHealthFinishRequest): RivetLLMProfileHealthSnapshot {
    const { identity, policy, permitId, outcome } = request;
    const now = this.#now();
    this.#pruneStaleEntries(now);
    const entry = this.#entries.get(identity.key);
    if (entry == null) {
      return {
        identity,
        state: 'closed',
        failureCount: 0,
        updatedAt: now,
      };
    }
    requireMatchingProjectScope(entry, identity);
    entry.identity = identity;
    entry.policy = policy;
    pruneFailures(entry, policy, now);
    pruneClosedPermits(entry, now);

    const ownsHalfOpenLease = entry.halfOpenPermitId === permitId;
    const ownsClosedPermit = entry.closedPermits.delete(permitId);
    if (!ownsHalfOpenLease && !ownsClosedPermit) {
      return toSnapshot(entry, policy, now);
    }

    if (outcome === 'healthy' && ownsHalfOpenLease) {
      entry.failureTimestamps = [];
      entry.openUntil = undefined;
      entry.halfOpenPermitId = undefined;
      entry.halfOpenLeaseUntil = undefined;
      // Requests admitted before the circuit opened belong to the previous
      // health generation. Once the single recovery probe succeeds, their
      // eventual results must not immediately poison the recovered circuit.
      entry.closedPermits.clear();
    } else if (outcome === 'unhealthy') {
      const wasOpen = entry.openUntil != null;
      entry.failureTimestamps.push(now);
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
    return toSnapshot(entry, policy, now);
  }

  renew(request: RivetLLMProfileHealthRenewRequest): RivetLLMProfileHealthSnapshot {
    const now = this.#now();
    this.#pruneStaleEntries(now);
    const entry = this.#entries.get(request.identity.key);
    if (entry == null) {
      return {
        identity: request.identity,
        state: 'closed',
        failureCount: 0,
        updatedAt: now,
      };
    }

    requireMatchingProjectScope(entry, request.identity);

    if (entry.halfOpenPermitId === request.permitId) {
      entry.halfOpenLeaseUntil = Math.max(entry.halfOpenLeaseUntil ?? 0, now + request.leaseDurationMs);
      entry.updatedAt = now;
    } else if (entry.closedPermits.has(request.permitId)) {
      entry.closedPermits.set(
        request.permitId,
        Math.max(entry.closedPermits.get(request.permitId) ?? 0, now + closedPermitRetentionMs(entry.policy)),
      );
      entry.updatedAt = now;
    }
    return toSnapshot(entry, entry.policy, now);
  }

  reset(request: RivetLLMProfileHealthResetRequest): void {
    if (request.key != null) {
      this.#entries.delete(request.key);
      return;
    }

    for (const [key, entry] of this.#entries) {
      if (entry.identity.projectId === request.projectId) {
        this.#entries.delete(key);
      }
    }
  }

  list(request: RivetLLMProfileHealthListRequest = {}): RivetLLMProfileHealthSnapshot[] {
    const now = this.#now();
    this.#pruneStaleEntries(now);
    return [...this.#entries.entries()]
      .filter(([, entry]) => request.projectId == null || entry.identity.projectId === request.projectId)
      .map(([, entry]) => {
        pruneFailures(entry, entry.policy, now);
        pruneClosedPermits(entry, now);
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
      });
  }
}

const defaultProcessLocalLLMProfileHealthStore = new InMemoryRivetLLMProfileHealthStore();

export function getDefaultRivetLLMProfileHealthStore(): RivetLLMProfileHealthStore {
  return defaultProcessLocalLLMProfileHealthStore;
}
