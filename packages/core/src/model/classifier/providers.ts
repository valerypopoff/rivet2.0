import type { ClassifierCredentialNames } from './credentials.js';
import {
  calculateTokenUsageCost,
  isReportedTokenCount,
  validateTokenPricing,
  type TokenPricing,
} from '../tokenPricing.js';
import {
  JEV_DEFAULT_CREDENTIAL_NAMES,
  LIQUID_DEFAULT_CREDENTIAL_NAMES,
  OPENAI_DEFAULT_CREDENTIAL_NAMES,
  OPENROUTER_DEFAULT_CREDENTIAL_NAMES,
  PERPLEXITY_DEFAULT_CREDENTIAL_NAMES,
  SUBQ_DEFAULT_CREDENTIAL_NAMES,
  BASETEN_DEFAULT_CREDENTIAL_NAMES,
} from './credentials.js';
import type { DataValue } from '../DataValue.js';
import { assertLiquidImageLimits } from './images.js';
import {
  prepareClassifierState,
  inspectStateMessages,
  systemOneState,
  type ClassifierStateMessage,
  type PreparedClassifierState,
} from './state.js';
import { validateClassifierEvaluationResponse } from './response.js';
import { createOpenAIDecisionRequest, validateOpenAIDecisionResponse } from './openai.js';
import { assertPerplexityDecisionLimits, perplexityDecisionState, PERPLEXITY_DECISION_MODELS } from './perplexity.js';
import { prepareClassifierQuestion, createQuestionMap } from './questions.js';
import { assertJevImageLimits, JEV_IMAGE_MODELS, JEV_BOX_MODELS, createJevDecisionRequest } from './jev.js';
import { assertSubQDecisionLimits, SUBQ_DECISION_MODELS, subqDecisionState } from './subq.js';
import { classifierArrayValues } from './json.js';
import { assertBasetenDecisionLimits, BASETEN_DECISION_MODELS, basetenDecisionState } from './baseten.js';
import {
  assertClassifierResourceLimits,
  ClassifierValueBudget,
  CLASSIFIER_LIMITS,
  ClassifierResourceLimitError,
  ClassifierResponseReadError,
  readClassifierResponse,
} from './limits.js';
import type {
  ClassifierFailureKind,
  ClassifierAttemptUsage,
  ClassifierEvaluationResponse,
  ClassifierQuestionDefinition,
  PreparedClassifierQuestion,
} from './types.js';

export { validateApiCompatibleClassifierResponse } from './response.js';

export const JEV_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const LIQUID_SYSTEM_ONE_ENDPOINT = 'https://api.liquid.ai/decisions/v1/systemone';
export const OPENAI_DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';
export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const PERPLEXITY_DECISIONS_ENDPOINT = 'https://api.perplexity.ai/v1/decisions';
export const SUBQ_DECISIONS_ENDPOINT = 'https://api.subq.ai/v1/systemone';
export const BASETEN_DECISIONS_ENDPOINT = 'https://inference.baseten.co/v1/systemone';

/** Jev 1.13/1.14 USD rates, verified 2026-10-24: https://docs.typesafe.ai/models */
export const JEV_TOKEN_PRICING = {
  inputPerMillionTokens: 0.042,
  outputPerMillionTokens: 0,
} as const;

/** Liquid d1 USD rates, verified 2026-10-26: https://www.liquid.ai/pricing */
export const LIQUID_TOKEN_PRICING = {
  inputPerMillionTokens: 0.02,
  outputPerMillionTokens: 0,
} as const;

const MAX_AUTOMATIC_ATTEMPTS = 3;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRYABLE_STATUSES = new Set([429, 529]);

export const DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES = 1;
export const DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS = 0;

