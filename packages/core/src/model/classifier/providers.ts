import type { ClassifierCredentialNames } from './credentials.js';
import {
  JEV_DEFAULT_CREDENTIAL_NAMES,
  LIQUID_DEFAULT_CREDENTIAL_NAMES,
  OPENAI_DEFAULT_CREDENTIAL_NAMES,
} from './credentials.js';
import type { DataValue } from '../DataValue.js';
import { assertLiquidImageLimits } from './images.js';
import {
  prepareClassifierState,
  systemOneState,
  type ClassifierStateMessage,
  type PreparedClassifierState,
} from './state.js';
import { validateClassifierEvaluationResponse } from './response.js';
import { createOpenAIDecisionRequest, validateOpenAIDecisionResponse } from './openai.js';
import { prepareClassifierQuestion } from './questions.js';
import { classifierArrayValues } from './json.js';
import {
  assertClassifierResourceLimits,
  ClassifierValueBudget,
  CLASSIFIER_LIMITS,
  ClassifierResourceLimitError,
  readClassifierResponse,
} from './limits.js';
import type {
  ClassifierEvaluationResponse,
  ClassifierQuestionDefinition,
  PreparedClassifierQuestion,
} from './types.js';

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
const MAX_TIMER_DELAY_MS = 2_147_483_647;
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
  /** Graph entry uses the same runner without normalizing/copying State twice. */
  evaluateInput?(args: ClassifierProviderEvaluateArgs): Promise<ClassifierProviderEvaluationResult>;
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
  /** Optional Rivet wrapper for the graph entry; ordinary provider calls use state/stateMessages. */
  stateInput?: DataValue;
  timeoutMs: number;
  /** An earlier node deadline includes State normalization in the request budget. */
  deadline?: number;
  /** Opt-in retry policy for non-authentication, non-validation HTTP errors. */
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  fetchImplementation?: typeof fetch;
};

export type PreparedClassifierEvaluation = {
  model: string;
  state: PreparedClassifierState;
  questions: PreparedClassifierQuestion[];
};

type ClassifierProviderSpec = Omit<ClassifierProvider, 'evaluate' | 'evaluateInput'> & {
  endpoint: string;
  buildRequest(args: PreparedClassifierEvaluation): Record<string, unknown>;
  validateResponse: typeof validateClassifierEvaluationResponse;
  checkState?(state: PreparedClassifierState, check: () => void): void;
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
  /** Provider-owned evidence checks, independent of the descriptor's ID. */
  checkState?: ClassifierProviderSpec['checkState'];
};

/**
 * Builds a provider for the shared System One-compatible protocol. Provider
 * descriptors remain static Core code, while the Evaluate node stays agnostic
 * to which compatible provider is selected.
 */
export function createApiCompatibleClassifierProvider(
  config: ApiCompatibleClassifierProviderConfig,
): ClassifierProvider {
  return createClassifierProvider({
    ...config,
    browserExecutionSupported: config.browserExecutionSupported ?? false,
    buildRequest: ({ model, questions, state }) => ({
      ...systemOneState(state.kind === 'json' ? { state: state.value } : { state: '', stateMessages: state.messages }),
      model,
      questions: createQuestionMap(questions),
    }),
    validateResponse: validateClassifierEvaluationResponse,
  });
}

export const jevClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'jev',
  label: 'Jev',
  defaultModel: 'jev-latest',
  credentialNames: JEV_DEFAULT_CREDENTIAL_NAMES,
  endpoint: JEV_SYSTEM_ONE_ENDPOINT,
  modelPricing: [{ models: ['jev-latest', 'jev-preview', 'jev-1.13.0'], pricing: JEV_TOKEN_PRICING }],
});

