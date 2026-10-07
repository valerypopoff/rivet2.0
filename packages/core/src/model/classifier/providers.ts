import type { ClassifierCredentialNames } from './credentials.js';
import {
  JEV_DEFAULT_CREDENTIAL_NAMES,
  LIQUID_DEFAULT_CREDENTIAL_NAMES,
  OPENAI_DEFAULT_CREDENTIAL_NAMES,
} from './credentials.js';
import { assertLiquidImages } from './images.js';
import { assertClassifierStateMessages, systemOneState, type ClassifierStateMessage } from './state.js';
import { validateApiCompatibleClassifierResponse } from './response.js';
import { createOpenAIDecisionRequest, validateOpenAIDecisionResponse } from './openai.js';
import { validateClassifierQuestion } from './questions.js';
import { assertClassifierJson, classifierArrayValues } from './json.js';
import {
  assertClassifierResourceLimits,
  classifierPreparationCheck,
  CLASSIFIER_LIMITS,
  ClassifierResourceLimitError,
  readClassifierResponse,
} from './limits.js';
import type { ClassifierEvaluationResponse, ClassifierQuestionDefinition } from './types.js';

export { validateApiCompatibleClassifierResponse } from './response.js';

export const JEV_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const LIQUID_SYSTEM_ONE_ENDPOINT = 'https://api.liquid.ai/decisions/v1/systemone';
export const OPENAI_DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';

/** Jev's published USD rates. Keep this Core-owned rather than graph-authored. */
export const JEV_TOKEN_PRICING = {
  inputPerMillionTokens: 0.042,
  outputPerMillionTokens: 0,
} as const;

/** Liquid d1's published USD rates: https://www.liquid.ai/blog/d1-decision-model */
export const LIQUID_TOKEN_PRICING = {
  inputPerMillionTokens: 0.04,
  outputPerMillionTokens: 0,
} as const;

const TOKENS_PER_MILLION = 1_000_000;

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
  supportsImages?: (model: string) => boolean;
  /** A stricter provider request limit also bounds preparation before encoding. */
  maxRequestBytes?: number;
  /** Legacy shorthand: pricing for defaultModel only, never arbitrary models. */
  pricing?: ClassifierTokenPricing;
  modelPricing?: readonly ClassifierModelPricing[];
  /**
   * The response used by the node plus the exact JSON bodies that crossed the
   * provider boundary. Request headers deliberately do not belong here: they
   * carry the API key and must never become graph outputs.
   */
  evaluate(args: ClassifierProviderEvaluateArgs): Promise<ClassifierProviderEvaluationResult>;
};

export type ClassifierTokenPricing = {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  /** The full request uses these rates above the documented context threshold. */
  longContext?: { aboveInputTokens: number; inputPerMillionTokens: number; outputPerMillionTokens: number };
};

export type ClassifierModelPricing = {
  /** Exact verified model IDs/aliases belonging to the same priced model. */
  models: readonly string[];
  pricing: ClassifierTokenPricing;
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
  stateMessages?: ClassifierStateMessage[];
  timeoutMs: number;
  /** An earlier node deadline includes State normalization in the request budget. */
  deadline?: number;
  /** Opt-in retry policy for non-authentication, non-validation HTTP errors. */
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  fetchImplementation?: typeof fetch;
};

/** Internal adapters share the snapshot boundary's absolute deadline. */
type ClassifierRequestProvider = Omit<ClassifierProvider, 'evaluate'> & {
  evaluate(args: ClassifierProviderEvaluateArgs & { deadline: number }): Promise<ClassifierProviderEvaluationResult>;
};

export type ApiCompatibleClassifierProviderConfig = {
  id: string;
  label: string;
  defaultModel: string;
  credentialNames: ClassifierCredentialNames;
  /** Static, provider-owned endpoint. It must never come from graph data. */
  endpoint: string;
  browserExecutionSupported?: boolean;
  /** Static USD token pricing for Cost and optional Usage accounting. */
  pricing?: ClassifierTokenPricing;
  modelPricing?: readonly ClassifierModelPricing[];
  supportsImages?: (model: string) => boolean;
  maxRequestBytes?: number;
};

