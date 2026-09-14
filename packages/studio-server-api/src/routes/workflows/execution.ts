import { performance } from 'node:perf_hooks';
import type { IncomingMessage } from 'node:http';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createProcessor,
  createRivetStoredValueSnapshotStore,
  ExecutionRecorder,
  getUiGraphActionComponent,
  jsonValueToDataValue,
  renderRivetWebAppHtml,
  resolveUiGraphActionInputs,
  resolveUiGraphActionOutputStatePatch,
  RivetWebAppActionHttpError,
  type DataValue,
  type LooseDataValue,
  type RivetWebAppActionResult,
  type RivetWebAppProcessorOptions,
  type UiComponentId,
  type UiGraphActionComponent,
  type UiGraph,
} from '@valerypopoff/rivet2-node';

import {
  isLatestWorkflowRemoteDebuggerEnabled,
  maybeGetLatestWorkflowRemoteDebugger,
} from '../../latestWorkflowRemoteDebugger.js';
import { registerActiveHttpExecution } from '../../active-http-executions.js';
import {
  getPublishedExecutionAdmission,
  PublishedExecutionAdmissionError,
  toPublishedExecutionAdmissionError,
  type PublishedExecutionPermit,
  type PublishedExecutionSurface,
} from '../../published-execution-admission.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { closeResponseConnectionAfterFlush } from '../../middleware/body-admission.js';
import { createJsonBodyParser } from '../../middleware/body-parsers.js';
import { getLatestWebAppsBasePath, getPublishedWebAppsBasePath } from '../../workflowEndpointPaths.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import {
  createManagedCodeRunnerTelemetry,
  getManagedCodeRunnerTelemetrySnapshot,
  isManagedCodeRunnerTelemetryEnabled,
  ManagedCodeRunner,
  type ManagedCodeRunnerTelemetry,
} from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';
import { isTrustedProxyRequest, isTrustedClientRequest } from '../../auth.js';
import { getRequestCorrelationId, RIVET_CORRELATION_HEADER } from '../../request-correlation.js';
import { isServerUiAuthRequestAllowed } from '../../server-ui-auth.js';
import {
  createWebAppOAuthAuthorizationRedirect,
  getWebAppOAuthSessionOwnerKey,
  getWebAppAuthMode,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
  WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT,
} from '../../web-app-oauth.js';
import { readWorkflowEndpointAuthSettingsSync } from '../../workflow-endpoint-auth-settings.js';
import { readRuntimeLimitSettingsSync } from '../../runtime-limit-settings.js';
import { isWorkflowCapacityCapabilityValid } from '../../workflow-capacity-capability.js';
import { readExecutionEnvironmentVariables } from '../../environment-variable-settings.js';
import { enqueueWorkflowExecutionRecordingPersistence } from './recordings.js';
import { trackLLMProfileHealthRecordingOutcome } from '../../llm-profile-health/recording-outcomes.js';
import {
  createExecutionProjectReferenceLoader,
  getLLMProfileHealthStore,
  persistWorkflowExecutionRecordingWithBackend,
  resolveLatestExecutionProject,
  resolveLatestWebAppExecutionProject as resolveLatestWebAppExecutionProjectWithBackend,
  resolvePublishedExecutionProject,
  resolvePublishedWebAppExecutionProject as resolvePublishedWebAppExecutionProjectWithBackend,
  resolveWebAppAccessPolicy,
  type WebAppAccessPolicy,
} from './storage-backend.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
  shouldSnapshotWorkflowRecordingDatasets,
} from './recordings-config.js';
import { sanitizeUiAuthReturnTo } from '../../ui-auth-utils.js';
import type { WorkflowRecordingExecutionIdentity } from '../../../../studio-server-shared/workflow-recording-types.js';

export const publishedWorkflowsRouter = Router();
export const internalPublishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();
export const publishedWebAppsRouter = Router();
export const latestWebAppsRouter = Router();

const WORKFLOW_JSON_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_WEB_APP_ACTION_PREFLIGHTS = 16;
const WEB_APP_ACTION_PREFLIGHT_TIMEOUT_MS = 15_000;
let activeWebAppActionPreflights = 0;

type WorkflowRequestHeadersContext = Record<string, string>;
type WorkflowExecutionContext = {
  headers: {
    type: 'any';
    value: WorkflowRequestHeadersContext;
  };
};

export type WorkflowExecutionProject =
  Awaited<ReturnType<typeof resolvePublishedExecutionProject>> extends infer T ? Exclude<T, null> : never;

const WORKFLOW_CONTEXT_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const UNSAFE_WORKFLOW_CONTEXT_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_WORKFLOW_CONTEXT_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-forwarded-authorization',
  'x-rivet-proxy-auth',
  'x-rivet-token-free-host',
  'x-rivet-client-ip',
]);

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasWorkflowRequestBody(req: Request): boolean {
  const transferEncoding = req.get('transfer-encoding');
  if (transferEncoding) {
    return true;
  }

  const contentLength = req.get('content-length');
  if (contentLength != null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    return !Number.isFinite(parsedLength) || parsedLength > 0;
  }

  return false;
}

function getWorkflowRequestInputs(req: Request): Record<string, { type: 'any'; value: unknown }> {
  if (!hasWorkflowRequestBody(req)) {
    return {};
  }

  return {
    input: {
      type: 'any',
      value: req.body,
    },
  };
}

function normalizeWorkflowContextHeaderName(name: string): string | null {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName || UNSAFE_WORKFLOW_CONTEXT_HEADER_NAMES.has(normalizedName)) {
    return null;
  }

  return WORKFLOW_CONTEXT_HEADER_NAME_PATTERN.test(normalizedName) ? normalizedName : null;
}

function normalizeWorkflowContextHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => typeof item === 'string') ? value.join(', ') : null;
  }

  return null;
}

export function normalizeWorkflowRequestHeadersForContext(
  rawHeaders: Record<string, unknown> | null | undefined,
  options?: { excludeHeaderNames?: ReadonlySet<string> },
): WorkflowRequestHeadersContext {
  const headers: WorkflowRequestHeadersContext = {};
  if (!isJsonObjectRecord(rawHeaders)) {
    return headers;
  }

  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const name = normalizeWorkflowContextHeaderName(rawName);
    if (!name) {
      continue;
    }

    if (options?.excludeHeaderNames?.has(name)) {
      continue;
    }

    const value = normalizeWorkflowContextHeaderValue(rawValue);
    if (value == null) {
      continue;
    }

    headers[name] = value;
  }

  return headers;
}

function getWorkflowRequestHeaders(req: Request | IncomingMessage): WorkflowRequestHeadersContext {
  const headers = normalizeWorkflowRequestHeadersForContext(req.headers, {
    excludeHeaderNames: SENSITIVE_WORKFLOW_CONTEXT_HEADER_NAMES,
  });
  // This ID is generated by Rivet or forwarded only by its authenticated proxy.
  headers[RIVET_CORRELATION_HEADER] = getRequestCorrelationId(req);
  return headers;
}

function getWorkflowResponsePayload(outputs: Record<string, { type?: string; value?: unknown }>): unknown {
  const outputValue = outputs.output;
  if (outputValue?.type !== 'any') {
    return outputs;
  }

  return outputValue.value ?? null;
}

export function getWorkflowRecordingStatusFromOutputs(
  outputs: Record<string, { type?: string; value?: unknown }>,
): 'succeeded' | 'suspicious' {
  return outputs.output?.type === 'control-flow-excluded' ? 'suspicious' : 'succeeded';
}

function sendJsonWithDuration(res: Response, statusCode: number, payload: unknown, requestStartedAt: number): void {
  const durationMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  res.set('x-duration-ms', String(durationMs));

  if (isJsonObjectRecord(payload) && !Object.prototype.hasOwnProperty.call(payload, 'durationMs')) {
    res.status(statusCode).json({
      ...payload,
      durationMs,
    });
    return;
  }

  res.status(statusCode).json(payload);
}

