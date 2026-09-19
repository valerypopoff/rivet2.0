import type { ClassifierCredentialNames } from './credentials.js';
import { JEV_DEFAULT_CREDENTIAL_NAMES } from './credentials.js';
import type {
  ClassifierChoiceQuestionDefinition,
  ClassifierEvaluationResponse,
  ClassifierQuestionDefinition,
  ClassifierScoreQuestionDefinition,
} from './types.js';

export const JEV_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 529]);

export const DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES = 1;
export const DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS = 0;

export type ClassifierProvider = {
  id: string;
  label: string;
  defaultModel: string;
  credentialNames: ClassifierCredentialNames;
  browserExecutionSupported: boolean;
  /**
   * The response used by the node plus the exact JSON bodies that crossed the
   * provider boundary. Request headers deliberately do not belong here: they
   * carry the API key and must never become graph outputs.
   */
  evaluate(args: ClassifierProviderEvaluateArgs): Promise<ClassifierProviderEvaluationResult>;
};

export type ClassifierProviderEvaluationResult = {
  requestBody: Record<string, unknown>;
  response: ClassifierEvaluationResponse;
  responseBody: Record<string, unknown>;
};

export type ClassifierProviderEvaluateArgs = {
  apiKey: string;
  model: string;
  questions: readonly ClassifierQuestionDefinition[];
  signal: AbortSignal;
  state: string | Record<string, unknown> | unknown[];
  timeoutMs: number;
  /** Opt-in retry policy for non-authentication, non-validation HTTP errors. */
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  fetchImplementation?: typeof fetch;
};

export type ApiCompatibleClassifierProviderConfig = {
  id: string;
  label: string;
  defaultModel: string;
  credentialNames: ClassifierCredentialNames;
  /** Static, provider-owned endpoint. It must never come from graph data. */
  endpoint: string;
  browserExecutionSupported?: boolean;
};

/**
 * Builds a provider for the shared System One-compatible protocol. Provider
 * descriptors remain static Core code, while the Evaluate node stays agnostic
 * to which compatible provider is selected.
 */
export function createApiCompatibleClassifierProvider(
  config: ApiCompatibleClassifierProviderConfig,
): ClassifierProvider {
  return {
    id: config.id,
    label: config.label,
    defaultModel: config.defaultModel,
    credentialNames: config.credentialNames,
    browserExecutionSupported: config.browserExecutionSupported ?? false,
    async evaluate({
      apiKey,
      fetchImplementation = fetch,
      model,
      questions,
      retryOnNon200,
      retryOnNon200CooldownMs,
      retryOnNon200RepeatTimes,
      signal,
      state,
      timeoutMs,
    }) {
      const request: ApiCompatibleRequest = {
        state,
        model,
        questions: createQuestionMap(questions),
      };

      return await callApiCompatibleClassifier({
        apiKey,
        endpoint: config.endpoint,
        fetchImplementation,
        providerLabel: config.label,
        questions,
        request,
        retryOnNon200,
        retryOnNon200CooldownMs,
        retryOnNon200RepeatTimes,
        signal,
        timeoutMs,
      });
    },
  };
}

export const jevClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'jev',
  label: 'Jev',
  defaultModel: 'jev-latest',
  credentialNames: JEV_DEFAULT_CREDENTIAL_NAMES,
  endpoint: JEV_SYSTEM_ONE_ENDPOINT,
});

/** Ordered so adding later API-compatible providers does not alter authored provider IDs. */
export const classifierProviders: readonly ClassifierProvider[] = [jevClassifierProvider];

export function getClassifierProvider(id: string | undefined): ClassifierProvider {
  const provider = classifierProviders.find((candidate) => candidate.id === (id || jevClassifierProvider.id));
  if (!provider) throw new Error(`Unknown classifier provider '${id}'.`);
  return provider;
}

export function getClassifierProviderEnvironmentVariableNames(): string[] {
  return [...new Set(classifierProviders.map((provider) => provider.credentialNames.environmentVariableName))];
}

type ApiCompatibleRequest = {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, Omit<ClassifierQuestionDefinition, 'questionId'>>;
};

function createQuestionMap(
  questions: readonly ClassifierQuestionDefinition[],
): Record<string, Omit<ClassifierQuestionDefinition, 'questionId'>> {
  const result = Object.create(null) as Record<string, Omit<ClassifierQuestionDefinition, 'questionId'>>;
  for (const question of questions) {
    const providerQuestion =
      question.type === 'noul' && question.criteria === undefined
        ? { type: question.type, instructions: question.instructions }
        : { type: question.type, instructions: question.instructions, criteria: question.criteria };
    Object.defineProperty(result, question.questionId, { enumerable: true, value: providerQuestion });
  }
  return result;
}

