import type { InternalProcessContext } from '../ProcessContext.js';
import type { NodeId } from '../NodeBase.js';
import {
  createProfileHealthPermit,
  runBoundedHealthOperation,
  type LLMAttempt,
} from '../chat-v2/llmProfileFallback.js';
import {
  ClassifierProviderError,
  classifierFailureKind,
  getClassifierProvider,
  type ClassifierProviderEvaluationResult,
} from './providers.js';
import {
  classifierProfileHealthIdentity,
  classifierProfileHealthPolicy,
  classifierProfileResponseTimeout,
  type ClassifierProfileValue,
} from './profile.js';
import type { ClassifierState } from './state.js';
import type { ClassifierQuestionDefinition } from './types.js';

export function classifierProfileSummary(
  profiles: readonly ClassifierProfileValue[],
  attempts: readonly LLMAttempt[],
): string {
  return profiles
    .map((profile, index) => {
      const events = attempts.filter((attempt) => attempt.profileIndex === index);
      const terminal = events
        .filter((event) => event.stage !== 'health-gate' && event.stage !== 'health-update')
        .at(-1);
      const outcome =
        terminal?.skipReason === 'unreached'
          ? 'not reached'
          : terminal?.outcome === 'success'
            ? 'succeeded'
            : events.some((event) => event.outcome === 'skipped')
              ? 'suspended'
              : events.length
                ? 'failed'
                : 'not reached';
      return `${index + 1}. ${profile.profileName || 'Classifier Profile'} (${profile.configuration.provider}/${profile.configuration.model}): ${outcome}`;
    })
    .join('\n');
}

export class ClassifierProfileExhaustedError extends Error {
  constructor(
    readonly attempts: readonly LLMAttempt[],
    readonly summary: string,
    options?: ErrorOptions,
    readonly statusCode?: number,
  ) {
    super(`Classifier profile chain exhausted.\n${summary}`, options);
    this.name = 'ClassifierProfileExhaustedError';
  }
}