function sendWorkflowErrorWithDuration(res: Response, error: unknown, requestStartedAt: number): void {
  const status =
    typeof error === 'object' && error != null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500;

  if (status >= 500 && !(error instanceof PublishedExecutionAdmissionError)) {
    console.error('Workflow execution failed:', error);
  }
  if (error instanceof PublishedExecutionAdmissionError) {
    res.set('Retry-After', String(error.retryAfterSeconds));
  }

  const errorPayload =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          ...(error instanceof PublishedExecutionAdmissionError ? { code: error.code } : {}),
        }
      : {
          message: String(error),
        };

  sendJsonWithDuration(
    res,
    status,
    {
      error: errorPayload,
    },
    requestStartedAt,
  );
}

function getBearerToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

function isEnvFlagEnabled(value: string | undefined, defaultValue = false): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return defaultValue;
}

export function getWorkflowErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function shouldEmitWorkflowExecutionDebugHeaders(): boolean {
  return isEnvFlagEnabled(process.env.RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS, false);
}

function shouldCollectCodeRunnerTelemetry(): boolean {
  return shouldEmitWorkflowExecutionDebugHeaders() && isManagedCodeRunnerTelemetryEnabled();
}

function getWorkflowExecutionContext(req: Request): WorkflowExecutionContext {
  return {
    headers: {
      type: 'any',
      value: getWorkflowRequestHeaders(req),
    },
  };
}

function getWebAppWorkflowExecutionContext(req: Request | IncomingMessage): WorkflowExecutionContext {
  return {
    headers: {
      type: 'any',
      value: getWorkflowRequestHeaders(req),
    },
  };
}

function setWorkflowExecutionDebugHeaders(
  res: Response,
  executionProject: WorkflowExecutionProject,
  executionMs: number,
): void {
  if (!shouldEmitWorkflowExecutionDebugHeaders() || !executionProject.debug) {
    return;
  }

  res.set('x-workflow-resolve-ms', String(executionProject.debug.resolveMs));
  res.set('x-workflow-materialize-ms', String(executionProject.debug.materializeMs));
  res.set('x-workflow-execute-ms', String(Math.max(0, Math.round(executionMs))));
  res.set('x-workflow-cache', executionProject.debug.cacheStatus);
}

function setCodeRunnerTelemetryHeaders(res: Response, telemetry: ManagedCodeRunnerTelemetry | null): void {
  if (!telemetry || !shouldEmitWorkflowExecutionDebugHeaders() || !isManagedCodeRunnerTelemetryEnabled()) {
    return;
  }

  const snapshot = getManagedCodeRunnerTelemetrySnapshot(telemetry);
  res.set('x-code-runner-calls', String(snapshot.calls));
  res.set('x-code-runner-require-calls', String(snapshot.requireCalls));
  res.set('x-code-runner-prepare-calls', String(snapshot.prepareCalls));
  res.set('x-code-runner-compile-calls', String(snapshot.compileCalls));
  res.set('x-code-runner-compile-ms', String(snapshot.compileMs));
  res.set('x-code-runner-execute-ms', String(snapshot.executeMs));
  res.set('x-code-runner-prepare-ms', String(snapshot.prepareMs));
  res.set('x-code-runner-cache-hits', String(snapshot.cacheHits));
  res.set('x-code-runner-cache-misses', String(snapshot.cacheMisses));
  res.set('x-code-runner-cache', snapshot.cacheEnabled ? `enabled;size=${snapshot.cacheSize}` : 'disabled');
  res.set('x-code-runner-force-prepare', snapshot.forcePrepareEveryCode ? 'true' : 'false');
}

function requirePublishedWorkflowApiKey(req: Request, options?: { capacityEndpointName?: string }): void {
  const isWorkflowKeyRequired = readWorkflowEndpointAuthSettingsSync().requireBearerAuth;
  if (!isWorkflowKeyRequired) {
    return;
  }

  if (isTrustedClientRequest(req)) {
    return;
  }

  const expectedApiKey = process.env.RIVET_KEY?.trim();
  if (!expectedApiKey) {
    throw createHttpError(500, 'Workflow execution key is required but RIVET_KEY is not configured');
  }

  const providedApiKey = getBearerToken(req);
  const capacityCapabilityValid =
    options?.capacityEndpointName !== undefined &&
    isWorkflowCapacityCapabilityValid({
      token: providedApiKey,
      signingKey: expectedApiKey,
      endpointName: options.capacityEndpointName,
    });
  if (!providedApiKey || (providedApiKey !== expectedApiKey && !capacityCapabilityValid)) {
    throw createHttpError(401, 'Unauthorized');
  }
}

function authorizePublishedWorkflowBeforeBody(req: Request, res: Response, next: NextFunction): void {
  try {
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }
    // Only the immutable published route recognizes a short-lived capacity
    // capability. This must happen before JSON parsing, not merely before run.
    requirePublishedWorkflowApiKey(req, { capacityEndpointName: endpointName });
    next();
  } catch (error) {
    closeResponseConnectionAfterFlush(res, req);
    sendWorkflowErrorWithDuration(res, error, performance.now());
  }
}

function authorizeLatestWorkflowBeforeBody(req: Request, res: Response, next: NextFunction): void {
  try {
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }
    requirePublishedWorkflowApiKey(req);
    next();
  } catch (error) {
    closeResponseConnectionAfterFlush(res, req);
    sendWorkflowErrorWithDuration(res, error, performance.now());
  }
}

function requirePublishedWebAppUiGate(req: Request): void {
  if (isServerUiAuthRequestAllowed(req)) {
    return;
  }

  throw createHttpError(401, 'Unauthorized');
}

type WebAppRequestKind = 'html' | 'json' | 'action';

const WEB_APP_OAUTH_AUTH_ACTION_QUERY = 'auth_action';
const WEB_APP_OAUTH_LOGIN_ACTION = 'login';
const WEB_APP_OAUTH_PROMPT_QUERY = 'auth_prompt';

