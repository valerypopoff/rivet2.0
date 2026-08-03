import type { PortId } from '../NodeBase.js';
import {
  isChatV2ResponseValidationError,
  materializeChatV2PipelineFailure,
  runChatV2PipelineExecution,
  type ChatV2PipelineProviderFailure,
} from './chatV2Pipeline.js';
import {
  shouldOutputChatV2RequestError,
  type ChatV2Provider,
  type ChatV2PipelineResult,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';

export type LLMProfileAttempt = {
  roundIndex: number;
  profileIndex: number;
  provider: ChatV2Provider;
  model: string;
  stage: 'configuration' | 'request' | 'response-validation';
  outcome: 'success' | 'failure';
  attemptIndex?: number;
  status?: number;
  error?: string;
};

export type LLMProfileFallbackCandidate = {
  provider: ChatV2Provider;
  model: string;
  credential?: string | undefined;
  /** Additional known request secrets, such as profile or global header values. */
  redactionValues?: readonly string[] | undefined;
};

/**
 * Request-level diagnostics grouped by the configured LLM Profile order.
 *
 * `LLMProfileAttempt` deliberately retains the full chronology and round
 * information. These compact arrays are the shape used by the familiar
 * Response Status and Response Error outputs when a profile *array* drives
 * LLM Chat: outer index is the input profile index; inner order is the
 * physical request order for that profile across the whole invocation.
 */
export type LLMProfileRequestDiagnostics = {
  statuses: Array<number | number[]>;
  errors: LLMProfileRequestErrorDiagnostics;
};

/**
 * Compact error diagnostics for an LLM Profile array.
 *
 * A single request failure is easier to inspect as a string, while retries
 * still need an array. When every candidate completed without a request error,
 * there is nothing useful to preserve per profile, so the value is simply an
 * empty array. The detailed LLM Profile Attempts output remains the canonical
 * per-profile/per-attempt record in every case.
 */
export type LLMProfileRequestErrorDiagnostics = string | string[] | Array<string | string[]>;

export type LLMProfileFallbackRunner = {
  run: (roundOptions: RunChatV2PipelineOptions) => Promise<ChatV2PipelineResult>;
  attempts: LLMProfileAttempt[];
  summary: () => string;
  wasExhausted: () => boolean;
};

export class LLMProfileFallbackExhaustedError extends Error {
  constructor(public readonly attempts: readonly LLMProfileAttempt[]) {
    super(buildExhaustedMessage(attempts));
    this.name = 'LLMProfileFallbackExhaustedError';
  }
}

function getSafeErrorMessage(error: unknown, candidate: LLMProfileFallbackCandidate): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = 'Provider request failed with unreadable error metadata.';
  }

  // Replace longer values first so one secret which contains another cannot
  // leave a meaningful suffix behind. Header values can be credentials too;
  // callers deliberately provide every known sensitive request value here.
  const redactionValues = [candidate.credential, ...(candidate.redactionValues ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(redactionValues)) {
    message = message.split(value).join('[redacted]');
  }

  return message.length > 1_000 ? `${message.slice(0, 997)}...` : message;
}