/**
 * Builds a provider for the shared System One-compatible protocol. Provider
 * descriptors remain static Core code, while the Evaluate node stays agnostic
 * to which compatible provider is selected.
 */
export function createApiCompatibleClassifierProvider(
  config: ApiCompatibleClassifierProviderConfig,
): ClassifierProvider {
  config = { ...config };
  return withSharedState({
    id: config.id,
    label: config.label,
    defaultModel: config.defaultModel,
    credentialNames: config.credentialNames,
    browserExecutionSupported: config.browserExecutionSupported ?? false,
    pricing: config.pricing,
    modelPricing: config.modelPricing,
    supportsImages: config.supportsImages ?? (() => false),
    maxRequestBytes: config.maxRequestBytes,
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
      stateMessages,
      deadline,
    }) {
      const request: ApiCompatibleRequest = {
        ...systemOneState({ state, stateMessages }),
        model,
        questions: createQuestionMap(questions),
      };
      if (config.id === 'liquid')
        assertLiquidImages(request.images ?? [], classifierPreparationCheck(signal, deadline, timeoutMs));

      return await callClassifierHttp({
        apiKey,
        endpoint: config.endpoint,
        fetchImplementation,
        providerLabel: config.label,
        request,
        questions,
        validateResponse: validateApiCompatibleClassifierResponse,
        retryOnNon200,
        retryOnNon200CooldownMs,
        retryOnNon200RepeatTimes,
        signal,
        timeoutMs,
        deadline,
        maxRequestBytes: config.maxRequestBytes,
      });
    },
  });
}

export const jevClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'jev',
  label: 'Jev',
  defaultModel: 'jev-latest',
  credentialNames: JEV_DEFAULT_CREDENTIAL_NAMES,
  endpoint: JEV_SYSTEM_ONE_ENDPOINT,
  pricing: JEV_TOKEN_PRICING,
  modelPricing: [{ models: ['jev-latest', 'jev-preview', 'jev-1.13.0'], pricing: JEV_TOKEN_PRICING }],
});

export const liquidClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'liquid',
  label: 'Liquid AI',
  defaultModel: 'd1',
  credentialNames: LIQUID_DEFAULT_CREDENTIAL_NAMES,
  endpoint: LIQUID_SYSTEM_ONE_ENDPOINT,
  pricing: LIQUID_TOKEN_PRICING,
  supportsImages: (model) => model === 'd1',
  maxRequestBytes: 4_500_000,
});

export const openaiClassifierProvider: ClassifierProvider = withSharedState({
  id: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-6-luna',
  credentialNames: OPENAI_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  supportsImages: (model) => model === 'gpt-6-luna',
  modelPricing: [
    {
      models: ['gpt-6-luna'],
      pricing: {
        inputPerMillionTokens: 0.1,
        outputPerMillionTokens: 0,
        longContext: { aboveInputTokens: 272_000, inputPerMillionTokens: 0.2, outputPerMillionTokens: 0 },
      },
    },
  ],
  async evaluate(args) {
    return callClassifierHttp({
      ...args,
      endpoint: OPENAI_DECISIONS_ENDPOINT,
      fetchImplementation: args.fetchImplementation ?? fetch,
      providerLabel: 'OpenAI',
      request: createOpenAIDecisionRequest(args),
      validateResponse: validateOpenAIDecisionResponse,
    });
  },
});

/** Ordered so adding later API-compatible providers does not alter authored provider IDs. */
export const classifierProviders: readonly ClassifierProvider[] = [
  jevClassifierProvider,
  liquidClassifierProvider,
  openaiClassifierProvider,
];

