import type { PortId } from '../NodeBase.js';
import { isChatV2ResponseValidationError, runChatV2PipelineExecution } from './chatV2Pipeline.js';
import {
  type ChatV2Provider,
  type ChatV2PipelineRoundOptions,
  type ChatV2PipelineResult,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';
import { getCustomProviderApiContract, type CustomProviderApi } from './customProviderApi.js';
import {
  getDefaultRivetLLMProfileHealthStore,
  type RivetLLMProfileCircuitBreakerPolicy,
  type RivetLLMProfileHealthIdentity,
  type RivetLLMProfileHealthOutcome,
  type RivetLLMProfileHealthState,
  type RivetLLMProfileHealthStore,
} from './llmProfileHealthStore.js';
import {
  getChatV2ProviderErrorStatusCode,
  isChatV2ProviderApiCallError,
  isChatV2ProviderFetchError,
} from './chatV2Errors.js';
import { isChatV2ProviderTimeoutError } from './chatV2Types.js';

const DEFAULT_LLM_PROFILE_HEALTH_OPERATION_TIMEOUT_MS = 2_000;

class LLMProfileHealthOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`LLM Profile health store ${operation} timed out after ${timeoutMs} ms.`);
    this.name = 'LLMProfileHealthOperationTimeoutError';
  }
}

/**
 * Health persistence is deliberately fail-open, including when a remote
 * implementation never settles. Invoke the operation before racing so a
 * synchronous local store can still release a permit during cancellation;
 * the attached handlers also consume any rejection that arrives after the
 * deadline or caller abort won the race.
 */
function runBoundedHealthOperation<T>(params: {
  operation: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Finish must release a permit even when the graph has just been cancelled. */
  runWhenAborted?: boolean;
  /** Best-effort cleanup for results that arrive after timeout or cancellation. */
  onLateResolve?: (value: T) => void | Promise<void>;
  run: () => T | Promise<T>;
}): Promise<T> {
  const operationSignal = params.runWhenAborted ? undefined : params.signal;
  if (operationSignal?.aborted) {
    return Promise.reject(
      operationSignal.reason instanceof Error
        ? operationSignal.reason
        : new Error('LLM Chat request was aborted.'),
    );
  }

  let result: T | Promise<T>;
  try {
    result = params.run();
  } catch (error) {
    return Promise.reject(error);
  }

  const operationPromise = Promise.resolve(result);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operationSignal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          operationSignal?.reason instanceof Error
            ? operationSignal.reason
            : new Error('LLM Chat request was aborted.'),
        ),
      );
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new LLMProfileHealthOperationTimeoutError(params.operation, params.timeoutMs)),
        ),
      params.timeoutMs,
    );

    if (operationSignal?.aborted) {
      onAbort();
    } else {
      operationSignal?.addEventListener('abort', onAbort, { once: true });
    }

    void operationPromise.then(
      (value) => {
        if (settled) {
          try {
            void Promise.resolve(params.onLateResolve?.(value)).catch(() => undefined);
          } catch {
            // A late cleanup is observational and cannot affect the caller.
          }
          return;
        }
        finish(() => resolve(value));
      },
      (error) => finish(() => reject(error)),
    );
  });
}

export type LLMAttempt = {
  roundIndex: number;
  /** Present when a From profile candidate produced this attempt. */
  profileIndex?: number;
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
  stage: 'configuration' | 'request' | 'response-validation' | 'health-gate' | 'health-update';
  outcome: 'success' | 'failure' | 'aborted' | 'skipped';
  attemptIndex?: number;
  status?: number;
  error?: string;
  profileHealthKey?: string;
  healthState?: RivetLLMProfileHealthState;
  healthDisposition?: 'allow' | 'deny' | 'fail-open';
  healthOutcome?: RivetLLMProfileHealthOutcome;
  retryAt?: number;
  timeoutKind?: 'first-output' | 'stream-inactivity';
};

export type LLMProfileFallbackHealth = {
  identity: RivetLLMProfileHealthIdentity;
  policy: RivetLLMProfileCircuitBreakerPolicy;
  firstOutputTimeoutMs: number;
  streamInactivityTimeoutMs: number;
};

export type LLMProfileFallbackCandidate = {
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
  health?: LLMProfileFallbackHealth;
};

function formatCandidateIdentity(candidate: {
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
}): string {
  const providerLabel =
    candidate.provider === 'custom'
      ? getCustomProviderApiContract(candidate.customProviderApi).label
      : candidate.provider;
  return `${providerLabel}/${candidate.model}`;
}

