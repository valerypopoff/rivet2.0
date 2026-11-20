import {
  WEB_APP_OAUTH_AUTH_ACTION_QUERY,
  WEB_APP_OAUTH_LOGIN_ACTION,
  WEB_APP_OAUTH_PROMPT_QUERY,
  escapeHtml,
  getWebAppAuthRetryPath,
  getWebAppCleanReturnTo,
  getWebAppCurrentLogoutPath,
  renderWebAppAuthErrorHtml,
  renderWebAppLoginRequiredHtml,
  renderWebAppUiGatePromptHtml,
  renderWebAppAccessDeniedHtml,
  renderWebAppOriginDeniedHtml,
} from './web-app-auth-presentation.js';
import { performance } from 'node:perf_hooks';
import { Router, type Request, type Response } from 'express';
import {
  createProcessor,
  createRivetStoredValueSnapshotStore,
  getUiGraphActionComponent,
  jsonValueToDataValue,
  renderRivetWebAppHtml,
  resolveUiGraphActionInputs,
  resolveUiGraphActionOutputStatePatch,
  RivetWebAppActionHttpError,
  type LooseDataValue,
  type RivetWebAppActionResult,
  type UiComponentId,
  type UiGraph,
} from '@valerypopoff/rivet2-node';
import { registerActiveHttpExecution } from '../../active-http-executions.js';
import { PublishedExecutionAdmissionError } from '../../published-execution-admission.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { closeResponseConnectionAfterFlush, sendRejectedBodyResponse } from '../../middleware/body-admission.js';
import { createJsonBodyParser } from '../../middleware/body-parsers.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import {
  createManagedCodeRunnerTelemetry,
  type ManagedCodeRunnerTelemetry,
} from '../../runtime-libraries/managed-code-runner.js';
import { isTrustedProxyRequest, isTrustedClientRequest } from '../../auth.js';
import { getRequestCorrelationId } from '../../request-correlation.js';
import { isServerUiAuthRequestAllowed } from '../../server-ui-auth.js';
import {
  createWebAppOAuthAuthorizationRedirect,
  getWebAppAuthMode,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
  WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT,
} from '../../web-app-oauth.js';
import { readRuntimeLimitSettingsSync } from '../../runtime-limit-settings.js';
import { getWorkflowExecutionRecorderOptions, isWorkflowRecordingEnabled } from './recordings-config.js';
import type { WorkflowRecordingExecutionIdentity } from '@valerypopoff/rivet-studio-server-shared/workflow-recording-types.js';
import { ExecutionSession } from './execution-session.js';
import { executionRunEvidenceInput, beginRunEvidence } from './run-evidence.js';
import {
  type WorkflowExecutionProject,
  resolveWebAppExecutionDefinition,
  isJsonObjectRecord,
  getWorkflowErrorMessage,
  type WebAppRouteKind,
  getWebAppBasePath,
  resolveWebAppUiGraph,
  type WorkflowExecutionRecordingSnapshot,
  awaitWebAppActionPreflight,
  createWebAppProcessorOptions,
  enqueueExecutionRecording,
  createWebAppActionRecordingIdentity,
} from './web-app-execution.js';
import {
  sendJsonWithDuration,
  sendWorkflowErrorWithDuration,
  shouldCollectCodeRunnerTelemetry,
  setWorkflowExecutionDebugHeaders,
  setCodeRunnerTelemetryHeaders,
  acquirePublishedExecutionPermit,
} from './execution-http-support.js';

export const publishedWebAppsRouter = Router();

export const latestWebAppsRouter = Router();

const MAX_CONCURRENT_WEB_APP_ACTION_PREFLIGHTS = 16;

let activeWebAppActionPreflights = 0;

function requirePublishedWebAppUiGate(req: Request): void {
  if (isServerUiAuthRequestAllowed(req)) {
    return;
  }

  throw createHttpError(401, 'Unauthorized');
}

type WebAppRequestKind = 'html' | 'json' | 'action';