/** Both protocols evaluate every question against the same shared evidence. */
function withSharedState(provider: ClassifierRequestProvider): ClassifierProvider {
  return {
    ...provider,
    async evaluate(args) {
      args = { ...args, fetchImplementation: args.fetchImplementation ?? fetch };
      if (
        !Number.isFinite(args.timeoutMs) ||
        args.timeoutMs <= 0 ||
        (args.deadline !== undefined && !Number.isFinite(args.deadline))
      )
        throw new Error('Classifier timeout and deadline must be finite, with a positive timeout.');
      const deadline = Math.min(Date.now() + args.timeoutMs, args.deadline ?? Infinity);
      const assertActive = () => {
        throwIfAborted(args.signal, provider.label);
        if (Date.now() >= deadline) throw new Error(`${provider.label} request timed out after ${args.timeoutMs} ms.`);
      };
      assertActive();
      if ('images' in args) throw new Error('Pass image evidence through State, not a separate images field.');
      if (!Array.isArray(args.questions) || args.questions.length === 0)
        throw new Error('Classifier Evaluate requires at least one question.');
      if (args.questions.length > CLASSIFIER_LIMITS.questions)
        throw new Error('Classifier Evaluate supports at most 1000 questions.');
      assertClassifierResourceLimits(
        { state: args.state, questions: args.questions, stateMessages: args.stateMessages },
        assertActive,
        provider.maxRequestBytes,
      );
      const questions: ClassifierQuestionDefinition[] = [];
      const ids = new Set<string>();
      for (const question of classifierArrayValues(args.questions, 'Questions')) {
        validateClassifierQuestion(question, assertActive);
        if (ids.has(question.questionId))
          throw new Error(`Question ID '${question.questionId}' is duplicated in this evaluation.`);
        ids.add(question.questionId);
        questions.push(question);
      }
      assertClassifierJson(args.state, 'State', false, assertActive);
      if (args.stateMessages !== undefined) {
        if (args.state !== '')
          throw new Error('Structured State and multimodal State messages cannot be supplied together.');
        assertClassifierStateMessages(args.stateMessages, assertActive);
      }
      // Detach evidence before IO so retries and response validation use the same snapshot.
      assertActive();
      const snapshot = JSON.parse(
        JSON.stringify({ state: args.state, questions, stateMessages: args.stateMessages }),
      ) as {
        state: ClassifierProviderEvaluateArgs['state'];
        questions: ClassifierQuestionDefinition[];
        stateMessages?: ClassifierStateMessage[];
      };
      const hasImages = snapshot.stateMessages?.some(({ parts }) => parts.some((part) => part.type === 'image'));
      if (hasImages && !provider.supportsImages?.(args.model)) {
        throw new Error(`${provider.label} model '${args.model}' does not support classifier images.`);
      }
      assertActive();
      const result = await provider.evaluate({ ...args, ...snapshot, deadline });
      assertActive();
      return result;
    },
  };
}

export function getClassifierProvider(id: string | undefined): ClassifierProvider {
  const provider = classifierProviders.find((candidate) => candidate.id === (id || jevClassifierProvider.id));
  if (!provider) throw new Error(`Unknown classifier provider '${id}'.`);
  return provider;
}

export function getClassifierProviderEnvironmentVariableNames(): string[] {
  return [...new Set(classifierProviders.map((provider) => provider.credentialNames.environmentVariableName))];
}

/**
 * Returns a USD cost only for a recognized requested/returned model pair and
 * the token counts are safe non-negative integers. Callers must not treat an
 * unpriced provider as free.
 */
