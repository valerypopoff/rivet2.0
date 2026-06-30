import { performance } from 'node:perf_hooks';
import { Router, type Request, type Response } from 'express';
import {
  createProcessor,
  ExecutionRecorder,
  renderRivetWebAppHtml,
  RivetWebAppActionHttpError,
  runRivetWebAppAction,
  type UiGraph,
} from '@valerypopoff/rivet2-node';

import { getLatestWorkflowRemoteDebugger, isLatestWorkflowRemoteDebuggerEnabled } from '../../latestWorkflowRemoteDebugger.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { RIVET_LATEST_WEB_APPS_BASE_PATH, RIVET_WEB_APPS_BASE_PATH } from '../../workflowEndpointPaths.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import {
  createManagedCodeRunnerTelemetry,
  getManagedCodeRunnerTelemetrySnapshot,
  isManagedCodeRunnerTelemetryEnabled,
  ManagedCodeRunner,
  type ManagedCodeRunnerTelemetry,
} from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';
import { isTrustedTokenFreeHostRequest, isTrustedUiSessionRequest } from '../../auth.js';
import {
  createWebAppOAuthAuthorizationRedirect,
  getWebAppAuthMode,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
} from '../../web-app-oauth.js';
import { enqueueWorkflowExecutionRecordingPersistence } from './recordings.js';
import {
  createExecutionProjectReferenceLoader,
  persistWorkflowExecutionRecordingWithBackend,
  resolveLatestExecutionProject,
  resolveLatestWebAppExecutionProject as resolveLatestWebAppExecutionProjectWithBackend,
  resolvePublishedExecutionProject,
  resolvePublishedWebAppExecutionProject as resolvePublishedWebAppExecutionProjectWithBackend,
} from './storage-backend.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
  shouldSnapshotWorkflowRecordingDatasets,
} from './recordings-config.js';

export const publishedWorkflowsRouter = Router();
export const internalPublishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();
export const publishedWebAppsRouter = Router();
export const latestWebAppsRouter = Router();

type WorkflowRequestHeadersContext = Record<string, string>;
type WorkflowExecutionContext = {
  headers: {
    type: 'any';
    value: WorkflowRequestHeadersContext;
  };
};

type WorkflowExecutionProject = Awaited<ReturnType<typeof resolvePublishedExecutionProject>> extends infer T
  ? Exclude<T, null>
  : never;

const WORKFLOW_CONTEXT_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const UNSAFE_WORKFLOW_CONTEXT_HEADER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

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

    const value = normalizeWorkflowContextHeaderValue(rawValue);
    if (value == null) {
      continue;
    }

    headers[name] = value;
  }

  return headers;
}