export type ClassifierProvider = {
  id: string;
  label: string;
  defaultModel: string;
  /** Curated UI choices, not a runtime allowlist or a pricing/capability promise. */
  modelOptions?: readonly {
    value: string;
    label: string;
    /** UI notice for this verified model's upstream usage contract; absent means no claim. */
    aggregateTokenUsageOnly?: boolean;
  }[];
  /** Provider-owned model guidance shared by inline and Profile editors. */
  modelHelp?: string;
  credentialNames: ClassifierCredentialNames;
  browserExecutionSupported: boolean;
  /** Opt in only for a verified native input_tokens_details cache contract. */
  cacheTokenUsageSupported?: boolean;
  supportsImages?: (model: string) => boolean;
  supportsQuestionImages?: (model: string) => boolean;
  supportsBoxQuestions?: (model: string) => boolean;
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

export type ClassifierTokenPricing = TokenPricing & {
  /** The full request uses these rates above the documented context threshold. */
  longContext?: TokenPricing & { aboveInputTokens: number };
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
  tokenPricing?: TokenPricing;
  /** Privacy-bounded physical-attempt observer; never includes bodies or credentials. */
  onAttempt?: (attempt: {
    attemptIndex: number;
    outcome: 'success' | 'failure' | 'aborted';
    status?: number;
    kind?: ClassifierProviderError['kind'];
    error?: string;
    classifierUsage?: ClassifierAttemptUsage;
    /** Physical request through response validation, excluding retry waits. */
    durationMs?: number;
  }) => void;
  /** Opt-in node diagnostics, separate from privacy-bounded attempt events. */
  onRequestBody?: (getBody: () => Record<string, unknown>) => void;
  onResponseBody?: (body: unknown) => void;
  apiKey: string;
  model: string;
  questions: readonly ClassifierQuestionDefinition[];
  signal: AbortSignal;
  state: string | Record<string, unknown> | unknown[];
  stateMessages?: ClassifierStateMessage[];
  /** Optional Rivet wrapper for the graph entry; ordinary provider calls use state/stateMessages. */
  stateInput?: DataValue;
  /** Optional per-profile/request deadline; absent means caller cancellation only. */
  timeoutMs?: number;
  /** Optional absolute deadline for direct programmatic provider calls. */
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
  requestHeaders?(args: PreparedClassifierEvaluation): Record<string, string>;
  validateResponse: typeof validateClassifierEvaluationResponse;
  checkState?(state: PreparedClassifierState, check: () => void): void;
  checkRequest?(request: PreparedClassifierEvaluation, check: () => void): void;
};

export type ApiCompatibleClassifierProviderConfig = {
  id: string;
  label: string;
  defaultModel: string;
  modelOptions?: ClassifierProvider['modelOptions'];
  modelHelp?: string;
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

export const jevClassifierProvider = createClassifierProvider({
  id: 'jev',
  label: 'Jev',
  defaultModel: 'jev-latest',
  modelOptions: ['jev-latest', 'jev-preview', 'jev-1.14.0', 'jev-1.13.0'].map((value) => ({
    value,
    label: value,
    aggregateTokenUsageOnly: true,
  })),
  modelHelp:
    'Jev images are experimental: use still PNG/JPEG, 280–1568 pixels per side. Image requests enable TypeSafe’s experimental image API.',
  credentialNames: JEV_DEFAULT_CREDENTIAL_NAMES,
  endpoint: JEV_SYSTEM_ONE_ENDPOINT,
  browserExecutionSupported: false,
  modelPricing: [{ models: ['jev-latest', 'jev-preview', 'jev-1.13.0', 'jev-1.14.0'], pricing: JEV_TOKEN_PRICING }],
  supportsImages: (model) => JEV_IMAGE_MODELS.includes(model),
  supportsQuestionImages: (model) => JEV_IMAGE_MODELS.includes(model),
  supportsBoxQuestions: (model) => JEV_BOX_MODELS.includes(model),
  checkState: (state, check) => {
    if (state.kind === 'messages') assertJevImageLimits(state.images, check);
  },
  checkRequest: ({ questions }, check) => {
    for (const question of questions)
      if (question.instructionsMessages)
        assertJevImageLimits(inspectStateMessages(question.instructionsMessages, check), check);
  },
  buildRequest: createJevDecisionRequest,
  requestHeaders: ({ state, questions }): Record<string, string> =>
    (state.kind === 'messages' && state.images.length) ||
    questions.some(
      (question) =>
        question.type === 'box' ||
        question.instructionsMessages?.some(({ parts }) => parts.some((part) => part.type === 'image')),
    )
      ? { 'TypeSafe-Danger-Zone-Images': 'true' }
      : {},
  validateResponse: validateClassifierEvaluationResponse,
});

export const liquidClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'liquid',
  label: 'Liquid AI',
  defaultModel: 'd1',
  modelOptions: ['d1', 'd1.1'].map((value) => ({ value, label: value, aggregateTokenUsageOnly: true })),
  modelHelp: 'Images belong in shared State, not Question Instructions.',
  credentialNames: LIQUID_DEFAULT_CREDENTIAL_NAMES,
  endpoint: LIQUID_SYSTEM_ONE_ENDPOINT,
  modelPricing: [{ models: ['d1'], pricing: LIQUID_TOKEN_PRICING }],
  supportsImages: (model) => model === 'd1' || model === 'd1.1',
  maxRequestBytes: 4_500_000,
  checkState: (state, check) => {
    if (state.kind === 'messages') assertLiquidImageLimits(state.images, check);
  },
});