export function calculateClassifierUsageCost(
  provider: Pick<ClassifierProvider, 'pricing' | 'modelPricing'> & Partial<Pick<ClassifierProvider, 'defaultModel'>>,
  usage: ClassifierEvaluationResponse['usage'],
  models?: { requestedModel: string; responseModel: string },
): number | undefined {
  if (!models) return undefined;
  const entries =
    provider.modelPricing ??
    (provider.pricing && provider.defaultModel ? [{ models: [provider.defaultModel], pricing: provider.pricing }] : []);
  const entry = entries.find(
    ({ models: names }) => names.includes(models.requestedModel) && names.includes(models.responseModel),
  );
  const base = entry?.pricing;
  const tier = base?.longContext;
  const validRates = (rates: Pick<ClassifierTokenPricing, 'inputPerMillionTokens' | 'outputPerMillionTokens'>) =>
    Number.isFinite(rates.inputPerMillionTokens) &&
    rates.inputPerMillionTokens >= 0 &&
    Number.isFinite(rates.outputPerMillionTokens) &&
    rates.outputPerMillionTokens >= 0;
  if (
    base == null ||
    !validRates(base) ||
    (tier != null &&
      (!Number.isSafeInteger(tier.aboveInputTokens) || tier.aboveInputTokens < 0 || !validRates(tier))) ||
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    return undefined;
  }
  const pricing = tier && usage.input_tokens > tier.aboveInputTokens ? tier : base;
  const totalCost =
    (usage.input_tokens * pricing.inputPerMillionTokens + usage.output_tokens * pricing.outputPerMillionTokens) /
    TOKENS_PER_MILLION;
  return Number.isFinite(totalCost) && totalCost >= 0 ? totalCost : undefined;
}