function getWebAppRequestReturnTo(req: Request): string {
  return req.originalUrl || req.url || '/';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getWebAppAuthError(req: Request): string {
  return typeof req.query.auth_error === 'string' ? req.query.auth_error : '';
}

function getWebAppAuthRetryPath(req: Request): string {
  const parsed = new URL(getWebAppRequestReturnTo(req), 'http://rivet.local');
  parsed.searchParams.delete('auth_error');
  parsed.searchParams.delete(WEB_APP_OAUTH_AUTH_ACTION_QUERY);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

function getWebAppCleanReturnTo(req: Request): string {
  const parsed = new URL(getWebAppAuthRetryPath(req), 'http://rivet.local');
  parsed.searchParams.delete(WEB_APP_OAUTH_PROMPT_QUERY);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

function getWebAppOAuthLoginPath(req: Request): string {
  const parsed = new URL(getWebAppAuthRetryPath(req), 'http://rivet.local');
  parsed.searchParams.set(WEB_APP_OAUTH_AUTH_ACTION_QUERY, WEB_APP_OAUTH_LOGIN_ACTION);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

function getWebAppOAuthLogoutPath(
  returnTo: string,
  options: {
    selectAccount?: boolean;
  } = {},
): string {
  const params = new URLSearchParams({ return_to: returnTo });
  if (options.selectAccount) {
    params.set('select_account', '1');
  }
  return `${getPublishedWebAppsBasePath()}/auth/logout?${params.toString()}`;
}

function getWebAppCurrentLogoutPath(req: Request): string {
  return getWebAppOAuthLogoutPath(getWebAppCleanReturnTo(req), { selectAccount: true });
}

function getWebAppAuthErrorMessage(errorCode: string): string {
  if (errorCode === 'oauth_profile') {
    return 'OAuth sign-in succeeded, but the profile response did not include the configured email claim.';
  }

  if (errorCode === 'oauth_token') {
    return 'OAuth sign-in could not exchange the authorization code for an access token.';
  }

  if (errorCode === 'oauth_state') {
    return 'The OAuth sign-in session expired. Try signing in again.';
  }

  if (errorCode === 'oauth_denied') {
    return 'The OAuth provider rejected the sign-in request.';
  }

  return 'OAuth sign-in failed. Try signing in again.';
}

function renderWebAppAuthStatusHtml(options: {
  title: string;
  message: string;
  code?: string;
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}): string {
  const secondaryLink =
    options.secondaryHref && options.secondaryLabel
      ? `<a class="secondary" href="${escapeHtml(options.secondaryHref)}">${escapeHtml(options.secondaryLabel)}</a>`
      : '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101114; color: #f4f4f5; }
  main { width: min(440px, calc(100vw - 32px)); border: 1px solid #333741; border-radius: 8px; background: #1d1f24; padding: 24px; box-shadow: 0 24px 80px rgb(0 0 0 / 0.38); }
  h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.2; }
  p { margin: 0 0 18px; color: #c8c8cf; line-height: 1.5; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  a { display: inline-flex; align-items: center; min-height: 34px; padding: 0 13px; border-radius: 6px; background: #2f6fed; color: white; font-weight: 650; text-decoration: none; }
  a.secondary { background: transparent; color: #d6d8df; border: 1px solid #3d414b; }
  code { color: #d6d8df; }
</style>
<main>
  <h1>${escapeHtml(options.title)}</h1>
  <p>${escapeHtml(options.message)}</p>
  ${options.code ? `<p>Error code: <code>${escapeHtml(options.code)}</code></p>` : ''}
  <div class="actions">
    <a href="${escapeHtml(options.primaryHref)}">${escapeHtml(options.primaryLabel)}</a>
    ${secondaryLink}
  </div>
</main>`;
}

function renderWebAppAuthErrorHtml(errorCode: string, retryPath: string, logoutPath: string): string {
  return renderWebAppAuthStatusHtml({
    title: 'Web app sign-in failed',
    message: getWebAppAuthErrorMessage(errorCode),
    code: errorCode || 'oauth_failed',
    primaryHref: retryPath,
    primaryLabel: 'Try again',
    secondaryHref: logoutPath,
    secondaryLabel: 'Sign out',
  });
}

function renderWebAppLoginRequiredHtml(req: Request): string {
  return renderWebAppAuthStatusHtml({
    title: 'Sign in required',
    message: 'Sign in to open this Rivet web app.',
    primaryHref: getWebAppOAuthLoginPath(req),
    primaryLabel: 'Sign in',
  });
}

function renderWebAppUiGatePromptHtml(req: Request): string {
  const returnTo = escapeHtml(sanitizeUiAuthReturnTo(getWebAppRequestReturnTo(req)));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Rivet Access</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, rgba(96, 165, 250, 0.18), transparent 34%), linear-gradient(180deg, #121419 0%, #0b0d11 100%); font-family: Georgia, "Times New Roman", serif; color: #f3f4f6; }
      .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(10px); }
      .modal { position: relative; width: min(440px, calc(100vw - 32px)); padding: 28px; border-radius: 18px; background: rgba(18, 20, 25, 0.94); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42); }
      h1 { margin: 0 0 10px; font-size: 31px; line-height: 1.05; }
      p { margin: 0 0 18px; font-size: 16px; line-height: 1.55; color: rgba(243, 244, 246, 0.78); }
      form { display: grid; gap: 12px; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      label { font-size: 14px; color: rgba(243, 244, 246, 0.84); }
      input { width: 100%; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; background: rgba(255, 255, 255, 0.04); color: inherit; padding: 12px 14px; font: inherit; }
      input:focus { outline: 2px solid rgba(96, 165, 250, 0.75); outline-offset: 2px; }
      button { border: none; border-radius: 12px; background: #f3f4f6; color: #111827; padding: 12px 16px; font: inherit; font-weight: 700; cursor: pointer; }
      .hint { margin-top: 12px; font-size: 13px; color: rgba(243, 244, 246, 0.52); }
    </style>
  </head>
  <body>
    <div class="overlay" aria-hidden="true"></div>
    <main class="modal" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h1 id="gate-title">Enter Access Key</h1>
      <p>Provide the Rivet key to open this web app.</p>
      <form method="post" action="/__rivet_auth">
        <label for="gate-username" class="sr-only">Username</label>
        <input id="gate-username" class="sr-only" name="username" type="text" value="Rivet" autocomplete="username" required>
        <label for="gate-key">Access key</label>
        <input id="gate-key" name="key" type="password" autocomplete="current-password" autofocus required>
        <input name="return_to" type="hidden" value="${returnTo}">
        <button type="submit">Continue</button>
      </form>
      <div class="hint">Token-free hosts still bypass this prompt automatically.</div>
    </main>
  </body>
</html>`;
}

function renderWebAppAccessDeniedHtml(email: string, logoutPath: string): string {
  return renderWebAppAuthStatusHtml({
    title: 'Web app access denied',
    message: `You are signed in as ${email}, but this web app does not allow that email.`,
    code: 'oauth_forbidden',
    primaryHref: logoutPath,
    primaryLabel: 'Sign out and choose another account',
  });
}

function renderWebAppOriginDeniedHtml(req: Request): string {
  const options = {
    title: 'Web app request blocked',
    message: 'The request did not come from the expected Rivet server origin.',
    code: 'origin_forbidden',
    primaryHref: getWebAppAuthRetryPath(req),
    primaryLabel: 'Try again',
  };

  return getWebAppAuthMode() === 'oauth'
    ? renderWebAppAuthStatusHtml({
        ...options,
        secondaryHref: getWebAppCurrentLogoutPath(req),
        secondaryLabel: 'Sign out',
      })
    : renderWebAppAuthStatusHtml(options);
}

function addWebAppOAuthLogoutLink(html: string, logoutPath: string): string {
  const logoutHtml = `<style>
  .rivet-web-app-auth-logout { position: fixed; top: 12px; right: 12px; z-index: 2147483647; display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border: 1px solid rgb(255 255 255 / 0.18); border-radius: 6px; background: rgb(20 20 24 / 0.82); color: #f4f4f5; font: 600 12px/1 Inter, ui-sans-serif, system-ui, sans-serif; text-decoration: none; box-shadow: 0 8px 30px rgb(0 0 0 / 0.25); backdrop-filter: blur(8px); }
  .rivet-web-app-auth-logout:hover { background: rgb(40 42 48 / 0.94); }
</style>
<a id="rivet-web-app-auth-logout" class="rivet-web-app-auth-logout" href="${escapeHtml(logoutPath)}">Sign out</a>`;
  const closingBodyIndex = html.toLowerCase().lastIndexOf('</body>');
  return closingBodyIndex >= 0
    ? `${html.slice(0, closingBodyIndex)}${logoutHtml}${html.slice(closingBodyIndex)}`
    : `${html}${logoutHtml}`;
}

function sendWebAppAuthJsonError(
  res: Response,
  requestStartedAt: number,
  statusCode: number,
  message: string,
  code: string,
): void {
  sendJsonWithDuration(res, statusCode, { error: message, code }, requestStartedAt);
}

function startWebAppOAuthLogin(req: Request, res: Response): void {
  const redirect = createWebAppOAuthAuthorizationRedirect(
    req,
    getWebAppCleanReturnTo(req),
    req.query[WEB_APP_OAUTH_PROMPT_QUERY] === WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT
      ? { prompt: WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT }
      : {},
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Set-Cookie', redirect.cookies);
  res.redirect(302, redirect.location);
}

function isWebAppOAuthLoginRequest(req: Request): boolean {
  return req.query[WEB_APP_OAUTH_AUTH_ACTION_QUERY] === WEB_APP_OAUTH_LOGIN_ACTION;
}

function getForwardedRequestProtocol(req: Request): string {
  if (!isTrustedProxyRequest(req)) {
    return req.protocol || 'http';
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwardedProto?.toLowerCase() || req.protocol || 'http';
}

function getForwardedRequestHost(req: Request): string {
  if (!isTrustedProxyRequest(req)) {
    return req.get('host') || '';
  }

  return req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || '';
}

function isWebAppBrowserRequestOriginAllowed(req: Request, requestKind: WebAppRequestKind): boolean {
  const originHeader = req.get('origin')?.trim();
  if (originHeader) {
    try {
      const requestHost = getForwardedRequestHost(req);
      if (!requestHost) {
        return false;
      }

      const requestOrigin = new URL(`${getForwardedRequestProtocol(req)}://${requestHost}`);
      const providedOrigin = new URL(originHeader);
      return providedOrigin.origin === requestOrigin.origin;
    } catch {
      return false;
    }
  }

  const fetchSite = req.get('sec-fetch-site')?.trim().toLowerCase();
  return requestKind === 'html' || fetchSite !== 'cross-site';
}

function getIncomingHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function getWebAppSocketRequestOrigin(req: IncomingMessage): string | null {
  const trustedProxy = isTrustedProxyRequest(req);
  const protocol = trustedProxy
    ? getIncomingHeader(req, 'x-forwarded-proto').split(',')[0]?.trim().toLowerCase()
    : (req.socket as { encrypted?: boolean }).encrypted
      ? 'https'
      : 'http';
  const host = trustedProxy
    ? getIncomingHeader(req, 'x-forwarded-host').split(',')[0]?.trim() || getIncomingHeader(req, 'host')
    : getIncomingHeader(req, 'host');
  if (!protocol || !host) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function isWebAppSocketOriginAllowed(req: IncomingMessage): boolean {
  const requestOrigin = getWebAppSocketRequestOrigin(req);
  const origin = getIncomingHeader(req, 'origin').trim();
  if (!requestOrigin || !origin) return false;
  try {
    return new URL(origin).origin === requestOrigin;
  } catch {
    return false;
  }
}

function prepareWebAppRejection(req: Request, res: Response, requestKind: WebAppRequestKind): void {
  if (requestKind === 'action') {
    closeResponseConnectionAfterFlush(res, req);
  }
}

function authorizeWebAppRequestBeforeResolve(
  req: Request,
  res: Response,
  requestStartedAt: number,
  requestKind: WebAppRequestKind,
): boolean {
  const mode = getWebAppAuthMode();
  if (mode === 'none') {
    return true;
  }

  if (!isWebAppBrowserRequestOriginAllowed(req, requestKind)) {
    prepareWebAppRejection(req, res, requestKind);
    if (requestKind === 'html') {
      sendHtmlWithDuration(res, 403, renderWebAppOriginDeniedHtml(req), requestStartedAt);
    } else {
      sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Cross-origin web app request denied', 'origin_forbidden');
    }
    return false;
  }

  // Network trust bypasses authentication, not the protected browser surface's
  // origin checks. The explicitly public mode above keeps its existing policy.
  if (isTrustedClientRequest(req)) return true;

  if (mode === 'ui-gate') {
    try {
      requirePublishedWebAppUiGate(req);
      return true;
    } catch (error) {
      if (requestKind === 'html' && (error as { status?: unknown }).status === 401) {
        prepareWebAppRejection(req, res, requestKind);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        sendHtmlWithDuration(res, 401, renderWebAppUiGatePromptHtml(req), requestStartedAt);
        return false;
      }

      // The action route has not admitted its JSON body yet. Let the shared
      // error formatter keep this legacy error response, but first make the
      // connection non-reusable so the client cannot continue that body.
      prepareWebAppRejection(req, res, requestKind);
      throw error;
    }
  }

  const session = readWebAppOAuthSession(req);
  if (session) {
    return true;
  }

  const authError = getWebAppAuthError(req);
  if (requestKind === 'html' && authError) {
    prepareWebAppRejection(req, res, requestKind);
    sendHtmlWithDuration(
      res,
      401,
      renderWebAppAuthErrorHtml(authError, getWebAppAuthRetryPath(req), getWebAppCurrentLogoutPath(req)),
      requestStartedAt,
    );
    return false;
  }

  if (requestKind === 'html' && isWebAppOAuthLoginRequest(req)) {
    prepareWebAppRejection(req, res, requestKind);
    startWebAppOAuthLogin(req, res);
    return false;
  }

  if (requestKind === 'html') {
    prepareWebAppRejection(req, res, requestKind);
    sendHtmlWithDuration(res, 401, renderWebAppLoginRequiredHtml(req), requestStartedAt);
    return false;
  }

  prepareWebAppRejection(req, res, requestKind);
  sendWebAppAuthJsonError(res, requestStartedAt, 401, 'OAuth login required', 'oauth_required');
  return false;
}

function authorizeResolvedWebAppRequest(
  req: Request,
  res: Response,
  requestStartedAt: number,
  executionProject: WorkflowExecutionProject,
  requestKind: WebAppRequestKind,
): boolean {
  if (getWebAppAuthMode() !== 'oauth' || isTrustedClientRequest(req)) {
    return true;
  }

  const session = readWebAppOAuthSession(req);
  if (isWebAppOAuthSessionAllowed(session, executionProject.webAppAllowedEmails ?? [])) {
    return true;
  }

  if (requestKind === 'html') {
    prepareWebAppRejection(req, res, requestKind);
    sendHtmlWithDuration(
      res,
      403,
      renderWebAppAccessDeniedHtml(session?.email ?? 'this account', getWebAppCurrentLogoutPath(req)),
      requestStartedAt,
    );
    return false;
  }

  prepareWebAppRejection(req, res, requestKind);
  sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Forbidden', 'oauth_forbidden');
  return false;
}

function encodeUrlPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

export type WebAppRouteKind = 'published' | 'latest';

export function getWebAppBasePath(routeKind: WebAppRouteKind, slug: string): string {
  const basePath = routeKind === 'published' ? getPublishedWebAppsBasePath() : getLatestWebAppsBasePath();

  return `${basePath}/${encodeUrlPathSegment(slug)}`;
}

function getLatestRemoteDebuggerForExecution(options?: { enableRemoteDebugger?: boolean }) {
  return options?.enableRemoteDebugger && isLatestWorkflowRemoteDebuggerEnabled()
    ? maybeGetLatestWorkflowRemoteDebugger()
    : undefined;
}

export function resolveWebAppUiGraph(executionProject: WorkflowExecutionProject): UiGraph | null {
  const uiGraphId = executionProject.webAppUiGraphId;

  return uiGraphId
    ? executionProject.project.uiGraphs?.[uiGraphId as keyof typeof executionProject.project.uiGraphs] ?? null
    : null;
}

function sendHtmlWithDuration(res: Response, statusCode: number, html: string, requestStartedAt: number): void {
  const durationMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('x-duration-ms', String(durationMs));
  res.status(statusCode).type('html').send(html);
}

function sendWebAppActionErrorWithDuration(res: Response, error: unknown, requestStartedAt: number): void {
  const status =
    error instanceof RivetWebAppActionHttpError || error instanceof PublishedExecutionAdmissionError
      ? error.status
      : 500;
  if (status >= 500 && !(error instanceof PublishedExecutionAdmissionError)) {
    console.error('Rivet web app action failed:', error);
  }
  if (error instanceof PublishedExecutionAdmissionError) {
    res.set('Retry-After', String(error.retryAfterSeconds));
  }
  const message =
    status >= 500 && !(error instanceof RivetWebAppActionHttpError || error instanceof PublishedExecutionAdmissionError)
      ? 'Internal server error'
      : getWorkflowErrorMessage(error);
  const code =
    error instanceof RivetWebAppActionHttpError || error instanceof PublishedExecutionAdmissionError
      ? error.code
      : undefined;
  sendJsonWithDuration(
    res,
    status,
    {
      error: message,
      ...(code ? { code } : {}),
    },
    requestStartedAt,
  );
}

function acquirePublishedExecutionPermit(surface: PublishedExecutionSurface): PublishedExecutionPermit {
  const result = getPublishedExecutionAdmission().acquire(surface);
  if (result.kind === 'accepted') return result.permit;
  throw toPublishedExecutionAdmissionError(result);
}

function getWebAppActionComponentId(body: Record<string, unknown>): string {
  const componentId = body.componentId;
  if (typeof componentId !== 'string' || !componentId) {
    throw new RivetWebAppActionHttpError('Invalid componentId.', 400);
  }

  return componentId;
}

function getOptionalWebAppActionRevisionKey(body: Record<string, unknown>): string | undefined {
  const revisionKey = body.revisionKey;
  if (revisionKey == null) {
    return undefined;
  }

  if (typeof revisionKey !== 'string') {
    throw new RivetWebAppActionHttpError('Invalid revisionKey.', 400);
  }

  return revisionKey;
}

type WorkflowExecutionRecordingSnapshot = {
  recorder: ExecutionRecorder | null;
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
};

type WebAppActionExecutionSnapshot = WorkflowExecutionRecordingSnapshot & {
  result?: RivetWebAppActionResult;
  executionError?: unknown;
  executionIdentity: WorkflowRecordingExecutionIdentity;
};
type RecordingEvidenceAvailability = 'available' | 'disabled' | 'queue-dropped' | 'persistence-failed';

function reportLLMProfileHealthRecordingOutcome(
  executionIdentity: WorkflowRecordingExecutionIdentity | undefined,
  availability: RecordingEvidenceAvailability,
  recordingId?: string,
): Promise<void> {
  const correlationId = executionIdentity?.correlationId;
  if (!correlationId) return Promise.resolve();
  return trackLLMProfileHealthRecordingOutcome(
    getLLMProfileHealthStore()
      .then((store) => store.recordRecordingOutcome({ correlationId, availability, recordingId }))
      .catch((error) => {
        console.error('[llm-profile-health] Failed to resolve recording evidence:', error);
      }),
  );
}

function getWebAppActionState(body: Record<string, unknown>): Record<string, unknown> {
  const state = body.state;
  if (state == null) {
    return {};
  }

  if (isJsonObjectRecord(state)) {
    return state;
  }

  throw new RivetWebAppActionHttpError('Invalid action state.', 400);
}

function getWebAppActionStorage(body: Record<string, unknown>): Record<string, unknown> {
  const storage = body.storage;
  if (storage == null) {
    return {};
  }

  if (isJsonObjectRecord(storage)) {
    return storage;
  }

  throw new RivetWebAppActionHttpError('Invalid action storage.', 400);
}

function validateWebAppActionRevisionKey(
  requestRevisionKey: string | undefined,
  revisionKey: string | undefined,
): void {
  if (revisionKey != null && requestRevisionKey !== revisionKey) {
    throw new RivetWebAppActionHttpError('Rivet web app revision mismatch.', 409, 'revision_mismatch');
  }
}

async function runRecordedWebAppAction(
  executionProject: WorkflowExecutionProject,
  uiGraph: UiGraph,
  req: Request,
  codeRunnerTelemetry: ManagedCodeRunnerTelemetry | null,
  options: {
    abortSignal?: AbortSignal;
    enableRemoteDebugger?: boolean;
    webAppSlug: string;
  },
): Promise<WebAppActionExecutionSnapshot> {
  const componentId = getWebAppActionComponentId(req.body);
  const requestRevisionKey = getOptionalWebAppActionRevisionKey(req.body);
  const actionState = getWebAppActionState(req.body);
  const actionStorage = getWebAppActionStorage(req.body);
  validateWebAppActionRevisionKey(requestRevisionKey, executionProject.revisionKey);

  const resolvedComponentId = componentId as UiComponentId;
  const component = getUiGraphActionComponent(uiGraph, resolvedComponentId);
  if (!component) {
    throw new Error('UI action component not found.');
  }

  if (component.action.type !== 'runGraph') {
    throw new Error(`Unsupported UI action type: ${component.action.type}`);
  }

  if (!component.action.graphId) {
    throw new Error('This UI action is not connected to a graph.');
  }
  const executionIdentity = createWebAppActionRecordingIdentity(
    executionProject,
    uiGraph,
    component,
    options.webAppSlug,
    getRequestCorrelationId(req),
  );

  const rawInputs = resolveUiGraphActionInputs(component.action, actionState);
  const processorOptions = await createWebAppProcessorOptions(executionProject, req, codeRunnerTelemetry, {
    enableRemoteDebugger: options.enableRemoteDebugger,
    llmProfileHealthExecutionCorrelationId: executionIdentity.correlationId,
  });
  const inputs = (processorOptions.inputs ??
    Object.fromEntries(Object.entries(rawInputs).map(([key, value]) => [key, jsonValueToDataValue(value)]))) as Record<
    string,
    LooseDataValue
  >;
  const browserStoredValues = processorOptions.storedValueStore
    ? undefined
    : createRivetStoredValueSnapshotStore(actionStorage);
  const processor = createProcessor(executionProject.project, {
    ...processorOptions,
    abortSignal: options.abortSignal,
    graph: component.action.graphId,
    inputs,
    storedValueStore: processorOptions.storedValueStore ?? browserStoredValues!.store,
  });
  const recorder = isWorkflowRecordingEnabled() ? new ExecutionRecorder(getWorkflowExecutionRecorderOptions()) : null;
  recorder?.record(processor.processor);

  let result: RivetWebAppActionResult | undefined;
  let executionError: unknown;
  let status: WebAppActionExecutionSnapshot['status'] = 'succeeded';
  let errorMessage: string | undefined;
  let durationMs = 0;
  const executionStartedAt = performance.now();

  try {
    const outputs = (await processor.run()) as Record<string, DataValue>;
    status = getWorkflowRecordingStatusFromOutputs(outputs);
    result = {
      outputs,
      statePatch: resolveUiGraphActionOutputStatePatch(component.action, outputs),
      storagePatch: browserStoredValues?.getPatch() ?? {},
    };
  } catch (error) {
    status = 'failed';
    errorMessage = getWorkflowErrorMessage(error);
    executionError = error;
  } finally {
    durationMs = performance.now() - executionStartedAt;
  }

  return {
    recorder,
    status,
    durationMs,
    errorMessage,
    result,
    executionError,
    executionIdentity,
  };
}

async function resolveWebAppExecutionProject(
  req: Request,
  requestStartedAt: number,
  res: Response,
  routeKind: WebAppRouteKind,
  requestKind: WebAppRequestKind,
  options?: { abortSignal?: AbortSignal; initialAuthorizationAlreadyChecked?: boolean },
): Promise<{ slug: string; executionProject: WorkflowExecutionProject } | null> {
  if (options?.abortSignal?.aborted) {
    return null;
  }

  if (
    !options?.initialAuthorizationAlreadyChecked &&
    !authorizeWebAppRequestBeforeResolve(req, res, requestStartedAt, requestKind)
  ) {
    return null;
  }

  const slug = normalizeStoredEndpointName(String(req.params.slug ?? ''));
  if (!slug) {
    throw badRequest('Web app slug is required');
  }

  const executionProject =
    routeKind === 'published'
      ? await resolvePublishedWebAppExecutionProjectWithBackend(slug)
      : await resolveLatestWebAppExecutionProjectWithBackend(slug);
  if (options?.abortSignal?.aborted) {
    return null;
  }
  if (!executionProject) {
    prepareWebAppRejection(req, res, requestKind);
    sendJsonWithDuration(
      res,
      404,
      { error: routeKind === 'published' ? 'Published Rivet web app not found' : 'Latest Rivet web app not found' },
      requestStartedAt,
    );
    return null;
  }

  if (options?.abortSignal?.aborted) {
    return null;
  }
  if (!authorizeResolvedWebAppRequest(req, res, requestStartedAt, executionProject, requestKind)) {
    return null;
  }

  return { slug, executionProject };
}

type PreparedWebAppAction = {
  bodyLimitBytes: number;
  requestStartedAt: number;
  resolved: { slug: string; executionProject: WorkflowExecutionProject };
  uiGraph: UiGraph;
};

const preparedWebAppActions = new WeakMap<Request, PreparedWebAppAction>();

function getPreparedWebAppActionBodyLimit(req: Request): number {
  const prepared = preparedWebAppActions.get(req);
  if (!prepared) {
    throw createHttpError(500, 'Web app action authorization was not prepared.');
  }
  return prepared.bodyLimitBytes;
}

function acquireWebAppActionPreflight(): (() => void) | null {
  if (activeWebAppActionPreflights >= MAX_CONCURRENT_WEB_APP_ACTION_PREFLIGHTS) {
    return null;
  }

  activeWebAppActionPreflights += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeWebAppActionPreflights = Math.max(0, activeWebAppActionPreflights - 1);
  };
}

export function awaitWebAppActionPreflight<T>(
  operation: Promise<T>,
  abortController: AbortController,
  timeoutMs = WEB_APP_ACTION_PREFLIGHT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      abortController.abort();
      reject(
        createHttpError(503, 'Web app action preparation timed out.', {
          expose: true,
          code: 'web_app_action_preflight_timeout',
          retryAfterSeconds: 1,
          closeConnection: true,
        }),
      );
    }, timeoutMs);
    timeout.unref();

    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function prepareWebAppActionBeforeBody(routeKind: WebAppRouteKind) {
  return asyncHandler(async (req, res, next) => {
    const requestStartedAt = performance.now();
    if (!authorizeWebAppRequestBeforeResolve(req, res, requestStartedAt, 'action')) {
      return;
    }

    // Capture the setting before project resolution and reuse it for parsing.
    // An action must not be authorized against one request snapshot and parsed
    // against a later limit if Settings changes while its preflight is running.
    const bodyLimitBytes = readRuntimeLimitSettingsSync().webAppActionRequestLimitBytes;

    const releasePreflight = acquireWebAppActionPreflight();
    if (!releasePreflight) {
      closeResponseConnectionAfterFlush(res, req);
      res.setHeader('Retry-After', '1');
      sendJsonWithDuration(
        res,
        503,
        {
          error: 'Web app action preparation is temporarily exhausted.',
          code: 'web_app_action_preflight_capacity_exhausted',
        },
        requestStartedAt,
      );
      return;
    }

    const preflightAbortController = new AbortController();
    let responseClosed = false;
    const markResponseClosed = () => {
      responseClosed = true;
      preflightAbortController.abort();
    };
    res.once('close', markResponseClosed);

    try {
      const resolution = resolveWebAppExecutionProject(req, requestStartedAt, res, routeKind, 'action', {
        initialAuthorizationAlreadyChecked: true,
        abortSignal: preflightAbortController.signal,
      });
      // Keep the permit until the storage work itself settles. A deadline
      // bounds the client request, while this retained permit prevents a hung
      // backend from letting repeated timeouts create unbounded preflights.
      void resolution.then(releasePreflight, releasePreflight);
      const resolved = await awaitWebAppActionPreflight(resolution, preflightAbortController);
      if (responseClosed || res.destroyed) {
        return;
      }
      if (!resolved) {
        return;
      }

      const uiGraph = resolveWebAppUiGraph(resolved.executionProject);
      if (responseClosed || res.destroyed) {
        return;
      }
      if (!uiGraph) {
        closeResponseConnectionAfterFlush(res, req);
        sendJsonWithDuration(res, 404, { error: 'Rivet web app not found' }, requestStartedAt);
        return;
      }

      preparedWebAppActions.set(req, { bodyLimitBytes, requestStartedAt, resolved, uiGraph });
      const clearPreparedAction = () => preparedWebAppActions.delete(req);
      res.once('finish', clearPreparedAction);
      res.once('close', clearPreparedAction);
      next();
    } catch (error) {
      // Any exception here happens before the action parser has consumed the
      // body. Route-specific denials send their own response above; unexpected
      // preparation failures still need the same non-reusable connection
      // boundary before the application error handler formats them.
      closeResponseConnectionAfterFlush(res, req);
      throw error;
    } finally {
      res.off('close', markResponseClosed);
    }
  });
}

export type WebAppSocketExecutionResolution =
  | {
      executionProject: WorkflowExecutionProject;
      ownerScope: string;
      /** Fast request/session check used before every incoming socket frame. */
      isAuthorized(): boolean;
      /** Shared lookup key; unlike credentials, the app policy is user-independent. */
      accessPolicyLookupKey: string;
      /** Targeted local mutation/managed LISTEN invalidation key. */
      accessPolicyInvalidationKey: string;
      /** Reads only the current app binding and access list, never project contents. */
      readCurrentAccessPolicy(): Promise<WebAppAccessPolicy | null>;
      /** Combines the opening identity with a freshly read app policy. */
      evaluateCurrentAccessPolicy(policy: WebAppAccessPolicy | null): WebAppSocketAuthorizationStatus;
      uiGraph: UiGraph;
    }
  | {
      code: string;
      message: string;
    statusCode: number;
  };

/**
 * `revoked` means the credentials that opened the socket are no longer valid.
 * `policy-revoked` means those credentials remain valid, but the current web
 * app binding or its allowlist no longer permits this app. The distinction lets
 * an already accepted action finish using its existing browser-storage RPC
 * channel while preventing every new operation immediately.
 */
export type WebAppSocketAuthorizationStatus = 'authorized' | 'revoked' | 'policy-revoked' | 'unavailable';

/**
 * WebSocket upgrades cannot use the HTML redirect/prompt flow. They share the
 * normal web-app policy, but require a strict Origin header before accepting a
 * browser socket.
 */
export async function resolveWebAppSocketExecution(
  req: IncomingMessage,
  routeKind: WebAppRouteKind,
  rawSlug: string,
): Promise<WebAppSocketExecutionResolution> {
  if (!isWebAppSocketOriginAllowed(req)) {
    return { statusCode: 403, code: 'origin_forbidden', message: 'Cross-origin web app request denied' };
  }

  const mode = getWebAppAuthMode();
  const trustedClient = isTrustedClientRequest(req);
  if (!trustedClient && mode === 'ui-gate' && !isServerUiAuthRequestAllowed(req)) {
    return { statusCode: 401, code: 'ui_gate_required', message: 'Rivet access key required' };
  }

  const oauthSession = !trustedClient && mode === 'oauth' ? readWebAppOAuthSession(req) : null;
  if (!trustedClient && mode === 'oauth' && !oauthSession) {
    return { statusCode: 401, code: 'oauth_required', message: 'OAuth login required' };
  }

  const slug = normalizeStoredEndpointName(rawSlug);
  if (!slug) {
    return { statusCode: 400, code: 'invalid_slug', message: 'Web app slug is required' };
  }

  const executionProject =
    routeKind === 'published'
      ? await resolvePublishedWebAppExecutionProjectWithBackend(slug)
      : await resolveLatestWebAppExecutionProjectWithBackend(slug);
  if (!executionProject) {
    return {
      statusCode: 404,
      code: 'not_found',
      message: routeKind === 'published' ? 'Published Rivet web app not found' : 'Latest Rivet web app not found',
    };
  }

  const uiGraph = resolveWebAppUiGraph(executionProject);
  if (!uiGraph) {
    return { statusCode: 404, code: 'not_found', message: 'Rivet web app not found' };
  }

  let principal = trustedClient ? 'trusted-client' : mode;
  if (oauthSession) {
    try {
      principal = `oauth:${getWebAppOAuthSessionOwnerKey(oauthSession)}`;
    } catch {
      return { statusCode: 401, code: 'oauth_required', message: 'OAuth login required' };
    }
  }

  const isBaseAuthorized = () => {
    // Keep the identity scope fixed for the life of this socket. A client that
    // later appears trusted must reconnect rather than acquiring a new scope.
    if (isTrustedClientRequest(req) !== trustedClient) return false;
    if (trustedClient) return true;
    const currentMode = getWebAppAuthMode();
    if (currentMode !== mode) return false;
    if (mode === 'ui-gate') return isServerUiAuthRequestAllowed(req);
    if (mode === 'oauth') return readWebAppOAuthSession(req) != null;
    return true;
  };

  const readCurrentAccessPolicy = () => resolveWebAppAccessPolicy(slug, executionProject.projectVirtualPath);
  const evaluateCurrentAccessPolicy = (policy: WebAppAccessPolicy | null): WebAppSocketAuthorizationStatus => {
    if (!isBaseAuthorized()) return 'revoked';
    if (
      policy == null ||
      policy.projectVirtualPath !== executionProject.projectVirtualPath ||
      policy.uiGraphId !== executionProject.webAppUiGraphId ||
      policy.bindingId !== executionProject.webAppBindingId
    ) {
      return 'policy-revoked';
    }
    if (trustedClient || mode !== 'oauth') return 'authorized';
    return isWebAppOAuthSessionAllowed(readWebAppOAuthSession(req), policy.allowedEmails)
      ? 'authorized'
      : 'policy-revoked';
  };
  const accessPolicyInvalidationKey = executionProject.webAppPolicyInvalidationKey ??
    `web-app:${routeKind}:${executionProject.projectVirtualPath}`;

  return {
    executionProject,
    uiGraph,
    isAuthorized: isBaseAuthorized,
    accessPolicyLookupKey: `${accessPolicyInvalidationKey}\0${slug}`,
    accessPolicyInvalidationKey,
    readCurrentAccessPolicy,
    evaluateCurrentAccessPolicy,
    ownerScope: [principal, routeKind, slug, executionProject.revisionKey].join(':'),
  };
}

export function createWebAppSocketFetchRequest(req: IncomingMessage): globalThis.Request {
  const origin = getWebAppSocketRequestOrigin(req) ?? 'http://rivet.local';
  const headers = getWorkflowRequestHeaders(req);
  return new globalThis.Request(new URL(req.url || '/', origin), { headers });
}

export async function createWebAppProcessorOptions(
  executionProject: WorkflowExecutionProject,
  req: Request | IncomingMessage,
  codeRunnerTelemetry: ManagedCodeRunnerTelemetry | null,
  options?: {
    enableRemoteDebugger?: boolean;
    llmProfileHealthExecutionCorrelationId?: string;
  },
): Promise<RivetWebAppProcessorOptions> {
  const remoteDebugger = getLatestRemoteDebuggerForExecution(options);
  const executionEnvironment = await readExecutionEnvironmentVariables();

  return {
    codeRunner: new ManagedCodeRunner(getRootPath(), {
      ...(codeRunnerTelemetry ? { telemetry: codeRunnerTelemetry } : {}),
      executionEnvironment,
    }) as any,
    context: getWebAppWorkflowExecutionContext(req),
    datasetProvider: executionProject.datasetProvider,
    projectPath: executionProject.projectVirtualPath,
    projectReferenceLoader: await createExecutionProjectReferenceLoader(executionProject.projectVirtualPath),
    llmProfileHealthStore: await getLLMProfileHealthStore(),
    ...(options?.llmProfileHealthExecutionCorrelationId == null
      ? {}
      : { llmProfileHealthExecutionCorrelationId: options.llmProfileHealthExecutionCorrelationId }),
    executionEnvironment,
    remoteDebugger,
  };
}

function enqueueExecutionRecording(
  executionProject: WorkflowExecutionProject,
  recording: WorkflowExecutionRecordingSnapshot,
  options: {
    endpointName: string;
    runKind: 'published' | 'latest';
    executionIdentity?: WorkflowRecordingExecutionIdentity;
  },
): void {
  const { project, attachedData, datasetProvider, projectVirtualPath } = executionProject;
  const recorder = recording.recorder;

  if (!recorder) {
    void reportLLMProfileHealthRecordingOutcome(options.executionIdentity, 'disabled');
    return;
  }

  const accepted = enqueueWorkflowExecutionRecordingPersistence(async () => {
    try {
      const executedDatasets = shouldSnapshotWorkflowRecordingDatasets()
        ? await datasetProvider.exportDatasetsForProject(project.metadata.id).catch((error) => {
            console.error('Failed to export workflow datasets for recording:', error);
            return [];
          })
        : [];
      const recordingId = await persistWorkflowExecutionRecordingWithBackend({
        sourceProject: project,
        sourceProjectPath: projectVirtualPath,
        executedProject: project,
        executedAttachedData: attachedData,
        executedDatasets,
        endpointName: options.endpointName,
        recordingSerialized: recorder.serialize(),
        runKind: options.runKind,
        status: recording.status,
        durationMs: recording.durationMs,
        errorMessage: recording.errorMessage,
        executionIdentity: options.executionIdentity,
        onPersisted: async (recordingId) => {
          await reportLLMProfileHealthRecordingOutcome(options.executionIdentity, 'available', recordingId);
        },
      });
      if (recordingId == null) {
        await reportLLMProfileHealthRecordingOutcome(options.executionIdentity, 'disabled');
      }
    } catch (error) {
      await reportLLMProfileHealthRecordingOutcome(options.executionIdentity, 'persistence-failed');
      throw error;
    }
  });
  if (!accepted) {
    void reportLLMProfileHealthRecordingOutcome(options.executionIdentity, 'queue-dropped');
  }
}

export function enqueueWebAppActionRecording(
  executionProject: WorkflowExecutionProject,
  recorder: ExecutionRecorder | null,
  durationMs: number,
  status: 'succeeded' | 'failed' | 'suspicious',
  errorMessage: string | undefined,
  options: {
    endpointName: string;
    runKind: 'published' | 'latest';
    executionIdentity?: WorkflowRecordingExecutionIdentity;
  },
): void {
  enqueueExecutionRecording(executionProject, { recorder, durationMs, status, errorMessage }, options);
}

function getGraphNameAtExecution(
  executionProject: WorkflowExecutionProject,
  graphId: string | undefined,
): string | undefined {
  return graphId
    ? executionProject.project.graphs[graphId as keyof typeof executionProject.project.graphs]?.metadata?.name
    : undefined;
}

function createWorkflowEndpointRecordingIdentity(
  executionProject: WorkflowExecutionProject,
  correlationId: string,
): WorkflowRecordingExecutionIdentity {
  const graphId = executionProject.project.metadata.mainGraphId;
  return {
    surface: 'workflow_endpoint',
    graphId,
    graphName: getGraphNameAtExecution(executionProject, graphId),
    revisionKey: executionProject.revisionKey,
    correlationId,
  };
}

export function createWebAppActionRecordingIdentity(
  executionProject: WorkflowExecutionProject,
  uiGraph: UiGraph,
  component: UiGraphActionComponent,
  webAppSlug: string,
  correlationId: string,
): WorkflowRecordingExecutionIdentity {
  const graphId = component.action.graphId;
  return {
    surface: 'web_app_action',
    graphId,
    graphName: getGraphNameAtExecution(executionProject, graphId),
    revisionKey: executionProject.revisionKey,
    uiGraphId: uiGraph.id,
    uiGraphName: uiGraph.name,
    webAppSlug,
    componentId: component.id,
    componentType: component.type,
    componentLabel: component.type === 'button' ? component.label : 'Chat',
    correlationId,
  };
}

async function executeWorkflowEndpoint(
  executionProject: WorkflowExecutionProject,
  requestStartedAt: number,
  req: Request,
  res: Response,
  options: {
    abortSignal?: AbortSignal;
    enableRemoteDebugger?: boolean;
    endpointName: string;
    runKind: 'published' | 'latest';
  },
): Promise<void> {
  const { project, datasetProvider, projectVirtualPath } = executionProject;
  const projectReferenceLoader = await createExecutionProjectReferenceLoader(projectVirtualPath);
  const remoteDebugger = getLatestRemoteDebuggerForExecution(options);
  const executionEnvironment = await readExecutionEnvironmentVariables();
  const codeRunnerTelemetry = shouldCollectCodeRunnerTelemetry() ? createManagedCodeRunnerTelemetry() : null;
  const executionIdentity = createWorkflowEndpointRecordingIdentity(executionProject, getRequestCorrelationId(req));
  const processor = createProcessor(project, {
    abortSignal: options.abortSignal,
    codeRunner: new ManagedCodeRunner(getRootPath(), {
      ...(codeRunnerTelemetry ? { telemetry: codeRunnerTelemetry } : {}),
      executionEnvironment,
    }) as any,
    projectPath: projectVirtualPath,
    datasetProvider,
    projectReferenceLoader,
    llmProfileHealthStore: await getLLMProfileHealthStore(),
    llmProfileHealthExecutionCorrelationId: executionIdentity.correlationId,
    executionEnvironment,
    remoteDebugger,
    context: getWorkflowExecutionContext(req),
    inputs: getWorkflowRequestInputs(req),
  });
  const recorder = isWorkflowRecordingEnabled() ? new ExecutionRecorder(getWorkflowExecutionRecorderOptions()) : null;
  recorder?.record(processor.processor);

  let recordingStatus: 'succeeded' | 'failed' | 'suspicious' = 'succeeded';
  let recordingErrorMessage: string | undefined;
  let responsePayload: unknown;
  let executionError: unknown;
  let executionDurationMs = 0;
  const executionStartedAt = performance.now();

  try {
    const outputs = await processor.run();
    recordingStatus = getWorkflowRecordingStatusFromOutputs(
      outputs as Record<string, { type?: string; value?: unknown }>,
    );

    responsePayload = getWorkflowResponsePayload(outputs as Record<string, { type?: string; value?: unknown }>);
  } catch (error) {
    recordingStatus = 'failed';
    recordingErrorMessage = getWorkflowErrorMessage(error);
    executionError = error;
  } finally {
    executionDurationMs = performance.now() - executionStartedAt;
  }

  enqueueExecutionRecording(
    executionProject,
    {
      recorder,
      status: recordingStatus,
      durationMs: executionDurationMs,
      errorMessage: recordingErrorMessage,
    },
    {
      endpointName: options.endpointName,
      runKind: options.runKind,
      executionIdentity,
    },
  );

  if (executionError) {
    setWorkflowExecutionDebugHeaders(res, executionProject, executionDurationMs);
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    throw executionError;
  }

  setWorkflowExecutionDebugHeaders(res, executionProject, executionDurationMs);
  setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
  sendJsonWithDuration(res, 200, responsePayload, requestStartedAt);
}

async function handlePublishedWorkflowRequest(
  req: Request,
  res: Response,
  options: { requireApiKey: boolean },
): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }
    if (options.requireApiKey) {
      // Only the immutable published route recognizes the short-lived capacity
      // capability. Latest execution keeps requiring the normal operator key.
      requirePublishedWorkflowApiKey(req, { capacityEndpointName: endpointName });
    }

    const executionProject = await resolvePublishedExecutionProject(endpointName);
    if (!executionProject) {
      sendJsonWithDuration(res, 404, { error: 'Published workflow not found' }, requestStartedAt);
      return;
    }

    const permit = acquirePublishedExecutionPermit('workflow-endpoint');
    const activeExecution = registerActiveHttpExecution();
    try {
      await executeWorkflowEndpoint(executionProject, requestStartedAt, req, res, {
        abortSignal: activeExecution.signal,
        enableRemoteDebugger: false,
        endpointName,
        runKind: 'published',
      });
    } finally {
      activeExecution.release();
      permit.release();
    }
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

publishedWorkflowsRouter.post(
  '/:endpointName',
  authorizePublishedWorkflowBeforeBody,
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => {
    await handlePublishedWorkflowRequest(req, res, { requireApiKey: false });
  }),
);

internalPublishedWorkflowsRouter.post(
  '/:endpointName',
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => {
    await handlePublishedWorkflowRequest(req, res, { requireApiKey: false });
  }),
);

latestWorkflowsRouter.post(
  '/:endpointName',
  authorizeLatestWorkflowBeforeBody,
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => {
    const requestStartedAt = performance.now();

    try {
      const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
      if (!endpointName) {
        throw badRequest('Endpoint name is required');
      }

      const executionProject = await resolveLatestExecutionProject(endpointName);
      if (!executionProject) {
        sendJsonWithDuration(res, 404, { error: 'Latest workflow not found' }, requestStartedAt);
        return;
      }

      const activeExecution = registerActiveHttpExecution();
      try {
        await executeWorkflowEndpoint(executionProject, requestStartedAt, req, res, {
          abortSignal: activeExecution.signal,
          enableRemoteDebugger: true,
          endpointName,
          runKind: 'latest',
        });
      } finally {
        activeExecution.release();
      }
    } catch (error) {
      sendWorkflowErrorWithDuration(res, error, requestStartedAt);
    }
  }),
);

async function handleWebAppHtmlRequest(req: Request, res: Response, routeKind: WebAppRouteKind): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    const resolved = await resolveWebAppExecutionProject(req, requestStartedAt, res, routeKind, 'html');
    if (!resolved) {
      return;
    }

    const uiGraph = resolveWebAppUiGraph(resolved.executionProject);
    if (!uiGraph) {
      sendHtmlWithDuration(
        res,
        404,
        '<!doctype html><meta charset="utf-8"><title>Rivet web app</title><body>Rivet web app not found</body>',
        requestStartedAt,
      );
      return;
    }

    const html = renderRivetWebAppHtml(uiGraph, {
      actionTransport: {
        type: 'websocket',
        socketPath: `${getWebAppBasePath(routeKind, resolved.slug)}/actions/ws`,
      },
      revisionKey: resolved.executionProject.revisionKey,
    });
    sendHtmlWithDuration(
      res,
      200,
      getWebAppAuthMode() === 'oauth' && readWebAppOAuthSession(req)
        ? addWebAppOAuthLogoutLink(html, getWebAppCurrentLogoutPath(req))
        : html,
      requestStartedAt,
    );
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

async function handleWebAppJsonRequest(req: Request, res: Response, routeKind: WebAppRouteKind): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    const resolved = await resolveWebAppExecutionProject(req, requestStartedAt, res, routeKind, 'json');
    if (!resolved) {
      return;
    }

    const uiGraph = resolveWebAppUiGraph(resolved.executionProject);
    if (!uiGraph) {
      sendJsonWithDuration(res, 404, { error: 'Rivet web app not found' }, requestStartedAt);
      return;
    }

    sendJsonWithDuration(res, 200, uiGraph, requestStartedAt);
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

async function handleWebAppActionRequest(req: Request, res: Response, routeKind: WebAppRouteKind): Promise<void> {
  const prepared = preparedWebAppActions.get(req);
  if (!prepared) {
    throw createHttpError(500, 'Web app action authorization was not prepared.');
  }
  const requestStartedAt = prepared.requestStartedAt;
  let codeRunnerTelemetry: ManagedCodeRunnerTelemetry | null = null;

  try {
    const { resolved, uiGraph } = prepared;
    if (!uiGraph) {
      sendJsonWithDuration(res, 404, { error: 'Rivet web app not found' }, requestStartedAt);
      return;
    }

    if (!isJsonObjectRecord(req.body)) {
      throw new RivetWebAppActionHttpError('Invalid action request body.', 400);
    }

    codeRunnerTelemetry = shouldCollectCodeRunnerTelemetry() ? createManagedCodeRunnerTelemetry() : null;

    const permit = routeKind === 'published' ? acquirePublishedExecutionPermit('web-app-action') : null;
    const activeExecution = registerActiveHttpExecution();
    let execution: WebAppActionExecutionSnapshot;
    try {
      execution = await runRecordedWebAppAction(resolved.executionProject, uiGraph, req, codeRunnerTelemetry, {
        abortSignal: activeExecution.signal,
        enableRemoteDebugger: routeKind === 'latest',
        webAppSlug: resolved.slug,
      });
    } finally {
      activeExecution.release();
      permit?.release();
    }
    enqueueExecutionRecording(resolved.executionProject, execution, {
      endpointName: getWebAppBasePath(routeKind, resolved.slug),
      runKind: routeKind,
      executionIdentity: execution.executionIdentity,
    });

    setWorkflowExecutionDebugHeaders(res, resolved.executionProject, execution.durationMs);
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    if (execution.executionError) {
      sendWebAppActionErrorWithDuration(res, execution.executionError, requestStartedAt);
      return;
    }

    sendJsonWithDuration(res, 200, execution.result, requestStartedAt);
  } catch (error) {
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    sendWebAppActionErrorWithDuration(res, error, requestStartedAt);
  } finally {
    preparedWebAppActions.delete(req);
  }
}

publishedWebAppsRouter.get(
  '/:slug/app.json',
  asyncHandler(async (req, res) => {
    await handleWebAppJsonRequest(req, res, 'published');
  }),
);
publishedWebAppsRouter.post(
  '/:slug/actions/run',
  prepareWebAppActionBeforeBody('published'),
  createJsonBodyParser(getPreparedWebAppActionBodyLimit),
  asyncHandler(async (req, res) => {
    await handleWebAppActionRequest(req, res, 'published');
  }),
);
publishedWebAppsRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    await handleWebAppHtmlRequest(req, res, 'published');
  }),
);

latestWebAppsRouter.get(
  '/:slug/app.json',
  asyncHandler(async (req, res) => {
    await handleWebAppJsonRequest(req, res, 'latest');
  }),
);
latestWebAppsRouter.post(
  '/:slug/actions/run',
  prepareWebAppActionBeforeBody('latest'),
  createJsonBodyParser(getPreparedWebAppActionBodyLimit),
  asyncHandler(async (req, res) => {
    await handleWebAppActionRequest(req, res, 'latest');
  }),
);
latestWebAppsRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    await handleWebAppHtmlRequest(req, res, 'latest');
  }),
);