/** Native Decisions API, not chat completions. Microsoft Decision-1 is text-only.
 * https://openrouter.ai/microsoft/microsoft-decision-1
 */
export const openrouterClassifierProvider = createApiCompatibleClassifierProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  defaultModel: 'microsoft/microsoft-decision-1',
  modelOptions: [
    { value: 'microsoft/microsoft-decision-1', label: 'Microsoft Decision-1 (9b)', aggregateTokenUsageOnly: true },
  ],
  credentialNames: OPENROUTER_DEFAULT_CREDENTIAL_NAMES,
  endpoint: OPENROUTER_DECISIONS_ENDPOINT,
  modelPricing: [
    {
      models: ['microsoft/microsoft-decision-1'],
      pricing: { inputPerMillionTokens: 0.042, outputPerMillionTokens: 0 },
    },
  ],
});

/** Decisions-specific rates; cache reads/writes follow standard Luna ratios (verified 2026-10-30).
 * https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability
 */
export const openaiClassifierProvider: ClassifierProvider = createClassifierProvider({
  id: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-6-luna',
  modelOptions: [{ value: 'gpt-6-luna', label: 'gpt-6-luna' }],
  credentialNames: OPENAI_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  cacheTokenUsageSupported: true,
  endpoint: OPENAI_DECISIONS_ENDPOINT,
  supportsImages: (model) => model === 'gpt-6-luna',
  supportsQuestionImages: (model) => model === 'gpt-6-luna',
  modelPricing: [
    {
      models: ['gpt-6-luna'],
      pricing: {
        inputPerMillionTokens: 0.1,
        outputPerMillionTokens: 0,
        cacheReadPerMillionTokens: 0.01,
        cacheWritePerMillionTokens: 0.125,
        longContext: {
          aboveInputTokens: 272_000,
          inputPerMillionTokens: 0.2,
          outputPerMillionTokens: 0,
          cacheReadPerMillionTokens: 0.02,
          cacheWritePerMillionTokens: 0.25,
        },
      },
    },
  ],
  buildRequest: createOpenAIDecisionRequest,
  validateResponse: validateOpenAIDecisionResponse,
});

/** https://docs.perplexity.ai/docs/decisions/quickstart */
export const perplexityClassifierProvider: ClassifierProvider = createClassifierProvider({
  id: 'perplexity',
  label: 'Perplexity',
  defaultModel: 'pplx-decider-v1.1-27b',
  modelOptions: PERPLEXITY_DECISION_MODELS.map((value) => ({
    value,
    label: value.replace(/-27b$/, ' (27b)'),
    aggregateTokenUsageOnly: true,
  })),
  credentialNames: PERPLEXITY_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  endpoint: PERPLEXITY_DECISIONS_ENDPOINT,
  supportsImages: (model) => PERPLEXITY_DECISION_MODELS.includes(model),
  modelPricing: [
    {
      models: PERPLEXITY_DECISION_MODELS,
      pricing: { inputPerMillionTokens: 0.02, outputPerMillionTokens: 0 },
    },
  ],
  checkRequest: assertPerplexityDecisionLimits,
  buildRequest: ({ model, state, questions }) => ({
    model,
    state: perplexityDecisionState(state),
    questions: createQuestionMap(questions),
  }),
  validateResponse: validateClassifierEvaluationResponse,
});

/** Current model catalog rate, not the older launch article's $0.05/MTok.
 * https://docs.subq.ai/using-the-api/models/ (verified 2026-10-24).
 */
export const subqClassifierProvider: ClassifierProvider = createClassifierProvider({
  id: 'subq',
  label: 'SubQ',
  defaultModel: 'subq-snap-1.1',
  modelOptions: SUBQ_DECISION_MODELS.map((value) => ({ value, label: value, aggregateTokenUsageOnly: true })),
  credentialNames: SUBQ_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  endpoint: SUBQ_DECISIONS_ENDPOINT,
  supportsImages: (model) => SUBQ_DECISION_MODELS.includes(model),
  modelPricing: [{ models: SUBQ_DECISION_MODELS, pricing: { inputPerMillionTokens: 0.04, outputPerMillionTokens: 0 } }],
  maxRequestBytes: 13 * 1024 * 1024,
  checkRequest: assertSubQDecisionLimits,
  buildRequest: ({ model, state, questions }) => ({
    model,
    ...subqDecisionState(state),
    questions: createQuestionMap(questions),
  }),
  validateResponse: validateClassifierEvaluationResponse,
});