function buildExhaustedMessage(attempts: readonly LLMProfileAttempt[]): string {
  const details = attempts
    .map((attempt) => {
      const stage =
        attempt.stage === 'request'
          ? `request${attempt.attemptIndex == null ? '' : ` attempt ${attempt.attemptIndex}`}`
          : attempt.stage === 'response-validation'
            ? 'response validation'
            : 'configuration';
      const status = attempt.status == null ? '' : ` (${attempt.status})`;
      const error = attempt.error ? `: ${attempt.error.replace(/\r\n|\r|\n/g, '\n  ')}` : '';
      return `Profile ${attempt.profileIndex} (${attempt.provider}/${attempt.model}), round ${attempt.roundIndex}, ${stage} ${attempt.outcome}${status}${error}`;
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
  attempts: readonly LLMProfileAttempt[],
): string {
  return candidates
    .map((candidate, profileIndex) => {
      const profileAttempts = attempts.filter((attempt) => attempt.profileIndex === profileIndex);
      const identity = `Profile ${profileIndex} (${candidate.provider}/${candidate.model})`;

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
      const clauses: string[] = [];

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
        clauses.push(
          hasSuccessfulRequest
            ? `had ${pluralize(failedRequestAttempts.length, 'failed provider attempt')}${status}`
            : `failed after ${pluralize(failedRequestAttempts.length, 'provider attempt')}${status}`,
        );
      }
      if (failedResponseValidations.length > 0) {
        clauses.push(`failed response validation in ${pluralize(failedResponseValidations.length, 'model round')}`);
      }

      return `${identity}: ${clauses.join('; ')}.`;
    })
    .join('\n');
}

export function buildLLMProfileRequestDiagnostics(
  profileCount: number,
  attempts: readonly LLMProfileAttempt[],
): LLMProfileRequestDiagnostics {
  const statuses = Array.from({ length: profileCount }, () => [] as number[]);
  const errors = Array.from({ length: profileCount }, () => [] as string[]);

  for (const attempt of attempts) {
    if (attempt.stage !== 'request' || attempt.profileIndex < 0 || attempt.profileIndex >= profileCount) {
      continue;
    }

    if (attempt.status != null) {
      statuses[attempt.profileIndex]!.push(attempt.status);
    }
    if (attempt.error != null) {
      errors[attempt.profileIndex]!.push(attempt.error);
    }
  }

  return {
    statuses: compactLLMProfileRequestStatuses(statuses) as Array<number | number[]>,
    errors: compactLLMProfileRequestErrors(errors) as LLMProfileRequestErrorDiagnostics,
  };
}

/**
 * Preserves one profile slot per input profile while making a single physical
 * request easy to read. This also repairs cache entries made before the
 * scalar-single-status contract was introduced.
 */
export function compactLLMProfileRequestStatuses(statuses: readonly unknown[]): unknown[] {
  return statuses.map((profileStatuses) =>
    Array.isArray(profileStatuses) && profileStatuses.length === 1 ? profileStatuses[0] : profileStatuses,
  );
}

/**
 * Keeps Response Error readable for profile-array fallback chains and repairs
 * editor-cache entries written before that compact presentation contract.
 */
export function compactLLMProfileRequestErrors(errors: readonly unknown[]): unknown {
  if (errors.every((profileErrors) => Array.isArray(profileErrors) && profileErrors.length === 0)) {
    return [];
  }

  const compacted = errors.map((profileErrors) =>
    Array.isArray(profileErrors) && profileErrors.length === 1 ? profileErrors[0] : profileErrors,
  );

  return compacted.length === 1 ? compacted[0] ?? [] : compacted;
}

function clearPartialResponse(options: RunChatV2PipelineOptions): void {
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
  resolveCandidate: (profileIndex: number, roundOptions: RunChatV2PipelineOptions) => Promise<RunChatV2PipelineOptions>;
}): LLMProfileFallbackRunner {
  const attempts: LLMProfileAttempt[] = [];
  let activeProfileIndex = 0;
  let nextRoundIndex = 0;
  let exhausted = false;

  return {
    attempts,
    summary: () => buildLLMProfileFallbackSummary(params.candidates, attempts),
    wasExhausted: () => exhausted,
    run: async (roundOptions) => {
      const roundIndex = nextRoundIndex;
      // Only a provider failure from the terminal candidate may become normal
      // request-detail outputs. If a later candidate instead fails while being
      // configured, returning diagnostics from an earlier provider would lie
      // about which profile terminally failed.
      let terminalProviderFailure: ChatV2PipelineProviderFailure | undefined;
      let lastError: unknown;

      for (let profileIndex = activeProfileIndex; profileIndex < params.candidates.length; profileIndex++) {
        throwIfAborted(roundOptions.context.signal);
        const candidate = params.candidates[profileIndex]!;
        let candidateOptions: RunChatV2PipelineOptions;

        try {
          candidateOptions = await params.resolveCandidate(profileIndex, roundOptions);
        } catch (error) {
          if (roundOptions.context.signal.aborted) {
            throw error;
          }

          lastError = error;
          terminalProviderFailure = undefined;
          attempts.push({
            roundIndex,
            profileIndex,
            provider: candidate.provider,
            model: candidate.model,
            stage: 'configuration',
            outcome: 'failure',
            error: getSafeErrorMessage(error, candidate),
          });
          clearPartialResponse(roundOptions);
          continue;
        }

        // Candidate resolution can be asynchronous (for example, plugin or
        // provider configuration). Do not start a physical request if the
        // graph was cancelled while that resolution was in flight.
        throwIfAborted(roundOptions.context.signal);

        const previousOnProviderAttempt = candidateOptions.onProviderAttempt;
        candidateOptions = {
          ...candidateOptions,
          profileIndex,
          roundIndex,
          onProviderAttempt: (attempt) => {
            try {
              previousOnProviderAttempt?.(attempt);
            } catch {
              // A caller-owned observer must not prevent this runner from
              // retaining the profile-chain diagnostics it owns.
            }
            attempts.push({
              roundIndex,
              profileIndex,
              provider: candidate.provider,
              model: candidate.model,
              stage: 'request',
              outcome: attempt.outcome === 'success' ? 'success' : 'failure',
              attemptIndex: attempt.attemptIndex,
              ...(attempt.status == null ? {} : { status: attempt.status }),
              ...(attempt.error == null ? {} : { error: getSafeErrorMessage(attempt.error, candidate) }),
            });
          },
        };

        let execution;
        try {
          execution = await runChatV2PipelineExecution(candidateOptions);
        } catch (error) {
          if (roundOptions.context.signal.aborted) {
            throw error;
          }

          // The candidate's provider/model is part of request construction.
          // Treat a failure there as an unsuccessful candidate too: it is
          // exactly what a fallback chain is intended to recover from. This
          // also lets a later profile whose provider supports the same shared
          // prompt/schema continue. If every candidate has the same graph
          // configuration problem, the aggregate error retains a safe record
          // of every failed candidate.
          lastError = error;
          terminalProviderFailure = undefined;
          const responseValidationFailure = isChatV2ResponseValidationError(error);
          attempts.push({
            roundIndex,
            profileIndex,
            provider: candidate.provider,
            model: candidate.model,
            stage: responseValidationFailure ? 'response-validation' : 'configuration',
            outcome: 'failure',
            error: getSafeErrorMessage(error, candidate),
          });
          clearPartialResponse(roundOptions);
          continue;
        }
        if (execution.outcome === 'success') {
          activeProfileIndex = profileIndex;
          nextRoundIndex += 1;
          return execution.result;
        }

        terminalProviderFailure = execution.failure;
        lastError = execution.failure.normalizedError;
        clearPartialResponse(roundOptions);
      }

      exhausted = true;
      if (params.candidates.length === 1 && terminalProviderFailure != null) {
        return materializeChatV2PipelineFailure(terminalProviderFailure);
      }

      // A scalar profile must preserve the legacy error surface for setup or
      // request-planning failures that occurred before the pipeline could
      // produce a provider-failure result.
      if (params.candidates.length === 1 && lastError !== undefined) {
        throw lastError;
      }

      if (
        terminalProviderFailure != null &&
        (terminalProviderFailure.options.outputRequestStatus ||
          shouldOutputChatV2RequestError(terminalProviderFailure.options))
      ) {
        try {
          return materializeChatV2PipelineFailure(terminalProviderFailure);
        } catch {
          // Some response-generation failures intentionally remain node errors
          // even when request details are enabled. The chain error below keeps
          // the complete profile history without hiding that failure.
        }
      }

      // `lastError` can contain raw provider metadata. The attempt records are
      // intentionally redacted, so do not attach the raw error as `cause` and
      // accidentally expose it through node/error serialization.
      throw new LLMProfileFallbackExhaustedError(attempts);
    },
  };
}