export type LLMProfileFallbackRunner = {
  run: (roundOptions: ChatV2PipelineRoundOptions) => Promise<ChatV2PipelineResult>;
  attempts: LLMAttempt[];
  summary: () => string;
  wasExhausted: () => boolean;
};

export class LLMProfileFallbackExhaustedError extends Error {
  constructor(public readonly attempts: readonly LLMAttempt[]) {
    super(buildExhaustedMessage(attempts));
    this.name = 'LLMProfileFallbackExhaustedError';
  }
}

export function getLLMAttemptErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Provider request failed with unreadable error metadata.';
  }
}

function buildExhaustedMessage(attempts: readonly LLMAttempt[]): string {
  const details = attempts
    .map((attempt) => {
      const stage =
        attempt.stage === 'request'
          ? `request${attempt.attemptIndex == null ? '' : ` attempt ${attempt.attemptIndex}`}`
          : attempt.stage === 'response-validation'
            ? 'response validation'
            : attempt.stage === 'health-gate'
              ? 'health gate'
              : attempt.stage === 'health-update'
                ? 'health update'
                : 'configuration';
      const status = attempt.status == null ? '' : ` (${attempt.status})`;
      const error = attempt.error ? `: ${attempt.error.replace(/\r\n|\r|\n/g, '\n  ')}` : '';
      return `Profile ${attempt.profileIndex} (${formatCandidateIdentity(attempt)}), round ${attempt.roundIndex}, ${stage} ${attempt.outcome}${status}${error}`;
    })
    .join('\n');
  return details
    ? `LLM Profile fallback chain exhausted.\n${details}`
    : 'LLM Profile fallback chain exhausted before a provider request could be made.';
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Produces the concise, developer-facing companion to the full attempt trace.
 * It deliberately includes candidates that were never reached, so a successful
 * primary profile does not make the configured fallback order invisible.
 */
export function buildLLMProfileFallbackSummary(
  candidates: readonly LLMProfileFallbackCandidate[],
  attempts: readonly LLMAttempt[],
): string {
  return candidates
    .map((candidate, profileIndex) => {
      const profileAttempts = attempts.filter((attempt) => attempt.profileIndex === profileIndex);
      const identity = `Profile ${profileIndex} (${formatCandidateIdentity(candidate)})`;

      if (profileAttempts.length === 0) {
        return `${identity}: not attempted.`;
      }

      const successfulRounds = [
        ...new Set(
          profileAttempts
            .filter(
              (attempt) =>
                attempt.stage === 'request' &&
                attempt.outcome === 'success' &&
                !profileAttempts.some(
                  (candidate) =>
                    candidate.stage === 'response-validation' && candidate.roundIndex === attempt.roundIndex,
                ),
            )
            .map((attempt) => attempt.roundIndex),
        ),
      ];
      const failedConfiguration = profileAttempts.some(
        (attempt) => attempt.stage === 'configuration' && attempt.outcome === 'failure',
      );
      const failedRequestAttempts = profileAttempts.filter(
        (attempt) => attempt.stage === 'request' && attempt.outcome === 'failure',
      );
      const hasSuccessfulRequest = profileAttempts.some(
        (attempt) => attempt.stage === 'request' && attempt.outcome === 'success',
      );
      const failedResponseValidations = profileAttempts.filter(
        (attempt) => attempt.stage === 'response-validation' && attempt.outcome === 'failure',
      );
      const latestHealthUpdate = profileAttempts
        .filter((attempt) => attempt.stage === 'health-update' && attempt.outcome === 'success')
        .at(-1);
      const clauses: string[] = [];
      const skippedHealthGates = profileAttempts.filter(
        (attempt) => attempt.stage === 'health-gate' && attempt.outcome === 'skipped',
      );
      const failedHealthOperations = profileAttempts.filter(
        (attempt) =>
          (attempt.stage === 'health-gate' || attempt.stage === 'health-update') &&
          attempt.outcome === 'failure',
      );

      if (successfulRounds.length > 0) {
        clauses.push(
          `succeeded in model ${pluralize(successfulRounds.length, 'round')} (${successfulRounds.join(', ')})`,
        );
      }
      if (failedConfiguration) {
        clauses.push('failed during configuration');
      }
      if (failedRequestAttempts.length > 0) {
        const lastFailedRequest = failedRequestAttempts.at(-1)!;
        const status = lastFailedRequest.status == null ? '' : `; last status ${lastFailedRequest.status}`;
        const timeout =
          lastFailedRequest.timeoutKind === 'first-output'
            ? '; last failure timed out waiting for first useful output'
            : lastFailedRequest.timeoutKind === 'stream-inactivity'
              ? '; last failure timed out on stream inactivity'
              : '';
        clauses.push(
          hasSuccessfulRequest
            ? `had ${pluralize(failedRequestAttempts.length, 'failed provider attempt')}${status}${timeout}`
            : `failed after ${pluralize(failedRequestAttempts.length, 'provider attempt')}${status}${timeout}`,
        );
      }
      if (failedResponseValidations.length > 0) {
        clauses.push(`failed response validation in ${pluralize(failedResponseValidations.length, 'model round')}`);
      }
      if (skippedHealthGates.length > 0) {
        const retryAt = skippedHealthGates.at(-1)?.retryAt;
        clauses.push(
          `skipped by its open circuit in ${pluralize(skippedHealthGates.length, 'model round')}${
            retryAt == null ? '' : `; next probe after ${new Date(retryAt).toISOString()}`
          }`,
        );
      }
      if (failedHealthOperations.length > 0) {
        clauses.push(`health store unavailable ${pluralize(failedHealthOperations.length, 'time')}; failed open`);
      }
      if (latestHealthUpdate?.healthState === 'open') {
        clauses.push('circuit is open');
      } else if (latestHealthUpdate?.healthState === 'half-open') {
        clauses.push('circuit remains half-open');
      }

      return `${identity}: ${clauses.join('; ')}.`;
    })
    .join('\n');
}

function clearPartialResponse(options: Pick<ChatV2PipelineRoundOptions, 'emitPartialOutputs' | 'context'>): void {
  if (!options.emitPartialOutputs) {
    return;
  }

  try {
    options.context.onPartialOutputs?.({
      ['response' as PortId]: {
        type: 'string',
        value: '',
      },
    });
  } catch {
    // A presentation callback must not prevent recovery through a fallback profile.
  }
}

function chainStreamActivity(
  first: (() => void) | undefined,
  second: (() => void) | undefined,
): (() => void) | undefined {
  if (first == null) return second;
  if (second == null) return first;
  return () => {
    first();
    second();
  };
}

const PROVIDER_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isKnownProviderNetworkError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PROVIDER_NETWORK_ERROR_CODES.has(code.toUpperCase());
}