async function callApiCompatibleClassifier({
  apiKey,
  endpoint,
  fetchImplementation,
  providerLabel,
  questions,
  request,
  retryOnNon200,
  retryOnNon200CooldownMs,
  retryOnNon200RepeatTimes,
  signal,
  timeoutMs,
}: {
  apiKey: string;
  endpoint: string;
  fetchImplementation: typeof fetch;
  providerLabel: string;
  questions: readonly ClassifierQuestionDefinition[];
  request: ApiCompatibleRequest;
  retryOnNon200?: boolean;
  retryOnNon200CooldownMs?: number;
  retryOnNon200RepeatTimes?: number;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<ClassifierProviderEvaluationResult> {
  const deadline = Date.now() + timeoutMs;
  const configuredRetryCount = retryOnNon200
    ? normalizeClassifierNon200RetryCount(retryOnNon200RepeatTimes)
    : 0;
  const configuredCooldownMs = normalizeClassifierNon200RetryCooldownMs(retryOnNon200CooldownMs);
  let automaticRetryCount = 0;
  let configuredRetryCountUsed = 0;
  // Serialize once before the first attempt. This is the exact body sent for
  // every retry and a detached snapshot for the optional inspection output,
  // so concurrent graph code cannot mutate a shared State object between
  // retries and make the diagnostic disagree with the wire payload.
  const requestJson = JSON.stringify(request);
  const requestBody = JSON.parse(requestJson) as Record<string, unknown>;

  for (;;) {
    throwIfAborted(signal, providerLabel);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`${providerLabel} request timeout`)), remainingMs);
    const cleanupAttempt = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: requestJson,
        signal: controller.signal,
      });
    } catch {
      cleanupAttempt();
      if (signal.aborted) throwAbort(signal, providerLabel);
      if (Date.now() >= deadline || controller.signal.aborted) {
        throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
      }
      if (automaticRetryCount >= MAX_AUTOMATIC_ATTEMPTS - 1) {
        throw new Error(
          `${providerLabel} request failed after ${MAX_AUTOMATIC_ATTEMPTS} attempts due to a transport error.`,
        );
      }
      automaticRetryCount += 1;
      await waitForRetry(
        Math.min(250 * 2 ** (automaticRetryCount - 1), deadline - Date.now()),
        signal,
        providerLabel,
      );
      continue;
    }

    if (!response.ok) {
      cleanupAttempt();
      if (RETRYABLE_STATUSES.has(response.status) && automaticRetryCount < MAX_AUTOMATIC_ATTEMPTS - 1) {
        automaticRetryCount += 1;
        const delayMs = getRetryDelayMs(response.headers.get('retry-after'), automaticRetryCount, deadline);
        await response.body?.cancel().catch(() => undefined);
        await waitForRetry(delayMs, signal, providerLabel);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${providerLabel} authentication failed. Check the ${providerLabel} API key.`);
      }
      if (response.status === 422 || response.status === 400) {
        throw new Error(`${providerLabel} rejected the request (HTTP ${response.status}).`);
      }
      if (configuredRetryCountUsed < configuredRetryCount && !RETRYABLE_STATUSES.has(response.status)) {
        configuredRetryCountUsed += 1;
        await response.body?.cancel().catch(() => undefined);
        await waitForRetry(Math.min(configuredCooldownMs, deadline - Date.now()), signal, providerLabel);
        continue;
      }
      throw new Error(`${providerLabel} request failed (HTTP ${response.status}).`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (signal.aborted) throwAbort(signal, providerLabel);
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
      }
      throw new Error(`${providerLabel} returned an invalid JSON response.`);
    } finally {
      cleanupAttempt();
    }
    const validatedResponse = validateApiCompatibleClassifierResponse(body, questions, providerLabel);
    return {
      requestBody,
      response: validatedResponse,
      // The validator only accepts an object-shaped JSON response and returns
      // that exact parsed value; do not project it through Rivet's aggregate
      // answer contract before exposing the optional diagnostic output.
      responseBody: validatedResponse as unknown as Record<string, unknown>,
    };
  }

}

export function normalizeClassifierNon200RetryCount(value: number | undefined): number {
  const retryCount =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES;
  return Math.max(1, Math.floor(retryCount));
}

export function normalizeClassifierNon200RetryCooldownMs(value: number | undefined): number {
  const cooldownMs =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS;
  return Math.max(0, Math.floor(cooldownMs));
}

function throwIfAborted(signal: AbortSignal, providerLabel: string): void {
  if (signal.aborted) throwAbort(signal, providerLabel);
}

function throwAbort(signal: AbortSignal, providerLabel: string): never {
  throw signal.reason instanceof Error ? signal.reason : new Error(`${providerLabel} request aborted.`);
}

function waitForRetry(delayMs: number, signal: AbortSignal, providerLabel: string): Promise<void> {
  throwIfAborted(signal, providerLabel);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${providerLabel} request aborted.`));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function getRetryDelayMs(retryAfter: string | null, attempt: number, deadline: number): number {
  let requestedMs: number | undefined;
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) requestedMs = seconds * 1000;
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) requestedMs = Math.max(0, date - Date.now());
    }
  }
  return Math.max(0, Math.min(requestedMs ?? 250 * 2 ** (attempt - 1), deadline - Date.now()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFiniteUnit(value: unknown, label: string, providerLabel: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${providerLabel} response has invalid ${label}.`);
  }
  return value;
}

function requireProbabilityMap(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
  providerLabel: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${providerLabel} response has invalid ${label}.`);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${providerLabel} response has inconsistent ${label} keys.`);
  }
  let total = 0;
  for (const key of expectedKeys) total += requireFiniteUnit(value[key], `${label}.${key}`, providerLabel);
  if (Math.abs(total - 1) > 0.001) throw new Error(`${providerLabel} response ${label} must sum to 1.`);
  return value;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => structurallyEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && structurallyEqual(left[key], right[key]));
}

export function validateApiCompatibleClassifierResponse(
  body: unknown,
  questions: readonly ClassifierQuestionDefinition[],
  providerLabel = 'Classifier provider',
): ClassifierEvaluationResponse {
  if (
    !isRecord(body) ||
    typeof body.model !== 'string' ||
    body.model.trim() === '' ||
    !isRecord(body.answers) ||
    !isRecord(body.usage)
  ) {
    throw new Error(`${providerLabel} returned an invalid response shape.`);
  }
  const expectedIds = questions.map((question) => question.questionId);
  const answerIds = Object.keys(body.answers);
  if (
    answerIds.length !== expectedIds.length ||
    expectedIds.some((id) => !Object.prototype.hasOwnProperty.call(body.answers, id))
  ) {
    throw new Error(`${providerLabel} response does not match the submitted question IDs.`);
  }

  for (const question of questions) {
    const answer = body.answers[question.questionId];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new Error(`${providerLabel} response type does not match question '${question.questionId}'.`);
    }
    if (question.type === 'choice') {
      const choiceQuestion = question as ClassifierChoiceQuestionDefinition;
      const keys = Object.keys(choiceQuestion.criteria);
      if (
        typeof answer.choice !== 'string' ||
        !Object.prototype.hasOwnProperty.call(choiceQuestion.criteria, answer.choice)
      ) {
        throw new Error(`${providerLabel} response chose an unknown option for '${question.questionId}'.`);
      }
      requireFiniteUnit(answer.confidence, `${question.questionId}.confidence`, providerLabel);
      requireProbabilityMap(answer.probabilities, keys, `${question.questionId}.probabilities`, providerLabel);
    } else if (question.type === 'score') {
      const scoreQuestion = question as ClassifierScoreQuestionDefinition;
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > scoreQuestion.criteria.length - 1
      ) {
        throw new Error(`${providerLabel} response has invalid score for '${question.questionId}'.`);
      }
      requireFiniteUnit(answer.confidence, `${question.questionId}.confidence`, providerLabel);
      const keys = scoreQuestion.criteria.map((_, index) => String(index));
      requireProbabilityMap(answer.probabilities, keys, `${question.questionId}.probabilities`, providerLabel);
      const legend = answer.legend;
      if (
        !isRecord(legend) ||
        Object.keys(legend).length !== keys.length ||
        keys.some(
          (key, index) =>
            !Object.prototype.hasOwnProperty.call(legend, key) ||
            !structurallyEqual(legend[key], scoreQuestion.criteria[index]),
        )
      ) {
        throw new Error(`${providerLabel} response has inconsistent legend for '${question.questionId}'.`);
      }
    } else {
      requireFiniteUnit(answer.noul, `${question.questionId}.noul`, providerLabel);
    }
  }

  const inputTokens = body.usage.input_tokens;
  const outputTokens = body.usage.output_tokens;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new Error(`${providerLabel} response has invalid usage values.`);
  }
  return body as ClassifierEvaluationResponse;
}