type ApiCompatibleRequest = {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, Omit<ClassifierQuestionDefinition, 'questionId'>>;
  images?: string[];
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

async function callClassifierHttp({
  apiKey,
  endpoint,
  fetchImplementation,
  providerLabel,
  request,
  questions,
  validateResponse,
  retryOnNon200,
  retryOnNon200CooldownMs,
  retryOnNon200RepeatTimes,
  signal,
  timeoutMs,
  deadline,
  maxRequestBytes,
}: {
  apiKey: string;
  endpoint: string;
  fetchImplementation: typeof fetch;
  providerLabel: string;
  request: Record<string, unknown>;
  questions: readonly ClassifierQuestionDefinition[];
  validateResponse: typeof validateApiCompatibleClassifierResponse;
  retryOnNon200?: boolean;
  retryOnNon200CooldownMs?: number;
  retryOnNon200RepeatTimes?: number;
  signal: AbortSignal;
  timeoutMs: number;
  deadline: number;
  maxRequestBytes?: number;
}): Promise<ClassifierProviderEvaluationResult> {
  const configuredRetryCount = retryOnNon200 ? normalizeClassifierNon200RetryCount(retryOnNon200RepeatTimes) : 0;
  const configuredCooldownMs = normalizeClassifierNon200RetryCooldownMs(retryOnNon200CooldownMs);
  let automaticRetryCount = 0;
  let configuredRetryCountUsed = 0;
  // Serialize once before the first attempt. This is the exact body sent for
  // every retry and a detached snapshot for the optional inspection output,
  // so concurrent graph code cannot mutate a shared State object between
  // retries and make the diagnostic disagree with the wire payload.
  const checkPreparation = () => {
    throwIfAborted(signal, providerLabel);
    if (Date.now() >= deadline) throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
  };
  assertClassifierResourceLimits(request, checkPreparation);
  const requestJson = JSON.stringify(request);
  if (maxRequestBytes !== undefined && new TextEncoder().encode(requestJson).byteLength >= maxRequestBytes) {
    throw new Error(
      `${providerLabel} request must be smaller than ${maxRequestBytes / 1_000_000} MB, including State, images, and questions. Resize images or reduce input content.`,
    );
  }
  const requestBody = JSON.parse(requestJson) as Record<string, unknown>;
  checkPreparation();
  // The snapshot boundary already detached every question before IO.
  const responseQuestions = questions;

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
    const assertAttemptActive = () => {
      throwIfAborted(signal, providerLabel);
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
      }
    };

    let response: Response;
    try {
      response = await waitForAttempt(
        fetchImplementation(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: requestJson,
          signal: controller.signal,
        }),
        controller.signal,
        discardResponseBody,
      );
    } catch (error) {
      cleanupAttempt();
      if (signal.aborted) throwAbort(signal, providerLabel);
      if (Date.now() >= deadline || controller.signal.aborted) {
        throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
      }
      if (automaticRetryCount >= MAX_AUTOMATIC_ATTEMPTS - 1) {
        throw new Error(
          `${providerLabel} request failed after ${MAX_AUTOMATIC_ATTEMPTS} attempts due to a transport error.`,
          { cause: error },
        );
      }
      automaticRetryCount += 1;
      await waitForRetry(Math.min(250 * 2 ** (automaticRetryCount - 1), deadline - Date.now()), signal, providerLabel);
      continue;
    }

    try {
      assertAttemptActive();
    } catch (error) {
      cleanupAttempt();
      discardResponseBody(response);
      throw error;
    }

    if (!response.ok) {
      cleanupAttempt();
      // Rejected bodies are not answer outputs. Release every response, not just
      // retries, so caught terminal failures cannot leave connections occupied.
      // Initiate cancellation without awaiting a hostile stream's cleanup;
      // neither the final error nor the next bounded retry may depend on it.
      discardResponseBody(response);
      if (RETRYABLE_STATUSES.has(response.status) && automaticRetryCount < MAX_AUTOMATIC_ATTEMPTS - 1) {
        automaticRetryCount += 1;
        const delayMs = getRetryDelayMs(response.headers.get('retry-after'), automaticRetryCount, deadline);
        await waitForRetry(delayMs, signal, providerLabel);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`${providerLabel} authentication failed. Check the ${providerLabel} API key.`), {
          statusCode: response.status,
        });
      }
      if (response.status === 422 || response.status === 400) {
        throw Object.assign(new Error(`${providerLabel} rejected the request (HTTP ${response.status}).`), {
          statusCode: response.status,
        });
      }
      if (configuredRetryCountUsed < configuredRetryCount && !RETRYABLE_STATUSES.has(response.status)) {
        configuredRetryCountUsed += 1;
        await waitForRetry(Math.min(configuredCooldownMs, deadline - Date.now()), signal, providerLabel);
        continue;
      }
      throw Object.assign(new Error(`${providerLabel} request failed (HTTP ${response.status}).`), {
        statusCode: response.status,
      });
    }

    let body: unknown;
    try {
      body = await waitForAttempt(
        readClassifierResponse(response, controller.signal, assertAttemptActive),
        controller.signal,
      );
      assertAttemptActive();
    } catch (error) {
      discardResponseBody(response);
      if (signal.aborted) throwAbort(signal, providerLabel);
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new Error(`${providerLabel} request timed out after ${timeoutMs} ms.`);
      }
      if (error instanceof ClassifierResourceLimitError) throw error;
      throw new Error(`${providerLabel} returned an invalid JSON response.`, { cause: error });
    } finally {
      cleanupAttempt();
    }
    const validatedResponse = validateResponse(body, responseQuestions, providerLabel);
    return {
      requestBody,
      response: validatedResponse,
      // Expose native JSON, not the adapter's Rivet answer projection. The
      // validators accept only object-shaped provider envelopes.
      responseBody: body as Record<string, unknown>,
    };
  }
}

/** Bound awaiting even when a custom transport ignores its abort signal. */
function waitForAttempt<T>(promise: Promise<T>, signal: AbortSignal, onLateResult?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      aborted = true;
      cleanup();
      reject(signal.reason);
    };
    // Attach both handlers even after cancellation: late errors are consumed
    // and a late HTTP response is disposed, never accepted by another attempt.
    promise.then(
      (value) => {
        cleanup();
        if (aborted) onLateResult?.(value);
        else resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup is observational, including custom fetch/body implementations.
  }
}

export function normalizeClassifierNon200RetryCount(value: number | undefined): number {
  const retryCount =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES;
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