export const liquidClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'liquid',
  label: 'Liquid AI',
  defaultModel: 'd1',
  credentialNames: LIQUID_DEFAULT_CREDENTIAL_NAMES,
  endpoint: LIQUID_SYSTEM_ONE_ENDPOINT,
  modelPricing: [{ models: ['d1'], pricing: LIQUID_TOKEN_PRICING }],
  supportsImages: (model) => model === 'd1',
  maxRequestBytes: 4_500_000,
  checkState: (state, check) => {
    if (state.kind === 'messages') assertLiquidImageLimits(state.images, check);
  },
});

export const openaiClassifierProvider: ClassifierProvider = createClassifierProvider({
  id: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-6-luna',
  credentialNames: OPENAI_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  endpoint: OPENAI_DECISIONS_ENDPOINT,
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
  buildRequest: createOpenAIDecisionRequest,
  validateResponse: validateOpenAIDecisionResponse,
});

/** Ordered so adding compatible providers does not alter authored IDs. */
export const classifierProviders: readonly ClassifierProvider[] = [
  jevClassifierProvider,
  liquidClassifierProvider,
  openaiClassifierProvider,
];

type ClassifierOperation = {
  signal: AbortSignal;
  deadline: number;
  check(attemptSignal?: AbortSignal): void;
};

function createOperation(args: ClassifierProviderEvaluateArgs, label: string): ClassifierOperation {
  if (
    !Number.isFinite(args.timeoutMs) ||
    args.timeoutMs <= 0 ||
    (args.deadline !== undefined && !Number.isFinite(args.deadline))
  )
    throw new Error('Classifier timeout and deadline must be finite, with a positive timeout.');
  const now = Date.now();
  const deadline = Math.min(now + args.timeoutMs, args.deadline ?? Infinity);
  // Node turns overflowing setTimeout delays into 1 ms, not a long timeout.
  if (deadline - now > MAX_TIMER_DELAY_MS)
    throw new Error(`Classifier effective timeout must not exceed ${MAX_TIMER_DELAY_MS} ms.`);
  const timeoutError = () => new Error(`${label} request timed out after ${args.timeoutMs} ms.`);
  return {
    signal: args.signal,
    deadline,
    check(attemptSignal) {
      throwIfAborted(args.signal, label);
      if (Date.now() >= deadline || attemptSignal?.aborted) throw timeoutError();
    },
  };
}

/** A plain specification and one runner for both graph and direct provider inputs. */
function createClassifierProvider(spec: ClassifierProviderSpec): ClassifierProvider {
  const { endpoint, buildRequest, validateResponse, checkState, ...provider } = spec;
  const evaluate = async (input: ClassifierProviderEvaluateArgs): Promise<ClassifierProviderEvaluationResult> => {
    // Reject removed evidence fields before object spread can read a getter or
    // discard non-enumerable/inherited content.
    if ('images' in input) throw new Error('Pass image evidence through State, not a separate images field.');
    const args = { ...input, fetchImplementation: input.fetchImplementation ?? fetch };
    const operation = createOperation(args, provider.label);
    operation.check();
    if (typeof args.model !== 'string') throw new Error('Classifier model must be a nonblank string.');
    const budget = new ClassifierValueBudget(operation.check, provider.maxRequestBytes);
    budget.inspect(args.model);
    if (args.model.trim() === '') throw new Error('Classifier model must be a nonblank string.');
    if (typeof args.apiKey !== 'string' || args.apiKey.trim() === '' || /[\r\n]/.test(args.apiKey))
      throw new Error('Classifier API key must be a nonblank string without line breaks.');
    if (!Array.isArray(args.questions) || args.questions.length === 0)
      throw new Error('Classifier Evaluate requires at least one question.');
    if (args.questions.length > CLASSIFIER_LIMITS.questions)
      throw new Error('Classifier Evaluate supports at most 1000 questions.');
    const state = prepareClassifierState(args, budget);
    const questions: PreparedClassifierQuestion[] = [];
    const ids = new Set<string>();
    for (const value of classifierArrayValues(args.questions, 'Questions')) {
      const question = prepareClassifierQuestion(value, budget);
      if (ids.has(question.questionId))
        throw new Error(`Question ID '${question.questionId}' is duplicated in this evaluation.`);
      ids.add(question.questionId);
      questions.push(question);
    }
    if (state.kind === 'messages' && state.images.length && !provider.supportsImages?.(args.model))
      throw new Error(`${provider.label} model '${args.model}' does not support classifier images.`);
    checkState?.(state, operation.check);
    operation.check();
    const result = await callClassifierHttp(
      args,
      { endpoint, validateResponse, label: provider.label, maxRequestBytes: provider.maxRequestBytes },
      { model: args.model, state, questions },
      buildRequest,
      operation,
    );
    operation.check();
    return result;
  };
  return { ...provider, evaluate, evaluateInput: evaluate };
}

