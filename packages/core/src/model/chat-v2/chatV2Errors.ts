import type { ChatV2Provider } from './chatV2Types.js';
import { getChatV2ProviderLabel } from './providerOptions.js';

type ChatV2ErrorContext = {
  provider: ChatV2Provider;
  modelId: string;
};

type ErrorLike = Error & {
  cause?: unknown;
  data?: unknown;
  functionality?: string;
  response?: {
    status?: unknown;
    statusCode?: unknown;
  };
  responseBody?: string;
  status?: unknown;
  statusCode?: unknown;
  url?: string;
};

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Rate Limited',
};

function compact(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    return false;
  }

  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function getRecordProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function stringifyProviderValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return compact(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return compact(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function findProviderMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return stringifyProviderValue(value);
  }

  const direct = value.message ?? value.error_description ?? value.detail;
  if (direct != null) {
    return stringifyProviderValue(direct);
  }

  const nestedError = value.error;
  if (nestedError != null) {
    return findProviderMessage(nestedError);
  }

  return undefined;
}

function parseResponseBodyMessage(responseBody: string | undefined): string | undefined {
  if (!responseBody?.trim()) {
    return undefined;
  }

  try {
    return findProviderMessage(JSON.parse(responseBody));
  } catch {
    return compact(responseBody);
  }
}

function getProviderMessage(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!isRecord(error) || seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  const responseBodyMessage =
    typeof error.responseBody === 'string' ? parseResponseBodyMessage(error.responseBody) : undefined;
  if (responseBodyMessage) {
    return responseBodyMessage;
  }

  const response = error.response;
  if (isRecord(response)) {
    const nestedResponseBody =
      typeof response.responseBody === 'string'
        ? response.responseBody
        : typeof response.body === 'string'
          ? response.body
          : undefined;
    const nestedResponseMessage =
      parseResponseBodyMessage(nestedResponseBody) ??
      findProviderMessage(response.data) ??
      findProviderMessage(response);
    if (nestedResponseMessage) {
      return nestedResponseMessage;
    }
  }

  const dataMessage = findProviderMessage(error.data);
  if (dataMessage) {
    return dataMessage;
  }

  const causeMessage = getProviderMessage(error.cause, seen);
  if (causeMessage) {
    return causeMessage;
  }

  return findProviderMessage(error);
}

function formatEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return compact(url.split(/[?#]/, 1)[0] ?? url);
  }
}

function getApiCallRecommendation(statusCode: number | undefined, context: ChatV2ErrorContext): string {
  switch (statusCode) {
    case 400:
    case 422:
      return 'Check the model name, messages, response format, tools, and generation parameters. The provider rejected the request shape.';
    case 401:
      return 'Check the API key source. The provider rejected the key or no valid key was sent.';
    case 403:
      return 'Check that the API key has access to this provider, model, and endpoint.';
    case 404:
      return context.provider === 'custom'
        ? 'Check the model name and Provider base URL. For Custom provider, use the provider OpenAI-compatible base URL, for example https://api.cerebras.ai/v1.'
        : 'Check the model name and provider endpoint. The provider could not find the requested model or route.';
    case 408:
      return 'The provider request timed out. Try again or reduce the request size.';
    case 409:
      return 'The provider reported a request conflict. Retry the request or check provider-side state.';
    case 429:
      return 'The provider rate-limited the request. Check quota, billing, and retry later.';
    default:
      if (statusCode != null && statusCode >= 500) {
        return 'The provider returned a server error. Retry later or check the provider status page.';
      }

      return 'The request could not reach or complete against the provider. Check the provider URL, network access, and API key.';
  }
}

function hasSdkErrorName(error: ErrorLike, namePart: string): boolean {
  return error.name.toLowerCase().includes(namePart.toLowerCase());
}

export function isChatV2ProviderApiCallError(error: unknown): error is ErrorLike {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name.toLowerCase().includes('apicallerror') ||
    (typeof (error as ErrorLike).url === 'string' &&
      ('statusCode' in error ||
        'status' in error ||
        'response' in error ||
        'responseBody' in error ||
        'requestBodyValues' in error))
  );
}

export function isChatV2ProviderFetchError(error: unknown): error is ErrorLike {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === 'TypeError' &&
    (message.includes('failed to fetch') || message.includes('load failed') || message.includes('fetch failed'))
  );
}

function coerceHttpStatusCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 100 && value <= 599 ? value : undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    return /^\d{3}$/.test(trimmed) && Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
  }

  return undefined;
}

function getRecordStatusCode(record: Record<string, unknown>): number | undefined {
  return (
    coerceHttpStatusCode(getRecordProperty(record, 'statusCode')) ??
    coerceHttpStatusCode(getRecordProperty(record, 'status'))
  );
}

