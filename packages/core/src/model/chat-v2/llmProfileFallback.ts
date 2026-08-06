import type { PortId } from '../NodeBase.js';
import { isChatV2ResponseValidationError, runChatV2PipelineExecution } from './chatV2Pipeline.js';
import {
  type ChatV2Provider,
  type ChatV2PipelineRoundOptions,
  type ChatV2PipelineResult,
  type RunChatV2PipelineOptions,
} from './chatV2Types.js';
import { getCustomProviderApiContract, type CustomProviderApi } from './customProviderApi.js';

export type LLMAttempt = {
  roundIndex: number;
  /** Present when a From profile candidate produced this attempt. */
  profileIndex?: number;
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
  stage: 'configuration' | 'request' | 'response-validation';
  outcome: 'success' | 'failure' | 'aborted';
  attemptIndex?: number;
  status?: number;
  error?: string;
};

export type LLMProfileFallbackCandidate = {
  provider: ChatV2Provider;
  model: string;
  customProviderApi?: CustomProviderApi;
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
        let candidateOptions: RunChatV2PipelineOptions;

        try {
          candidateOptions = await params.resolveCandidate(profileIndex, roundOptions);
        } catch (error) {
          if (roundOptions.context.signal.aborted) {
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
          continue;
        }
        if (execution.outcome === 'success') {
          activeProfileIndex = profileIndex;
          nextRoundIndex += 1;
          return execution.result;
        }

        lastError = execution.failure.normalizedError;
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