/** Native Baseten API reference uses Bearer authentication (not dedicated-deployment Api-Key). */
export const basetenClassifierProvider: ClassifierProvider = createClassifierProvider({
  id: 'baseten',
  label: 'Baseten',
  defaultModel: BASETEN_DECISION_MODELS[0],
  modelOptions: [
    { value: BASETEN_DECISION_MODELS[0], label: 'Elephant-1 (9b)', aggregateTokenUsageOnly: true },
    { value: BASETEN_DECISION_MODELS[1], label: 'Mammoth-1 (27b)', aggregateTokenUsageOnly: true },
    { value: BASETEN_DECISION_MODELS[2], label: 'Joey-1 (2b)', aggregateTokenUsageOnly: true },
  ],
  modelHelp: 'Images belong in shared State, not Question Instructions.',
  credentialNames: BASETEN_DEFAULT_CREDENTIAL_NAMES,
  browserExecutionSupported: false,
  endpoint: BASETEN_DECISIONS_ENDPOINT,
  supportsImages: (model) => BASETEN_DECISION_MODELS.some((id) => id === model),
  checkRequest: assertBasetenDecisionLimits,
  buildRequest: ({ model, state, questions }) => ({
    model,
    state: basetenDecisionState(state),
    questions: createQuestionMap(questions),
  }),
  validateResponse: validateClassifierEvaluationResponse,
  // A temporary free promotion is not permanent pricing. Unknown cost stays unknown.
});

/** Ordered so adding compatible providers does not alter authored IDs. */
export const classifierProviders: readonly ClassifierProvider[] = [
  jevClassifierProvider,
  liquidClassifierProvider,
  openaiClassifierProvider,
  openrouterClassifierProvider,
  perplexityClassifierProvider,
  subqClassifierProvider,
  basetenClassifierProvider,
];

type ClassifierOperation = {
  signal: AbortSignal;
  deadline: number;
  timeoutMessage: string;
  check(attemptSignal?: AbortSignal): void;
};

export class ClassifierProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'configuration'
      | 'capability'
      | 'timeout'
      | 'transport'
      | 'http'
      | 'response-parsing'
      | 'response-validation',
    readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DecisionAIProviderError';
  }
}

export function classifierFailureKind(kind: ClassifierProviderError['kind'], status?: number): ClassifierFailureKind {
  return kind === 'http' && (status === 401 || status === 403) ? 'authentication' : kind;
}

/** Bounded preparation/provider explanation, without traversing causes or capturing response bodies. */
export function classifierErrorMessage(error: unknown, apiKey?: string): string {
  try {
    const text =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Decision AI request failed.';
    return (apiKey ? text.split(apiKey).join('[redacted]') : text).slice(0, 2000);
  } catch {
    return 'Decision AI request failed with unreadable error metadata.';
  }
}

function createOperation(args: ClassifierProviderEvaluateArgs, label: string): ClassifierOperation {
  if (
    (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) ||
    (args.deadline !== undefined && !Number.isFinite(args.deadline))
  )
    throw new Error('Decision AI timeout and deadline must be finite, with a positive timeout.');
  const now = Date.now();
  const deadline = Math.min(args.timeoutMs === undefined ? Infinity : now + args.timeoutMs, args.deadline ?? Infinity);
  // Node turns overflowing setTimeout delays into 1 ms, not a long timeout.
  if (Number.isFinite(deadline) && deadline - now > MAX_TIMER_DELAY_MS)
    throw new Error(`Decision AI effective timeout must not exceed ${MAX_TIMER_DELAY_MS} ms.`);
  const timeoutMessage = `${label} request timed out${args.timeoutMs === undefined ? '' : ` after ${args.timeoutMs} ms`}.`;
  return {
    signal: args.signal,
    deadline,
    timeoutMessage,
    check(attemptSignal) {
      throwIfAborted(args.signal, label);
      if (Date.now() >= deadline || attemptSignal?.aborted)
        throw new ClassifierProviderError(timeoutMessage, 'timeout');
    },
  };
}