function normalizeModelPricing(
  provider: Pick<ClassifierProvider, 'pricing' | 'modelPricing'> & Partial<Pick<ClassifierProvider, 'defaultModel'>>,
): readonly ClassifierModelPricing[] {
  return (
    provider.modelPricing ??
    (provider.pricing && provider.defaultModel ? [{ models: [provider.defaultModel], pricing: provider.pricing }] : [])
  );
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
  const entries = normalizeModelPricing(provider);
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

function createQuestionMap(
  questions: readonly PreparedClassifierQuestion[],
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

async function callClassifierHttp(
  args: ClassifierProviderEvaluateArgs & { fetchImplementation: typeof fetch },
  spec: Pick<ClassifierProviderSpec, 'endpoint' | 'label' | 'maxRequestBytes' | 'validateResponse'>,
  prepared: PreparedClassifierEvaluation,
  buildRequest: ClassifierProviderSpec['buildRequest'],
  operation: ClassifierOperation,
): Promise<ClassifierProviderEvaluationResult> {
  const { apiKey, fetchImplementation, retryOnNon200, retryOnNon200CooldownMs, retryOnNon200RepeatTimes } = args;
  const { endpoint, label: providerLabel, validateResponse, maxRequestBytes } = spec;
  const { signal, deadline } = operation;
  const request = buildRequest(prepared);
  const configuredRetryCount = retryOnNon200 ? normalizeClassifierNon200RetryCount(retryOnNon200RepeatTimes) : 0;
  const configuredCooldownMs = normalizeClassifierNon200RetryCooldownMs(retryOnNon200CooldownMs);
  let automaticRetryCount = 0;
  let configuredRetryCountUsed = 0;
  // The transformed protocol can expand content (notably escaped JSON in OpenAI).
  // This final wire check is distinct from validating/detaching untrusted inputs.
  assertClassifierResourceLimits(request, operation.check);
  const requestJson = JSON.stringify(request);
  if (maxRequestBytes !== undefined && new TextEncoder().encode(requestJson).byteLength >= maxRequestBytes) {
    throw new Error(
      `${providerLabel} request must be smaller than ${maxRequestBytes / 1_000_000} MB, including State, images, and questions. Resize images or reduce input content.`,
    );
  }
  let requestBody: Record<string, unknown> | undefined;
  operation.check();

  for (;;) {
    operation.check();
    const remainingMs = deadline - Date.now();

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`${providerLabel} request timeout`)), remainingMs);
    const cleanupAttempt = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const assertAttemptActive = () => operation.check(controller.signal);

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
      operation.check(controller.signal);
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
      operation.check(controller.signal);
      if (error instanceof ClassifierResourceLimitError) throw error;
      throw new Error(`${providerLabel} returned an invalid JSON response.`, { cause: error });
    } finally {
      cleanupAttempt();
    }
    const validatedResponse = validateResponse(body, prepared.questions, providerLabel);
    return {
      // Preserve the direct-provider result contract, but graph runs with the
      // diagnostic disabled never allocate this second representation.
      get requestBody() {
        return (requestBody ??= JSON.parse(requestJson) as Record<string, unknown>);
      },
      set requestBody(value: Record<string, unknown>) {
        requestBody = value;
      },
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