function getWebAppAuthError(req: Request): string {
  return typeof req.query.auth_error === 'string' ? req.query.auth_error : '';
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

function sendWebAppRejection(req: Request, res: Response, requestKind: WebAppRequestKind, send: () => void): void {
  if (requestKind === 'action') {
    sendRejectedBodyResponse(req, res, send);
  } else send();
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
    if (requestKind === 'html') {
      sendHtmlWithDuration(res, 403, renderWebAppOriginDeniedHtml(req), requestStartedAt);
    } else {
      sendWebAppRejection(req, res, requestKind, () =>
        sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Cross-origin web app request denied', 'origin_forbidden'));
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
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        sendHtmlWithDuration(res, 401, renderWebAppUiGatePromptHtml(req), requestStartedAt);
        return false;
      }

      // The action route has not admitted its JSON body yet. Let the shared
      // error formatter keep this legacy error response, but first make the
      // connection non-reusable so the client cannot continue that body.
      if (requestKind === 'action') closeResponseConnectionAfterFlush(res, req);
      throw error;
    }
  }

  const session = readWebAppOAuthSession(req);
  if (session) {
    return true;
  }

  const authError = getWebAppAuthError(req);
  if (requestKind === 'html' && authError) {
    sendHtmlWithDuration(
      res,
      401,
      renderWebAppAuthErrorHtml(authError, getWebAppAuthRetryPath(req), getWebAppCurrentLogoutPath(req)),
      requestStartedAt,
    );
    return false;
  }

  if (requestKind === 'html' && isWebAppOAuthLoginRequest(req)) {
    startWebAppOAuthLogin(req, res);
    return false;
  }

  if (requestKind === 'html') {
    sendHtmlWithDuration(res, 401, renderWebAppLoginRequiredHtml(req), requestStartedAt);
    return false;
  }

  sendWebAppRejection(req, res, requestKind, () =>
    sendWebAppAuthJsonError(res, requestStartedAt, 401, 'OAuth login required', 'oauth_required'));
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
    sendHtmlWithDuration(
      res,
      403,
      renderWebAppAccessDeniedHtml(session?.email ?? 'this account', getWebAppCurrentLogoutPath(req)),
      requestStartedAt,
    );
    return false;
  }

  sendWebAppRejection(req, res, requestKind, () =>
    sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Forbidden', 'oauth_forbidden'));
  return false;
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

type WebAppActionExecutionSnapshot = WorkflowExecutionRecordingSnapshot & {
  result?: RivetWebAppActionResult;
  executionError?: unknown;
  executionIdentity: WorkflowRecordingExecutionIdentity;
};

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
    runKind: 'published' | 'latest';
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
    abortSignal: options.abortSignal,
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
  const session = new ExecutionSession(processor, {
    recording: isWorkflowRecordingEnabled(),
    recorderOptions: getWorkflowExecutionRecorderOptions(),
    evidence: executionRunEvidenceInput(executionProject, executionIdentity, options.webAppSlug, options.runKind),
    beginEvidence: beginRunEvidence,
  });
  let result: RivetWebAppActionResult | undefined;
  const snapshot = await session.run((outputs) => {
    result = {
      outputs,
      statePatch: resolveUiGraphActionOutputStatePatch(component.action, outputs),
      storagePatch: browserStoredValues?.getPatch() ?? {},
    };
  });
  return {
    ...snapshot,
    // Response mapping can fail after the graph succeeded. Keep the graph's
    // status consistent with its evidence while returning the action error.
    errorMessage:
      snapshot.errorMessage ?? (snapshot.failure ? getWorkflowErrorMessage(snapshot.failure.error) : undefined),
    result,
    executionError: snapshot.failure?.error,
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

  const executionProject = await resolveWebAppExecutionDefinition(routeKind, slug);
  if (options?.abortSignal?.aborted) {
    return null;
  }
  if (!executionProject) {
    sendWebAppRejection(req, res, requestKind, () => sendJsonWithDuration(
      res,
      404,
      { error: routeKind === 'published' ? 'Published Rivet web app not found' : 'Latest Rivet web app not found' },
      requestStartedAt,
    ));
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
      res.setHeader('Retry-After', '1');
      sendRejectedBodyResponse(req, res, () => sendJsonWithDuration(
        res,
        503,
        {
          error: 'Web app action preparation is temporarily exhausted.',
          code: 'web_app_action_preflight_capacity_exhausted',
        },
        requestStartedAt,
      ));
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
        sendRejectedBodyResponse(req, res, () =>
          sendJsonWithDuration(res, 404, { error: 'Rivet web app not found' }, requestStartedAt));
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
        runKind: routeKind,
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
