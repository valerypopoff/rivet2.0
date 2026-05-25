import { performance } from 'node:perf_hooks';
import { Router, type Request, type Response } from 'express';
import {
  createProcessor,
  ExecutionRecorder,
} from '@valerypopoff/rivet2-node';

import { getLatestWorkflowRemoteDebugger, isLatestWorkflowRemoteDebuggerEnabled } from '../../latestWorkflowRemoteDebugger.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import {
  createManagedCodeRunnerTelemetry,
  getManagedCodeRunnerTelemetrySnapshot,
  isManagedCodeRunnerTelemetryEnabled,
  ManagedCodeRunner,
  type ManagedCodeRunnerTelemetry,
} from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';
import { isTrustedTokenFreeHostRequest } from '../../auth.js';
import { enqueueWorkflowExecutionRecordingPersistence } from './recordings.js';
import {
  createExecutionProjectReferenceLoader,
  persistWorkflowExecutionRecordingWithBackend,
  resolveLatestExecutionProject,
  resolvePublishedExecutionProject,
} from './storage-backend.js';
import {
  getWorkflowExecutionRecorderOptions,
  isWorkflowRecordingEnabled,
  shouldSnapshotWorkflowRecordingDatasets,
} from './recordings-config.js';

export const publishedWorkflowsRouter = Router();
export const internalPublishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();

type WorkflowRequestHeadersContext = Record<string, string>;
type WorkflowExecutionContext = {
  headers: {
    type: 'any';
    value: WorkflowRequestHeadersContext;
  };
};

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

  console.error('Workflow execution failed:', error);

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
  executionProject: Awaited<ReturnType<typeof resolvePublishedExecutionProject>> extends infer T
    ? Exclude<T, null>
    : never,
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

async function executeWorkflowEndpoint(
  executionProject: Awaited<ReturnType<typeof resolvePublishedExecutionProject>> extends infer T
    ? Exclude<T, null>
    : never,
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
  const remoteDebugger = options?.enableRemoteDebugger && isLatestWorkflowRemoteDebuggerEnabled()
    ? getLatestWorkflowRemoteDebugger()
    : undefined;
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