function getWorkflowRequestHeaders(req: Request): WorkflowRequestHeadersContext {
  return normalizeWorkflowRequestHeadersForContext(req.headers);
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

function sendJsonWithDuration(
  res: Response,
  statusCode: number,
  payload: unknown,
  requestStartedAt: number,
): void {
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

function sendWorkflowErrorWithDuration(
  res: Response,
  error: unknown,
  requestStartedAt: number,
): void {
  const status = typeof error === 'object' && error != null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 500;

  if (status >= 500) {
    console.error('Workflow execution failed:', error);
  }

  const errorPayload = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : {
        message: String(error),
      };

  sendJsonWithDuration(res, status, {
    error: errorPayload,
  }, requestStartedAt);
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

function getWorkflowErrorMessage(error: unknown): string {
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

function getWorkflowExecutionContext(
  req: Request
): WorkflowExecutionContext {
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

function setCodeRunnerTelemetryHeaders(
  res: Response,
  telemetry: ManagedCodeRunnerTelemetry | null,
): void {
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

function requirePublishedWorkflowApiKey(req: Request): void {
  const isWorkflowKeyRequired = isEnvFlagEnabled(process.env.RIVET_REQUIRE_WORKFLOW_KEY, false);
  if (!isWorkflowKeyRequired) {
    return;
  }

  if (isTrustedTokenFreeHostRequest(req)) {
    return;
  }

  const expectedApiKey = process.env.RIVET_KEY?.trim();
  if (!expectedApiKey) {
    throw createHttpError(500, 'Workflow execution key is required but RIVET_KEY is not configured');
  }

  const providedApiKey = getBearerToken(req);
  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    throw createHttpError(401, 'Unauthorized');
  }
}

function requirePublishedWebAppUiGate(req: Request): void {
  const isUiGateRequired = isEnvFlagEnabled(process.env.RIVET_REQUIRE_UI_GATE_KEY, false);
  if (!isUiGateRequired) {
    return;
  }

  if (isTrustedTokenFreeHostRequest(req)) {
    return;
  }

  if (isTrustedUiSessionRequest(req)) {
    return;
  }

  const expectedSharedKey = process.env.RIVET_KEY?.trim();
  if (!expectedSharedKey) {
    throw createHttpError(500, 'UI gate key is required but RIVET_KEY is not configured');
  }

  throw createHttpError(401, 'Unauthorized');
}

type WebAppRequestKind = 'html' | 'json' | 'action';

function getWebAppRequestReturnTo(req: Request): string {
  return req.originalUrl || req.url || '/';
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
  const redirect = createWebAppOAuthAuthorizationRedirect(req, getWebAppRequestReturnTo(req));
  res.setHeader('Set-Cookie', redirect.cookies);
  res.redirect(302, redirect.location);
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

function authorizeWebAppRequestBeforeResolve(
  req: Request,
  res: Response,
  requestStartedAt: number,
  requestKind: WebAppRequestKind,
): boolean {
  const mode = getWebAppAuthMode();
  if (mode === 'none' || isTrustedTokenFreeHostRequest(req)) {
    return true;
  }

  if (!isWebAppBrowserRequestOriginAllowed(req, requestKind)) {
    if (requestKind === 'html') {
      sendHtmlWithDuration(
        res,
        403,
        '<!doctype html><meta charset="utf-8"><title>Forbidden</title><body>Forbidden</body>',
        requestStartedAt,
      );
    } else {
      sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Cross-origin web app request denied', 'origin_forbidden');
    }
    return false;
  }

  if (mode === 'ui-gate') {
    requirePublishedWebAppUiGate(req);
    return true;
  }

  const session = readWebAppOAuthSession(req);
  if (session) {
    return true;
  }

  if (requestKind === 'html') {
    startWebAppOAuthLogin(req, res);
    return false;
  }

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
  if (getWebAppAuthMode() !== 'oauth' || isTrustedTokenFreeHostRequest(req)) {
    return true;
  }

  if (isWebAppOAuthSessionAllowed(readWebAppOAuthSession(req), executionProject.webAppAllowedEmails ?? [])) {
    return true;
  }

  if (requestKind === 'html') {
    sendHtmlWithDuration(
      res,
      403,
      '<!doctype html><meta charset="utf-8"><title>Forbidden</title><body>Forbidden</body>',
      requestStartedAt,
    );
    return false;
  }

  sendWebAppAuthJsonError(res, requestStartedAt, 403, 'Forbidden', 'oauth_forbidden');
  return false;
}

function getForwardedRequestProtocol(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwardedProto?.toLowerCase() || req.protocol || 'http';
}

function getForwardedRequestHost(req: Request): string {
  return req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host') || '';
}

function createFetchRequestFromExpress(req: Request): globalThis.Request {
  const host = getForwardedRequestHost(req) || 'localhost';
  const url = `${getForwardedRequestProtocol(req)}://${host}${req.originalUrl || req.url}`;
  const headers = new Headers();

  for (const [name, rawValue] of Object.entries(req.headers)) {
    const value = normalizeWorkflowContextHeaderValue(rawValue);
    if (value != null) {
      headers.set(name, value);
    }
  }

  return new Request(url, {
    headers,
    method: req.method,
  });
}

function encodeUrlPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

type WebAppRouteKind = 'published' | 'latest';

function getWebAppBasePath(routeKind: WebAppRouteKind, slug: string): string {
  const basePath = routeKind === 'published'
    ? RIVET_WEB_APPS_BASE_PATH
    : RIVET_LATEST_WEB_APPS_BASE_PATH;

  return `${basePath}/${encodeUrlPathSegment(slug)}`;
}

function getLatestRemoteDebuggerForExecution(options?: { enableRemoteDebugger?: boolean }) {
  return options?.enableRemoteDebugger && isLatestWorkflowRemoteDebuggerEnabled()
    ? getLatestWorkflowRemoteDebugger()
    : undefined;
}

function resolveWebAppUiGraph(executionProject: WorkflowExecutionProject): UiGraph | null {
  const uiGraphId = executionProject.webAppUiGraphId;

  return uiGraphId
    ? (executionProject.project.uiGraphs?.[uiGraphId as keyof typeof executionProject.project.uiGraphs] ?? null)
    : null;
}

function sendHtmlWithDuration(
  res: Response,
  statusCode: number,
  html: string,
  requestStartedAt: number,
): void {
  const durationMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  res.set('x-duration-ms', String(durationMs));
  res.status(statusCode).type('html').send(html);
}

function sendWebAppActionErrorWithDuration(
  res: Response,
  error: unknown,
  requestStartedAt: number,
): void {
  const status = error instanceof RivetWebAppActionHttpError ? error.status : 500;
  if (status >= 500) {
    console.error('Rivet web app action failed:', error);
  }
  const message = getWorkflowErrorMessage(error);
  const code = error instanceof RivetWebAppActionHttpError ? error.code : undefined;
  sendJsonWithDuration(res, status, {
    error: message,
    ...(code ? { code } : {}),
  }, requestStartedAt);
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

async function resolveWebAppExecutionProject(
  req: Request,
  requestStartedAt: number,
  res: Response,
  routeKind: WebAppRouteKind,
  requestKind: WebAppRequestKind,
): Promise<{ slug: string; executionProject: WorkflowExecutionProject } | null> {
  if (!authorizeWebAppRequestBeforeResolve(req, res, requestStartedAt, requestKind)) {
    return null;
  }

  const slug = normalizeStoredEndpointName(String(req.params.slug ?? ''));
  if (!slug) {
    throw badRequest('Web app slug is required');
  }

  const executionProject = routeKind === 'published'
    ? await resolvePublishedWebAppExecutionProjectWithBackend(slug)
    : await resolveLatestWebAppExecutionProjectWithBackend(slug);
  if (!executionProject) {
    sendJsonWithDuration(
      res,
      404,
      { error: routeKind === 'published' ? 'Published Rivet web app not found' : 'Latest Rivet web app not found' },
      requestStartedAt,
    );
    return null;
  }

  if (!authorizeResolvedWebAppRequest(req, res, requestStartedAt, executionProject, requestKind)) {
    return null;
  }

  return { slug, executionProject };
}

async function createWebAppProcessorOptions(
  executionProject: WorkflowExecutionProject,
  req: Request,
  codeRunnerTelemetry: ManagedCodeRunnerTelemetry | null,
  options?: {
    enableRemoteDebugger?: boolean;
  },
) {
  const remoteDebugger = getLatestRemoteDebuggerForExecution(options);

  return {
    codeRunner: new ManagedCodeRunner(
      getRootPath(),
      codeRunnerTelemetry ? { telemetry: codeRunnerTelemetry } : {},
    ) as any,
    context: getWorkflowExecutionContext(req),
    datasetProvider: executionProject.datasetProvider,
    projectPath: executionProject.projectVirtualPath,
    projectReferenceLoader: await createExecutionProjectReferenceLoader(executionProject.projectVirtualPath),
    remoteDebugger,
  };
}

async function executeWorkflowEndpoint(
  executionProject: WorkflowExecutionProject,
  requestStartedAt: number,
  req: Request,
  res: Response,
  options: {
    enableRemoteDebugger?: boolean;
    endpointName: string;
    runKind: 'published' | 'latest';
  },
): Promise<void> {
  const { project, attachedData, datasetProvider, projectVirtualPath } = executionProject;
  const projectReferenceLoader = await createExecutionProjectReferenceLoader(projectVirtualPath);
  const remoteDebugger = getLatestRemoteDebuggerForExecution(options);
  const codeRunnerTelemetry = shouldCollectCodeRunnerTelemetry()
    ? createManagedCodeRunnerTelemetry()
    : null;
  const processor = createProcessor(project, {
    codeRunner: new ManagedCodeRunner(
      getRootPath(),
      codeRunnerTelemetry ? { telemetry: codeRunnerTelemetry } : {},
    ) as any,
    projectPath: projectVirtualPath,
    datasetProvider,
    projectReferenceLoader,
    remoteDebugger,
    context: getWorkflowExecutionContext(req),
    inputs: getWorkflowRequestInputs(req),
  });
  const recorder = isWorkflowRecordingEnabled()
    ? new ExecutionRecorder(getWorkflowExecutionRecorderOptions())
    : null;
  recorder?.record(processor.processor);

  let recordingStatus: 'succeeded' | 'failed' | 'suspicious' = 'succeeded';
  let recordingErrorMessage: string | undefined;
  let responsePayload: unknown;
  let executionError: unknown;
  let executionDurationMs = 0;
  const executionStartedAt = performance.now();

  try {
    const outputs = await processor.run();
    recordingStatus = getWorkflowRecordingStatusFromOutputs(outputs as Record<string, { type?: string; value?: unknown }>);

    responsePayload = getWorkflowResponsePayload(outputs as Record<string, { type?: string; value?: unknown }>);
  } catch (error) {
    recordingStatus = 'failed';
    recordingErrorMessage = getWorkflowErrorMessage(error);
    executionError = error;
  } finally {
    executionDurationMs = performance.now() - executionStartedAt;
  }

  if (recorder) {
    enqueueWorkflowExecutionRecordingPersistence(async () => {
      const executedDatasets = shouldSnapshotWorkflowRecordingDatasets()
        ? await datasetProvider.exportDatasetsForProject(project.metadata.id).catch((error) => {
            console.error('Failed to export workflow datasets for recording:', error);
            return [];
          })
        : [];

      await persistWorkflowExecutionRecordingWithBackend({
        sourceProject: project,
        sourceProjectPath: projectVirtualPath,
        executedProject: project,
        executedAttachedData: attachedData,
        executedDatasets,
        endpointName: options.endpointName,
        recordingSerialized: recorder.serialize(),
        runKind: options.runKind,
        status: recordingStatus,
        durationMs: executionDurationMs,
        errorMessage: recordingErrorMessage,
      });
    });
  }

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
  options?: { requireApiKey?: boolean },
): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    if (options?.requireApiKey !== false) {
      requirePublishedWorkflowApiKey(req);
    }

    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }

    const executionProject = await resolvePublishedExecutionProject(endpointName);
    if (!executionProject) {
      sendJsonWithDuration(res, 404, { error: 'Published workflow not found' }, requestStartedAt);
      return;
    }

    await executeWorkflowEndpoint(
      executionProject,
      requestStartedAt,
      req,
      res,
      {
        enableRemoteDebugger: false,
        endpointName,
        runKind: 'published',
      },
    );
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

publishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res);
}));

internalPublishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res, { requireApiKey: false });
}));

latestWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  const requestStartedAt = performance.now();

  try {
    requirePublishedWorkflowApiKey(req);

    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }

    const executionProject = await resolveLatestExecutionProject(endpointName);
    if (!executionProject) {
      sendJsonWithDuration(res, 404, { error: 'Latest workflow not found' }, requestStartedAt);
      return;
    }

    await executeWorkflowEndpoint(
      executionProject,
      requestStartedAt,
      req,
      res,
      {
        enableRemoteDebugger: true,
        endpointName,
        runKind: 'latest',
      },
    );
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}));

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

    sendHtmlWithDuration(
      res,
      200,
      renderRivetWebAppHtml(uiGraph, {
        actionPath: `${getWebAppBasePath(routeKind, resolved.slug)}/actions/run`,
        revisionKey: resolved.executionProject.revisionKey,
      }),
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
  const requestStartedAt = performance.now();
  let codeRunnerTelemetry: ManagedCodeRunnerTelemetry | null = null;

  try {
    const resolved = await resolveWebAppExecutionProject(req, requestStartedAt, res, routeKind, 'action');
    if (!resolved) {
      return;
    }

    const uiGraph = resolveWebAppUiGraph(resolved.executionProject);
    if (!uiGraph) {
      sendJsonWithDuration(res, 404, { error: 'Rivet web app not found' }, requestStartedAt);
      return;
    }

    if (!isJsonObjectRecord(req.body)) {
      throw new RivetWebAppActionHttpError('Invalid action request body.', 400);
    }

    codeRunnerTelemetry = shouldCollectCodeRunnerTelemetry()
      ? createManagedCodeRunnerTelemetry()
      : null;

    const executionStartedAt = performance.now();
    const result = await runRivetWebAppAction(resolved.executionProject.project, {
      componentId: getWebAppActionComponentId(req.body),
      createProcessorOptions: () => createWebAppProcessorOptions(
        resolved.executionProject,
        req,
        codeRunnerTelemetry,
        { enableRemoteDebugger: routeKind === 'latest' },
      ),
      request: createFetchRequestFromExpress(req),
      requestRevisionKey: getOptionalWebAppActionRevisionKey(req.body),
      revisionKey: resolved.executionProject.revisionKey,
      state: req.body.state as Record<string, unknown> | undefined,
      uiGraph,
    });
    const executionDurationMs = performance.now() - executionStartedAt;

    setWorkflowExecutionDebugHeaders(res, resolved.executionProject, executionDurationMs);
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    sendJsonWithDuration(res, 200, result, requestStartedAt);
  } catch (error) {
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    sendWebAppActionErrorWithDuration(res, error, requestStartedAt);
  }
}

publishedWebAppsRouter.get('/:slug/app.json', asyncHandler(async (req, res) => {
  await handleWebAppJsonRequest(req, res, 'published');
}));
publishedWebAppsRouter.post('/:slug/actions/run', asyncHandler(async (req, res) => {
  await handleWebAppActionRequest(req, res, 'published');
}));
publishedWebAppsRouter.get('/:slug', asyncHandler(async (req, res) => {
  await handleWebAppHtmlRequest(req, res, 'published');
}));

latestWebAppsRouter.get('/:slug/app.json', asyncHandler(async (req, res) => {
  await handleWebAppJsonRequest(req, res, 'latest');
}));
latestWebAppsRouter.post('/:slug/actions/run', asyncHandler(async (req, res) => {
  await handleWebAppActionRequest(req, res, 'latest');
}));
latestWebAppsRouter.get('/:slug', asyncHandler(async (req, res) => {
  await handleWebAppHtmlRequest(req, res, 'latest');
}));