function findProviderFailure(error: unknown, seen = new Set<unknown>()): unknown {
  if (error == null || seen.has(error)) return undefined;
  seen.add(error);
  if (
    isChatV2ProviderTimeoutError(error) ||
    isChatV2ProviderFetchError(error) ||
    isChatV2ProviderApiCallError(error) ||
    isKnownProviderNetworkError(error)
  ) {
    return error;
  }
  if (typeof error !== 'object') return undefined;
  return findProviderFailure((error as { cause?: unknown }).cause, seen);
}

/** Classifies only provider availability failures, never local/configuration errors. */
export function isUnhealthyLLMProfileProviderFailure(error: unknown): boolean {
  const providerFailure = findProviderFailure(error);
  if (providerFailure == null) return false;
  if (
    isChatV2ProviderTimeoutError(providerFailure) ||
    isChatV2ProviderFetchError(providerFailure) ||
    isKnownProviderNetworkError(providerFailure)
  ) {
    return true;
  }
  const status = getChatV2ProviderErrorStatusCode(providerFailure);
  return status === 408 || status === 429 || (status != null && status >= 500);
}

function createHealthPermit(params: {
  candidate: LLMProfileFallbackCandidate & { health: LLMProfileFallbackHealth };
  healthStore: RivetLLMProfileHealthStore;
  permitId: string;
  state: RivetLLMProfileHealthState;
  roundIndex: number;
  profileIndex: number;
  operationTimeoutMs: number;
  signal: AbortSignal;
  recordAttempt: (attempt: LLMAttempt) => void;
}): {
  permitId: string;
  state: RivetLLMProfileHealthState;
  renew: () => void;
  renewForRetry: (cooldownMs: number) => Promise<void>;
  finish: (outcome: RivetLLMProfileHealthOutcome) => Promise<void>;
} {
  const {
    candidate,
    healthStore,
    permitId,
    state,
    roundIndex,
    profileIndex,
    operationTimeoutMs,
    signal,
    recordAttempt,
  } = params;
  let finished = false;
  let renewalInFlight = false;
  let lastRenewalAt = 0;
  const renewalIntervalMs = Math.max(25, Math.floor(candidate.health.policy.halfOpenLeaseMs / 3));
  const baseAttempt = {
    roundIndex,
    profileIndex,
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
    profileHealthKey: candidate.health.identity.key,
  };
  const renewLease = async (leaseDurationMs: number) => {
    try {
      await runBoundedHealthOperation({
        operation: 'renew',
        timeoutMs: operationTimeoutMs,
        signal,
        run: () =>
          healthStore.renew({
            identity: candidate.health.identity,
            permitId,
            leaseDurationMs,
          }),
      });
    } catch (error) {
      recordAttempt({
        ...baseAttempt,
        stage: 'health-update',
        outcome: 'failure',
        healthDisposition: 'fail-open',
        error: getLLMAttemptErrorMessage(error),
      });
    }
  };

  // A half-open permit covers the complete logical candidate, including
  // asynchronous configuration resolution, retry cooldowns, and non-streaming
  // requests. Keep the lease alive independently of model output so no second
  // process can enter while the legitimate probe is still working. Expiry
  // remains the recovery mechanism if this owner dies.
  const heartbeat =
    state === 'half-open'
      ? setInterval(() => {
          if (finished || renewalInFlight) return;
          lastRenewalAt = Date.now();
          renewalInFlight = true;
          void renewLease(candidate.health.policy.halfOpenLeaseMs).finally(() => {
            renewalInFlight = false;
          });
        }, renewalIntervalMs)
      : undefined;
  (heartbeat as { unref?: () => void } | undefined)?.unref?.();

  return {
    permitId,
    state,
    renew: () => {
      if (state !== 'half-open' || finished || renewalInFlight) return;
      const now = Date.now();
      if (now - lastRenewalAt < renewalIntervalMs) return;
      lastRenewalAt = now;
      renewalInFlight = true;
      void renewLease(candidate.health.policy.halfOpenLeaseMs)
        .finally(() => {
          renewalInFlight = false;
        });
    },
    renewForRetry: (cooldownMs) =>
      state === 'half-open'
        ? renewLease(candidate.health.policy.halfOpenLeaseMs + Math.max(0, cooldownMs))
        : Promise.resolve(),
    finish: async (outcome) => {
      if (finished) return;
      finished = true;
      if (heartbeat != null) clearInterval(heartbeat);
      try {
        const snapshot = await runBoundedHealthOperation({
          operation: 'finish',
          timeoutMs: operationTimeoutMs,
          signal,
          runWhenAborted: true,
          run: () =>
            healthStore.finish({
              identity: candidate.health.identity,
              policy: candidate.health.policy,
              permitId,
              outcome,
            }),
        });
        recordAttempt({
          ...baseAttempt,
          stage: 'health-update',
          outcome: 'success',
          healthState: snapshot.state,
          healthOutcome: outcome,
        });
      } catch (error) {
        recordAttempt({
          ...baseAttempt,
          stage: 'health-update',
          outcome: 'failure',
          healthDisposition: 'fail-open',
          healthOutcome: outcome,
          error: getLLMAttemptErrorMessage(error),
        });
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  // Do not turn an abort that happens between candidates into a backup-model
  // request. Prefer the host's Error reason when it supplied one, while still
  // giving graph execution a normal Error for the browser's default reason.
  throw signal.reason instanceof Error ? signal.reason : new Error('LLM Chat request was aborted.');
}

/**
 * Creates one forward-only fallback chain for a whole LLM Chat invocation.
 * A model which succeeds in an earlier tool round stays active for subsequent
 * rounds; only a later failure advances farther through the configured chain.
 */
export function createLLMProfileFallbackRunner(params: {
  candidates: readonly LLMProfileFallbackCandidate[];
  resolveCandidate: (
    profileIndex: number,
    roundOptions: ChatV2PipelineRoundOptions,
  ) => Promise<RunChatV2PipelineOptions>;
  onAttempt?: ((attempt: LLMAttempt) => void) | undefined;
  healthStore?: RivetLLMProfileHealthStore | undefined;
  /** Internal test/host hardening seam; ordinary runs use the bounded default. */
  healthOperationTimeoutMs?: number | undefined;
}): LLMProfileFallbackRunner {
  const attempts: LLMAttempt[] = [];
  const recordAttempt = (attempt: LLMAttempt) => {
    attempts.push(attempt);
    try {
      params.onAttempt?.(attempt);
    } catch {
      // Diagnostics must not alter profile recovery.
    }
  };
  let activeProfileIndex = 0;
  let nextRoundIndex = 0;
  let exhausted = false;
  const healthOperationTimeoutMs = Math.max(
    1,
    params.healthOperationTimeoutMs ?? DEFAULT_LLM_PROFILE_HEALTH_OPERATION_TIMEOUT_MS,
  );

  return {
    attempts,
    summary: () => buildLLMProfileFallbackSummary(params.candidates, attempts),
    wasExhausted: () => exhausted,
    run: async (roundOptions) => {
      const roundIndex = nextRoundIndex;
      let lastError: unknown;

      for (let profileIndex = activeProfileIndex; profileIndex < params.candidates.length; profileIndex++) {
        throwIfAborted(roundOptions.context.signal);
        const candidate = params.candidates[profileIndex]!;
        const healthStore = candidate.health == null
          ? undefined
          : params.healthStore ?? getDefaultRivetLLMProfileHealthStore();
        let healthPermit:
          | {
              permitId: string;
              state: RivetLLMProfileHealthState;
              renew: () => void;
              renewForRetry: (cooldownMs: number) => Promise<void>;
              finish: (outcome: RivetLLMProfileHealthOutcome) => Promise<void>;
            }
          | undefined;

        if (candidate.health != null && healthStore != null) {
          const candidateHealth = candidate.health;
          try {
            const begin = await runBoundedHealthOperation({
              operation: 'begin',
              timeoutMs: healthOperationTimeoutMs,
              signal: roundOptions.context.signal,
              onLateResolve: async (lateBegin) => {
                if (lateBegin.disposition !== 'allow' || !lateBegin.permitId) return;
                await healthStore.finish({
                  identity: candidateHealth.identity,
                  policy: candidateHealth.policy,
                  permitId: lateBegin.permitId,
                  outcome: 'ignored',
                });
              },
              run: () =>
                healthStore.begin({
                  identity: candidateHealth.identity,
                  policy: candidateHealth.policy,
                }),
            });
            if (begin.disposition === 'deny') {
              recordAttempt({
                roundIndex,
                profileIndex,
                provider: candidate.provider,
                model: candidate.model,
                ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
                stage: 'health-gate',
                outcome: 'skipped',
                profileHealthKey: candidate.health.identity.key,
                healthState: begin.state,
                healthDisposition: 'deny',
                ...(begin.retryAt == null ? {} : { retryAt: begin.retryAt }),
              });
              clearPartialResponse(roundOptions);
              continue;
            }

            const permitId = begin.permitId;
            if (!permitId) {
              throw new Error('LLM Profile health store allowed a request without returning a permit.');
            }
            recordAttempt({
              roundIndex,
              profileIndex,
              provider: candidate.provider,
              model: candidate.model,
              ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
              stage: 'health-gate',
              outcome: 'success',
              profileHealthKey: candidate.health.identity.key,
              healthState: begin.state,
              healthDisposition: 'allow',
            });
            healthPermit = createHealthPermit({
              candidate: candidate as LLMProfileFallbackCandidate & { health: LLMProfileFallbackHealth },
              healthStore,
              permitId,
              state: begin.state,
              roundIndex,
              profileIndex,
              operationTimeoutMs: healthOperationTimeoutMs,
              signal: roundOptions.context.signal,
              recordAttempt,
            });
          } catch (error) {
            if (roundOptions.context.signal.aborted) {
              throwIfAborted(roundOptions.context.signal);
            }
            recordAttempt({
              roundIndex,
              profileIndex,
              provider: candidate.provider,
              model: candidate.model,
              ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
              stage: 'health-gate',
              outcome: 'failure',
              profileHealthKey: candidate.health.identity.key,
              healthDisposition: 'fail-open',
              error: getLLMAttemptErrorMessage(error),
            });
          }
        }

        if (roundOptions.context.signal.aborted) {
          await healthPermit?.finish('ignored');
          throwIfAborted(roundOptions.context.signal);
        }
        let candidateOptions: RunChatV2PipelineOptions;

        try {
          candidateOptions = await params.resolveCandidate(profileIndex, roundOptions);
        } catch (error) {
          if (roundOptions.context.signal.aborted) {
            await healthPermit?.finish('ignored');
            throw error;
          }

          lastError = error;
          recordAttempt({
            roundIndex,
            profileIndex,
            provider: candidate.provider,
            model: candidate.model,
            ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
            stage: 'configuration',
            outcome: 'failure',
            error: getLLMAttemptErrorMessage(error),
          });
          clearPartialResponse(roundOptions);
          await healthPermit?.finish('ignored');
          continue;
        }

        // Candidate resolution can be asynchronous (for example, plugin or
        // provider configuration). Do not start a physical request if the
        // graph was cancelled while that resolution was in flight.
        if (roundOptions.context.signal.aborted) {
          await healthPermit?.finish('ignored');
          throwIfAborted(roundOptions.context.signal);
        }

        // Candidate resolution can consume a meaningful part of a half-open
        // lease. Refresh it immediately before the first physical request in
        // addition to the lifecycle heartbeat so the request starts with a
        // complete deadline window.
        await healthPermit?.renewForRetry(0);

        const previousOnProviderAttempt = candidateOptions.onProviderAttempt;
        candidateOptions = {
          ...candidateOptions,
          profileIndex,
          roundIndex,
          ...(candidate.health == null
            ? {}
            : {
                profileHealthKey: candidate.health.identity.key,
                ...(healthPermit == null ? {} : { profileHealthState: healthPermit.state }),
              }),
          ...(candidate.health == null
            ? {}
            : {
                firstOutputTimeoutMs: candidate.health.firstOutputTimeoutMs,
                streamInactivityTimeoutMs: candidate.health.streamInactivityTimeoutMs,
                onStreamActivity: chainStreamActivity(candidateOptions.onStreamActivity, healthPermit?.renew),
                onBeforeProviderRetry: healthPermit?.renewForRetry,
              }),
          onProviderAttempt: (attempt) => {
            try {
              previousOnProviderAttempt?.(attempt);
            } catch {
              // A caller-owned observer must not prevent this runner from
              // retaining the profile-chain diagnostics it owns.
            }
            recordAttempt({
              roundIndex,
              profileIndex,
              provider: candidate.provider,
              model: candidate.model,
              ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
              stage: 'request',
              outcome:
                attempt.outcome === 'success' ? 'success' : attempt.outcome === 'aborted' ? 'aborted' : 'failure',
              attemptIndex: attempt.attemptIndex,
              ...(attempt.status == null ? {} : { status: attempt.status }),
              ...(attempt.error == null ? {} : { error: getLLMAttemptErrorMessage(attempt.error) }),
              ...(isChatV2ProviderTimeoutError(attempt.error)
                ? { timeoutKind: attempt.error.timeoutKind }
                : {}),
            });
          },
        };

        let execution;
        try {
          execution = await runChatV2PipelineExecution(candidateOptions);
        } catch (error) {
          if (roundOptions.context.signal.aborted) {
            await healthPermit?.finish('ignored');
            throw error;
          }

          // The candidate's provider/model is part of request construction.
          // Treat a failure there as an unsuccessful candidate too: it is
          // exactly what a fallback chain is intended to recover from. This
          // also lets a later profile whose provider supports the same shared
          // prompt/schema continue. If every candidate has the same graph
          // configuration problem, the aggregate error retains every failed
          // candidate diagnostic.
          lastError = error;
          const responseValidationFailure = isChatV2ResponseValidationError(error);
          recordAttempt({
            roundIndex,
            profileIndex,
            provider: candidate.provider,
            model: candidate.model,
            ...(candidate.customProviderApi == null ? {} : { customProviderApi: candidate.customProviderApi }),
            stage: responseValidationFailure ? 'response-validation' : 'configuration',
            outcome: 'failure',
            error: getLLMAttemptErrorMessage(error),
          });
          clearPartialResponse(roundOptions);
          await healthPermit?.finish('ignored');
          continue;
        }
        if (execution.outcome === 'success') {
          await healthPermit?.finish('healthy');
          activeProfileIndex = profileIndex;
          nextRoundIndex += 1;
          return execution.result;
        }

        lastError = execution.failure.normalizedError;
        await healthPermit?.finish(
          isUnhealthyLLMProfileProviderFailure(execution.failure.normalizedError) ? 'unhealthy' : 'ignored',
        );
        clearPartialResponse(roundOptions);
      }

      exhausted = true;
      // A scalar profile keeps its underlying provider/configuration error.
      if (params.candidates.length === 1 && lastError !== undefined) {
        throw lastError;
      }
      throw new LLMProfileFallbackExhaustedError(attempts);
    },
  };
}