export function getChatV2ProviderErrorStatusCode(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  if (seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  const directStatusCode = getRecordStatusCode(error);
  if (directStatusCode != null) {
    return directStatusCode;
  }

  const response = getRecordProperty(error, 'response');
  if (isRecord(response)) {
    const responseStatusCode = getRecordStatusCode(response);
    if (responseStatusCode != null) {
      return responseStatusCode;
    }
  }

  const data = getRecordProperty(error, 'data');
  if (isRecord(data)) {
    const dataStatusCode = getRecordStatusCode(data);
    if (dataStatusCode != null) {
      return dataStatusCode;
    }

    const dataError = getRecordProperty(data, 'error');
    if (isRecord(dataError)) {
      const dataErrorStatusCode = getRecordStatusCode(dataError);
      if (dataErrorStatusCode != null) {
        return dataErrorStatusCode;
      }
    }
  }

  return getChatV2ProviderErrorStatusCode(getRecordProperty(error, 'cause'), seen);
}

function formatProviderFetchError(error: ErrorLike, context: ChatV2ErrorContext): string {
  return [
    'LLM provider request failed before Rivet could read an HTTP response.',
    `Provider: ${getChatV2ProviderLabel(context.provider)}`,
    `Model: ${context.modelId}`,
    'The browser/runtime fetch layer hid the provider response. In Browser executor mode this commonly happens because of CORS or a provider-side request rejection.',
    'Check the API key source, provider URL, and network access. Use the Node executor when you need the exact provider HTTP status.',
    compact(error.message),
  ].join('\n');
}

function formatApiCallError(error: ErrorLike, context: ChatV2ErrorContext): string {
  const statusCode = getChatV2ProviderErrorStatusCode(error);
  const statusLabel =
    statusCode == null ? 'request failed' : `${statusCode} ${STATUS_TEXT[statusCode] ?? 'HTTP error'}`;
  const providerMessage = getProviderMessage(error);
  const lines = [
    `LLM provider request failed (${statusLabel}).`,
    `Provider: ${getChatV2ProviderLabel(context.provider)}`,
    `Model: ${context.modelId}`,
  ];

  if (error.url) {
    lines.push(`Endpoint: ${formatEndpoint(error.url)}`);
  }

  if (providerMessage) {
    lines.push(`Provider message: ${providerMessage}`);
  }

  lines.push(getApiCallRecommendation(statusCode, context));

  return lines.join('\n');
}

function formatKnownSdkError(error: ErrorLike, context: ChatV2ErrorContext): string | undefined {
  if (hasSdkErrorName(error, 'NoSuchModelError')) {
    return [
      'LLM model was not found before the provider request was sent.',
      `Provider: ${getChatV2ProviderLabel(context.provider)}`,
      `Model: ${context.modelId}`,
      'Check the selected model name.',
    ].join('\n');
  }

  if (hasSdkErrorName(error, 'LoadAPIKeyError')) {
    return [
      'LLM API key could not be loaded.',
      `Provider: ${getChatV2ProviderLabel(context.provider)}`,
      'Check the API key source and configured provider credentials.',
      compact(error.message),
    ].join('\n');
  }

  if (hasSdkErrorName(error, 'UnsupportedFunctionalityError')) {
    const functionality = error.functionality ? ` (${error.functionality})` : '';
    return [
      `The selected model/provider does not support a requested feature${functionality}.`,
      `Provider: ${getChatV2ProviderLabel(context.provider)}`,
      `Model: ${context.modelId}`,
      'Disable the unsupported setting or choose a model/provider that supports it.',
    ].join('\n');
  }

  if (hasSdkErrorName(error, 'TypeValidationError') || hasSdkErrorName(error, 'JSONParseError')) {
    return [
      'The provider returned data that Rivet could not parse or validate.',
      `Provider: ${getChatV2ProviderLabel(context.provider)}`,
      `Model: ${context.modelId}`,
      'Check the response format settings and provider response.',
      compact(error.message),
    ].join('\n');
  }

  return undefined;
}

export function normalizeChatV2ProviderError(error: unknown, context: ChatV2ErrorContext): unknown {
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return error;
  }

  const message = isChatV2ProviderApiCallError(error)
    ? formatApiCallError(error, context)
    : isChatV2ProviderFetchError(error)
      ? formatProviderFetchError(error, context)
      : formatKnownSdkError(error as ErrorLike, context);

  if (message == null) {
    return error;
  }

  const normalized = new Error(message);
  normalized.name = 'LLM Chat error';
  normalized.cause = error;
  const statusCode = getChatV2ProviderErrorStatusCode(error);
  if (statusCode != null) {
    (normalized as ErrorLike).statusCode = statusCode;
  }
  return normalized;
}