/** A plain specification and one runner for both graph and direct provider inputs. */
function createClassifierProvider(spec: ClassifierProviderSpec): ClassifierProvider {
  const { endpoint, buildRequest, requestHeaders, validateResponse, checkState, checkRequest, ...provider } = spec;
  const evaluate = async (input: ClassifierProviderEvaluateArgs): Promise<ClassifierProviderEvaluationResult> => {
    // Reject removed evidence fields before object spread can read a getter or
    // discard non-enumerable/inherited content.
    if ('images' in input) throw new Error('Pass image evidence through State, not a separate images field.');
    const args = {
      ...input,
      tokenPricing: validateTokenPricing(input.tokenPricing),
      fetchImplementation: input.fetchImplementation ?? fetch,
    };
    const operation = createOperation(args, provider.label);
    operation.check();
    if (typeof args.model !== 'string') throw new Error('Decision AI model must be a nonblank string.');
    const budget = new ClassifierValueBudget(operation.check, provider.maxRequestBytes);
    budget.inspect(args.model);
    if (args.model.trim() === '') throw new Error('Decision AI model must be a nonblank string.');
    if (typeof args.apiKey !== 'string' || args.apiKey.trim() === '' || /[\r\n]/.test(args.apiKey))
      throw new Error('Decision AI API key must be a nonblank string without line breaks.');
    if (!Array.isArray(args.questions) || args.questions.length === 0)
      throw new Error('Decision AI run requires at least one question.');
    if (args.questions.length > CLASSIFIER_LIMITS.questions)
      throw new Error('Decision AI run supports at most 1000 questions.');
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
    let imageCount = state.kind === 'messages' ? state.images.length : 0;
    for (const question of questions) {
      const images = question.instructionsMessages
        ? inspectStateMessages(question.instructionsMessages, operation.check)
        : [];
      imageCount += images.length;
      if (question.type === 'box') {
        if (!provider.supportsBoxQuestions?.(args.model))
          throw new ClassifierProviderError(
            `${provider.label} model '${args.model}' does not support Bounding Box questions.`,
            'capability',
          );
        if (!(state.kind === 'messages' && state.images.length) && !images.length)
          throw new ClassifierProviderError(
            `Bounding Box question '${question.questionId}' requires an image in shared State or its own Instructions.`,
            'capability',
          );
      }
      if (images.length && !provider.supportsQuestionImages?.(args.model))
        throw new ClassifierProviderError(
          `${provider.label} model '${args.model}' does not support images in question instructions. Use a compatible Jev or OpenAI profile.`,
          'capability',
        );
    }
    if (imageCount > 128) throw new Error('State and questions together must contain at most 128 images.');
    if (state.kind === 'messages' && state.images.length && !provider.supportsImages?.(args.model))
      throw new ClassifierProviderError(
        `${provider.label} model '${args.model}' does not support Decision AI images.`,
        'capability',
      );
    try {
      checkState?.(state, operation.check);
      checkRequest?.({ model: args.model, state, questions }, operation.check);
    } catch (error) {
      operation.check();
      throw new ClassifierProviderError(
        error instanceof Error ? error.message : `${provider.label} does not support this Decision AI evidence.`,
        'capability',
        undefined,
        { cause: error },
      );
    }
    operation.check();
    const result = await callClassifierHttp(
      args,
      { ...provider, endpoint, requestHeaders, validateResponse },
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

export function getClassifierSystemTokenPricing(
  providerId: string | undefined,
  model?: string,
): ClassifierTokenPricing | undefined {
  const provider = getClassifierProvider(providerId);
  return normalizeModelPricing(provider).find((entry) => entry.models.includes(model?.trim() || provider.defaultModel))
    ?.pricing;
}

export function getClassifierProvider(id: string | undefined): ClassifierProvider {
  const provider = classifierProviders.find((candidate) => candidate.id === (id || jevClassifierProvider.id));
  if (!provider) throw new Error(`Unknown Decision AI provider '${id}'.`);
  return provider;
}

export function getClassifierProviderEnvironmentVariableNames(): string[] {
  return [...new Set(classifierProviders.map((provider) => provider.credentialNames.environmentVariableName))];
}

/**
 * Returns a USD cost for safe non-negative integer token counts using authored
 * rates or a recognized requested/returned model pair. Provider input_tokens already
 * includes billed text/image work across questions; never multiply by question
 * count or add image tokens again. Verified cache reads/writes are input subsets.
 * Callers must not treat an unpriced provider as free.
 */
export function calculateClassifierUsageCost(
  provider: Pick<ClassifierProvider, 'pricing' | 'modelPricing'> &
    Partial<Pick<ClassifierProvider, 'defaultModel' | 'cacheTokenUsageSupported'>>,
  usage: ClassifierEvaluationResponse['usage'],
  models?: { requestedModel: string; responseModel: string },
  tokenPricing?: TokenPricing,
): number | undefined {
  let inputTokenDetails: { cacheReadTokens: number; cacheWriteTokens: number } | undefined;
  if (provider.cacheTokenUsageSupported && usage.input_tokens_details !== undefined) {
    const details = usage.input_tokens_details;
    // A reported breakdown must be complete; missing counters are not known zeros.
    if (
      details === null ||
      typeof details !== 'object' ||
      Array.isArray(details) ||
      !isReportedTokenCount(details.cached_tokens) ||
      !isReportedTokenCount(details.cache_write_tokens)
    )
      return undefined;
    inputTokenDetails = { cacheReadTokens: details.cached_tokens, cacheWriteTokens: details.cache_write_tokens };
  }
  const reportedUsage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, inputTokenDetails };
  if (tokenPricing !== undefined) return calculateTokenUsageCost(tokenPricing, reportedUsage);
  if (!models) return undefined;
  const entries = normalizeModelPricing(provider);
  const entry = entries.find(
    ({ models: names }) => names.includes(models.requestedModel) && names.includes(models.responseModel),
  );
  const base = entry?.pricing;
  const tier = base?.longContext;
  if (base == null || (tier != null && !isReportedTokenCount(tier.aboveInputTokens))) return undefined;
  try {
    validateTokenPricing(base);
    if (tier != null) validateTokenPricing(tier);
  } catch {
    return undefined;
  }
  const pricing = tier && usage.input_tokens > tier.aboveInputTokens ? tier : base;
  return calculateTokenUsageCost(pricing, reportedUsage);
}

async function callClassifierHttp(
  args: ClassifierProviderEvaluateArgs & { fetchImplementation: typeof fetch },
  spec: Pick<
    ClassifierProviderSpec,
    | 'endpoint'
    | 'label'
    | 'maxRequestBytes'
    | 'validateResponse'
    | 'defaultModel'
    | 'pricing'
    | 'modelPricing'
    | 'cacheTokenUsageSupported'
    | 'requestHeaders'
  >,
  prepared: PreparedClassifierEvaluation,
  buildRequest: ClassifierProviderSpec['buildRequest'],
  operation: ClassifierOperation,
): Promise<ClassifierProviderEvaluationResult> {
  const { apiKey, fetchImplementation, retryOnNon200, retryOnNon200CooldownMs, retryOnNon200RepeatTimes } = args;
  const { endpoint, label: providerLabel, validateResponse, maxRequestBytes } = spec;
  const { signal, deadline, timeoutMessage } = operation;
  const request = buildRequest(prepared);
  const requestHeaders = spec.requestHeaders?.(prepared);
  const configuredRetryCount = retryOnNon200 ? normalizeClassifierNon200RetryCount(retryOnNon200RepeatTimes) : 0;
  const configuredCooldownMs = normalizeClassifierNon200RetryCooldownMs(retryOnNon200CooldownMs);
  let automaticRetryCount = 0;
  let configuredRetryCountUsed = 0;
  // The transformed protocol can expand content (notably escaped JSON in OpenAI).
  // This final wire check is distinct from validating/detaching untrusted inputs.
  assertClassifierResourceLimits(request, operation.check);
  const requestJson = JSON.stringify(request);
  if (maxRequestBytes !== undefined && new TextEncoder().encode(requestJson).byteLength >= maxRequestBytes) {
    throw new ClassifierProviderError(
      `${providerLabel} request must be smaller than ${maxRequestBytes / 1_000_000} MB, including State, images, and questions. Resize images or reduce input content.`,
      'capability',
    );
  }
  let requestBody: Record<string, unknown> | undefined;
  let attemptIndex = -1;
  let attemptStartedAt = 0;
  const report = (
    outcome: 'success' | 'failure' | 'aborted',
    status?: number,
    kind?: ClassifierProviderError['kind'],
    classifierUsage?: ClassifierAttemptUsage,
    error?: string,
  ) => {
    try {
      args.onAttempt?.({
        attemptIndex,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        outcome,
        status,
        kind,
        ...(classifierUsage ? { classifierUsage } : {}),
        ...(error ? { error: classifierErrorMessage(error, apiKey) } : {}),
      });
    } catch {
      /* Observers cannot alter execution. */
    }
  };
  operation.check();

  for (;;) {
    operation.check();
    attemptIndex++;
    attemptStartedAt = Date.now();
    if (args.onRequestBody) {
      try {
        args.onRequestBody(() => (requestBody ??= JSON.parse(requestJson) as Record<string, unknown>));
      } catch {
        /* Observation only. */
      }
    }
    operation.check();
    const remainingMs = deadline - Date.now();

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = Number.isFinite(remainingMs)
      ? setTimeout(() => controller.abort(new Error(`${providerLabel} request timeout`)), remainingMs)
      : undefined;
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
          headers: { ...requestHeaders, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: requestJson,
          signal: controller.signal,
        }),
        controller.signal,
        discardResponseBody,
      );
    } catch (error) {
      cleanupAttempt();
      if (signal.aborted) {
        report('aborted', undefined, undefined, undefined, `${providerLabel} request was canceled.`);
        operation.check();
      }
      const kind = controller.signal.aborted && !signal.aborted ? 'timeout' : 'transport';
      report(
        'failure',
        undefined,
        kind,
        undefined,
        kind === 'timeout' ? timeoutMessage : `${providerLabel} transport request failed.`,
      );
      operation.check(controller.signal);
      if (automaticRetryCount >= MAX_AUTOMATIC_ATTEMPTS - 1) {
        throw new ClassifierProviderError(
          `${providerLabel} request failed after ${MAX_AUTOMATIC_ATTEMPTS} attempts due to a transport error.`,
          'transport',
          undefined,
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
      report(
        signal.aborted ? 'aborted' : 'failure',
        response.status,
        signal.aborted ? undefined : 'timeout',
        undefined,
        signal.aborted ? `${providerLabel} request was canceled.` : timeoutMessage,
      );
      throw error;
    }

    if (!response.ok) {
      // A valid key can lack access to a model. Do not diagnose 403 as an invalid key.
      const accessDeniedMessage =
        response.status === 403
          ? `${providerLabel} access denied (HTTP 403). Check API key permissions and requested model access.`
          : undefined;
      report(
        'failure',
        response.status,
        'http',
        undefined,
        accessDeniedMessage ??
          (response.status === 401
            ? `${providerLabel} authentication failed (HTTP ${response.status}). Check the ${providerLabel} API key.`
            : `${providerLabel} rejected the request (HTTP ${response.status}).`),
      );
      const retryable = RETRYABLE_STATUSES.has(response.status);
      const permanent = [400, 401, 402, 403, 413, 422].includes(response.status);
      const willRetry =
        (retryable && automaticRetryCount < MAX_AUTOMATIC_ATTEMPTS - 1) ||
        (!retryable && !permanent && configuredRetryCountUsed < configuredRetryCount);
      if (args.onResponseBody && !willRetry) {
        // Opt-in diagnostics must not hold up fallback on a stalled error body.
        const diagnosticTimer = setTimeout(() => controller.abort(), Math.min(1000, deadline - Date.now()));
        try {
          await waitForAttempt(
            readClassifierResponse(response, controller.signal, assertAttemptActive, args.onResponseBody),
            controller.signal,
          );
        } catch {
          // Missing, malformed, oversized or interrupted diagnostics cannot replace the HTTP rejection.
        } finally {
          clearTimeout(diagnosticTimer);
        }
      }
      cleanupAttempt();
      // Rejected bodies are not answer outputs. Release every response, not just
      // retries, so caught terminal failures cannot leave connections occupied.
      // Initiate cancellation without awaiting a hostile stream's cleanup;
      // neither the final error nor the next bounded retry may depend on it.
      discardResponseBody(response);
      // Diagnostic collection introduces an await after receiving the rejection.
      // Caller cancellation and any active request deadline outrank HTTP suppression.
      // Do not check the diagnostic-only controller: its 1 s cap preserves the HTTP error.
      operation.check();
      if (willRetry) {
        let delayMs: number;
        if (retryable) {
          automaticRetryCount += 1;
          delayMs = getRetryDelayMs(response.headers.get('retry-after'), automaticRetryCount, deadline);
        } else {
          configuredRetryCountUsed += 1;
          delayMs = Math.min(configuredCooldownMs, deadline - Date.now());
        }
        await waitForRetry(delayMs, signal, providerLabel);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ClassifierProviderError(
          accessDeniedMessage ?? `${providerLabel} authentication failed. Check the ${providerLabel} API key.`,
          'http',
          response.status,
        );
      }
      // Repeating an unchanged invalid/oversized request or an unfunded account
      // cannot recover. These remain HTTP failures so profile fallback works.
      if ([400, 402, 413, 422].includes(response.status)) {
        throw new ClassifierProviderError(
          `${providerLabel} rejected the request (HTTP ${response.status}).`,
          'http',
          response.status,
        );
      }
      throw new ClassifierProviderError(
        `${providerLabel} request failed (HTTP ${response.status}).`,
        'http',
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await waitForAttempt(
        readClassifierResponse(response, controller.signal, assertAttemptActive, args.onResponseBody),
        controller.signal,
      );
      assertAttemptActive();
    } catch (error) {
      if (signal.aborted) {
        report('aborted', response.status, undefined, undefined, `${providerLabel} request was canceled.`);
        discardResponseBody(response);
        operation.check();
      }
      const kind =
        controller.signal.aborted && !signal.aborted
          ? 'timeout'
          : error instanceof ClassifierResponseReadError
            ? 'transport'
            : 'response-parsing';
      report(
        'failure',
        response.status,
        kind,
        undefined,
        kind === 'timeout'
          ? timeoutMessage
          : error instanceof ClassifierResourceLimitError
            ? error.message
            : kind === 'transport'
              ? `${providerLabel} response body could not be read.`
              : `${providerLabel} returned an invalid JSON response.`,
      );
      discardResponseBody(response);
      operation.check(controller.signal);
      if (error instanceof ClassifierResourceLimitError) throw error;
      throw new ClassifierProviderError(
        kind === 'transport'
          ? `${providerLabel} response body could not be read.`
          : `${providerLabel} returned an invalid JSON response.`,
        kind,
        undefined,
        { cause: error },
      );
    } finally {
      cleanupAttempt();
    }
    let validatedResponse: ClassifierEvaluationResponse;
    try {
      validatedResponse = validateResponse(body, prepared.questions, providerLabel);
    } catch (error) {
      report(
        'failure',
        response.status,
        'response-validation',
        classifierAttemptUsage(body, spec, args.model, args.tokenPricing),
        error instanceof Error ? error.message : `${providerLabel} returned an invalid Decision AI response.`,
      );
      throw new ClassifierProviderError(
        error instanceof Error ? error.message : `${providerLabel} returned an invalid Decision AI response.`,
        'response-validation',
        undefined,
        { cause: error },
      );
    }
    report('success', response.status, undefined, classifierAttemptUsage(body, spec, args.model, args.tokenPricing));
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

/** The bounded reader produced plain JSON; do not require valid answers to retain usable usage. */
function classifierAttemptUsage(
  body: unknown,
  provider: Pick<ClassifierProvider, 'defaultModel' | 'pricing' | 'modelPricing' | 'cacheTokenUsageSupported'>,
  requestedModel: string,
  tokenPricing?: TokenPricing,
): ClassifierAttemptUsage | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'usage')) return;
  const { usage, model } = body as { usage?: ClassifierEvaluationResponse['usage']; model?: string };
  if (
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage) ||
    !Object.hasOwn(usage, 'input_tokens') ||
    !Object.hasOwn(usage, 'output_tokens') ||
    !isReportedTokenCount(usage.input_tokens) ||
    !isReportedTokenCount(usage.output_tokens)
  )
    return;
  const estimatedCostUsd =
    typeof model === 'string' && Object.hasOwn(body, 'model')
      ? calculateClassifierUsageCost(provider, usage, { requestedModel, responseModel: model }, tokenPricing)
      : undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
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

async function waitForRetry(delayMs: number, signal: AbortSignal, providerLabel: string): Promise<void> {
  throwIfAborted(signal, providerLabel);
  // Without a request deadline, authored/provider waits can exceed one timer.
  // Chunk the wait instead of overflowing to 1 ms or retrying before it expires.
  while (delayMs > 0) {
    const chunkMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new Error(`${providerLabel} request aborted.`));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, chunkMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    throwIfAborted(signal, providerLabel);
    delayMs -= chunkMs;
  }
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