export async function runClassifierProfiles(input: {
  profiles: readonly ClassifierProfileValue[];
  state: ClassifierState;
  questions: ClassifierQuestionDefinition[];
  context: InternalProcessContext;
  nodeId: NodeId;
  deadline: number;
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  onAttempt: (attempt: LLMAttempt) => void;
}): Promise<{
  result: ClassifierProviderEvaluationResult;
  provider: ReturnType<typeof getClassifierProvider>;
  model: string;
}> {
  const attempts: LLMAttempt[] = [];
  const { context } = input;
  let lastError: unknown;
  let httpFailuresOnly = true;
  let lastHttpStatus: number | undefined;
  const record = (attempt: LLMAttempt) => {
    const event = {
      ...attempt,
      ...(attempt.stage === 'health-update' && attempt.outcome === 'failure'
        ? { error: 'Classifier profile health service unavailable.' }
        : {}),
      family: 'classifier' as const,
      profileName: input.profiles[attempt.profileIndex ?? 0]?.profileName,
    };
    attempts.push(event);
    try {
      input.onAttempt(event);
    } catch {
      /* Observation only. */
    }
  };
  for (let profileIndex = 0; profileIndex < input.profiles.length; profileIndex++) {
    context.signal.throwIfAborted();
    if (Date.now() >= input.deadline) {
      lastError = new ClassifierProviderError('Classifier overall deadline expired.', 'timeout');
      httpFailuresOnly = false;
      break;
    }
    const profile = input.profiles[profileIndex]!;
    const provider = getClassifierProvider(profile.configuration.provider);
    const model = profile.configuration.model;
    const policy = classifierProfileHealthPolicy(profile.configuration);
    const store = context.llmProfileHealthStore;
    const health =
      policy && store && context.project?.metadata.id
        ? { policy, identity: classifierProfileHealthIdentity(profile, context.project.metadata.id, input.nodeId) }
        : undefined;
    const base = { roundIndex: 0, profileIndex, provider: provider.id, model, profileHealthKey: health?.identity.key };
    let observedRequest = false;
    let lastPhysicalFailure: { kind?: ClassifierProviderError['kind']; status?: number } | undefined;
    let permit: ReturnType<typeof createProfileHealthPermit> | undefined;
    if (health && store) {
      try {
        const begin = await runBoundedHealthOperation({
          operation: 'begin',
          timeoutMs: Math.max(1, Math.min(2000, input.deadline - Date.now())),
          signal: context.signal,
          run: () => store.begin(health),
          onLateResolve: async (late) => {
            if (late.disposition === 'allow' && late.permitId)
              await store.finish({ ...health, permitId: late.permitId, outcome: 'ignored' });
          },
        });
        if (begin.disposition === 'deny') {
          record({
            ...base,
            stage: 'health-gate',
            outcome: 'skipped',
            healthDisposition: 'deny',
            healthState: begin.state,
            retryAt: begin.retryAt,
          });
          continue;
        }
        if (!begin.permitId) throw new Error('Profile health service did not return a permit.');
        record({
          ...base,
          stage: 'health-gate',
          outcome: 'success',
          healthDisposition: 'allow',
          healthState: begin.state,
        });
        permit = createProfileHealthPermit({
          candidate: { ...base, health },
          healthStore: store,
          permitId: begin.permitId,
          state: begin.state,
          roundIndex: 0,
          profileIndex,
          operationTimeoutMs: 2000,
          executionCorrelationId: context.llmProfileHealthExecutionCorrelationId,
          signal: context.signal,
          recordAttempt: record,
        });
      } catch {
        context.signal.throwIfAborted();
        record({
          ...base,
          stage: 'health-gate',
          outcome: 'failure',
          healthDisposition: 'fail-open',
          error: 'Classifier profile health service unavailable.',
        });
      }
    }
    try {
      context.signal.throwIfAborted();
      if (!provider.browserExecutionSupported && context.executor === 'browser')
        throw new ClassifierProviderError('Classifier provider requires the Node executor.', 'capability');
      if (!profile.credential.value?.trim())
        throw new ClassifierProviderError('Classifier Profile API key is not set.', 'configuration');
      const timeoutMs = Math.min(classifierProfileResponseTimeout(profile.configuration), input.deadline - Date.now());
      if (timeoutMs <= 0) throw new ClassifierProviderError('Classifier overall deadline expired.', 'timeout');
      const result = await provider.evaluate({
        ...input.state,
        questions: input.questions,
        apiKey: profile.credential.value,
        model,
        timeoutMs,
        deadline: input.deadline,
        signal: context.signal,
        retryOnNon200: input.retryOnNon200,
        retryOnNon200RepeatTimes: input.retryOnNon200RepeatTimes,
        retryOnNon200CooldownMs: input.retryOnNon200CooldownMs,
        onAttempt: ({ kind, ...attempt }) => {
          observedRequest = true;
          lastPhysicalFailure = attempt.outcome === 'failure' ? { kind, status: attempt.status } : undefined;
          record({
            ...base,
            ...attempt,
            stage: kind === 'response-validation' || kind === 'response-parsing' ? 'response-validation' : 'request',
            failureKind: kind ? classifierFailureKind(kind, attempt.status) : undefined,
            timeoutKind: kind === 'timeout' ? 'response' : undefined,
          });
        },
      });
      context.signal.throwIfAborted();
      if (Date.now() >= input.deadline)
        throw new ClassifierProviderError('Classifier overall deadline expired.', 'timeout');
      await permit?.finish('healthy');
      context.signal.throwIfAborted();
      if (Date.now() >= input.deadline)
        throw new ClassifierProviderError('Classifier overall deadline expired.', 'timeout');
      for (let unreached = profileIndex + 1; unreached < input.profiles.length; unreached++) {
        const candidate = input.profiles[unreached]!;
        record({
          roundIndex: 0,
          profileIndex: unreached,
          provider: candidate.configuration.provider,
          model: candidate.configuration.model,
          stage: 'configuration',
          outcome: 'skipped',
          skipReason: 'unreached',
        });
      }
      return { result, provider, model };
    } catch (error) {
      lastError = error;
      const providerError = error instanceof ClassifierProviderError ? error : undefined;
      const httpFailure =
        providerError?.kind === 'http' &&
        providerError.statusCode !== undefined &&
        (providerError.statusCode < 200 || providerError.statusCode >= 300);
      httpFailuresOnly &&= httpFailure;
      if (httpFailure) lastHttpStatus = providerError.statusCode;
      const alreadyReported =
        providerError &&
        lastPhysicalFailure?.kind === providerError.kind &&
        (providerError.kind !== 'http' || lastPhysicalFailure.status === providerError.statusCode);
      if (!alreadyReported)
        record({
          ...base,
          stage: providerError
            ? providerError.kind === 'configuration' || providerError.kind === 'capability'
              ? 'configuration'
              : providerError.kind === 'response-validation' || providerError.kind === 'response-parsing'
                ? 'response-validation'
                : 'request'
            : 'configuration',
          failureKind: providerError
            ? classifierFailureKind(providerError.kind, providerError.statusCode)
            : 'configuration',
          outcome: context.signal.aborted ? 'aborted' : 'failure',
          status: providerError?.statusCode,
          error: providerError
            ? `Classifier ${providerError.kind} failure${providerError.statusCode ? ` (HTTP ${providerError.statusCode})` : ''}.`
            : 'Classifier profile configuration or evidence capability failed.',
          timeoutKind: providerError?.kind === 'timeout' ? 'response' : undefined,
        });
      const unhealthy =
        providerError?.kind === 'timeout' ||
        providerError?.kind === 'transport' ||
        (providerError?.kind === 'http' &&
          (providerError.statusCode === 408 ||
            providerError.statusCode === 429 ||
            (providerError.statusCode ?? 0) >= 500));
      await permit?.finish(!context.signal.aborted && observedRequest && unhealthy ? 'unhealthy' : 'ignored');
      context.signal.throwIfAborted();
      if (Date.now() >= input.deadline) {
        httpFailuresOnly = false;
        lastError = new ClassifierProviderError('Classifier overall deadline expired.', 'timeout', undefined, {
          cause: error,
        });
        if (providerError?.kind !== 'timeout')
          record({
            ...base,
            stage: 'request',
            outcome: 'failure',
            error: 'Classifier overall deadline expired.',
            failureKind: 'timeout',
            timeoutKind: 'response',
          });
        break;
      }
    }
  }
  // Classify terminal candidate failures, not discarded physical retries or
  // observability events. The final cause alone cannot describe a mixed chain.
  throw new ClassifierProfileExhaustedError(
    attempts,
    classifierProfileSummary(input.profiles, attempts),
    { cause: lastError },
    httpFailuresOnly ? lastHttpStatus : undefined,
  );
}
