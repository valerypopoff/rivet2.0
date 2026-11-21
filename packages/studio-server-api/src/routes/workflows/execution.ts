import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { registerActiveHttpExecution } from '../../active-http-executions.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { sendRejectedBodyResponse } from '../../middleware/body-admission.js';
import { createJsonBodyParser } from '../../middleware/body-parsers.js';
import { normalizeStoredEndpointName } from './endpoint-names.js';
import { createManagedCodeRunnerTelemetry } from '../../runtime-libraries/managed-code-runner.js';
import { isTrustedClientRequest } from '../../auth.js';
import { getRequestCorrelationId } from '../../request-correlation.js';
import { parseLatestEndpointSegment } from '@valerypopoff/rivet2-core';
import { readWorkflowEndpointAuthSettingsSync } from '../../workflow-endpoint-auth-settings.js';
import { isWorkflowCapacityCapabilityValid } from '../../workflow-capacity-capability.js';
import { resolveLatestExecutionProject, resolvePublishedExecutionTarget } from './storage-backend.js';
import { getWorkflowExecutionRecorderOptions, isWorkflowRecordingEnabled } from './recordings-config.js';
import type { WorkflowRecordingExecutionIdentity } from '@valerypopoff/rivet-studio-server-shared/workflow-recording-types.js';
import { createHostedProcessor } from './hosted-processor.js';
import { ExecutionSession } from './execution-session.js';
import { executionRunEvidenceInput, beginRunEvidence } from './run-evidence.js';
import {
  type WorkflowExecutionContext,
  type WorkflowExecutionProject,
  getWorkflowRequestHeaders,
  getWorkflowErrorMessage,
  getLatestRemoteDebuggerForExecution,
  enqueueExecutionRecording,
  getGraphNameAtExecution,
} from './web-app-execution.js';
import {
  sendJsonWithDuration,
  sendWorkflowErrorWithDuration,
  shouldCollectCodeRunnerTelemetry,
  setWorkflowExecutionDebugHeaders,
  setCodeRunnerTelemetryHeaders,
  acquirePublishedExecutionPermit,
} from './execution-http-support.js';

export {
  type WorkflowExecutionProject,
  normalizeWorkflowRequestHeadersForContext,
  getWorkflowRecordingStatusFromOutputs,
  getWorkflowErrorMessage,
  type WebAppRouteKind,
  getWebAppBasePath,
  resolveWebAppUiGraph,
  awaitWebAppActionPreflight,
  type WebAppSocketExecutionResolution,
  type WebAppSocketAuthorizationStatus,
  resolveWebAppSocketExecution,
  createWebAppSocketFetchRequest,
  createWebAppProcessorOptions,
  enqueueWebAppActionRecording,
  createWebAppActionRecordingIdentity,
} from './web-app-execution.js';

export const publishedWorkflowsRouter = Router();

export const internalPublishedWorkflowsRouter = Router();

export const latestWorkflowsRouter = Router();

export const internalLatestWorkflowsRouter = Router();

const WORKFLOW_JSON_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

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

function getWorkflowResponsePayload(outputs: Record<string, { type?: string; value?: unknown }>): unknown {
  const outputValue = outputs.output;
  if (outputValue?.type !== 'any') {
    return outputs;
  }

  return outputValue.value ?? null;
}

function getBearerToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

function getWorkflowExecutionContext(req: Request): WorkflowExecutionContext {
  return {
    headers: {
      type: 'any',
      value: getWorkflowRequestHeaders(req),
    },
  };
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
    sendRejectedBodyResponse(req, res, () => sendWorkflowErrorWithDuration(res, error, performance.now()));
  }
}

function authorizeLatestWorkflowBeforeBody(req: Request, res: Response, next: NextFunction): void {
  try {
    const { endpointName } = getLatestRequestBinding(req);
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }
    requirePublishedWorkflowApiKey(req);
    next();
  } catch (error) {
    sendRejectedBodyResponse(req, res, () => sendWorkflowErrorWithDuration(res, error, performance.now()));
  }
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
    debuggerChannel?: string | null;
  },
): Promise<void> {
  const { project, datasetProvider, projectVirtualPath } = executionProject;
  const remoteDebugger = getLatestRemoteDebuggerForExecution(options);
  const codeRunnerTelemetry = shouldCollectCodeRunnerTelemetry() ? createManagedCodeRunnerTelemetry() : null;
  const executionIdentity = createWorkflowEndpointRecordingIdentity(executionProject, getRequestCorrelationId(req));
  const processor = await createHostedProcessor({
    project,
    datasetProvider,
    frozenReferences: 'frozenReferences' in executionProject ? executionProject.frozenReferences : undefined,
    projectPath: projectVirtualPath,
    earlyOutputs: true,
    abortSignal: options.abortSignal,
    telemetry: codeRunnerTelemetry,
    recording: isWorkflowRecordingEnabled(),
    correlationId: executionIdentity.correlationId!,
    remoteDebugger,
    context: getWorkflowExecutionContext(req),
    inputs: getWorkflowRequestInputs(req),
  });
  const session = new ExecutionSession(processor, {
    recording: isWorkflowRecordingEnabled(),
    recorderOptions: getWorkflowExecutionRecorderOptions(),
    evidence: executionRunEvidenceInput(executionProject, executionIdentity, options.endpointName, options.runKind),
    beginEvidence: beginRunEvidence,
  });
  const executionStartedAt = performance.now();
  const snapshot = await session.run((outputs) => {
    const responsePayload = getWorkflowResponsePayload(outputs);
    setWorkflowExecutionDebugHeaders(res, executionProject, performance.now() - executionStartedAt);
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    if (!res.destroyed && !res.writableEnded) sendJsonWithDuration(res, 200, responsePayload, requestStartedAt);
  });
  const failure = snapshot.failure;
  const executionDurationMs = snapshot.durationMs;
  // Keep the execution permit while completed-response I/O gets a turn before
  // the settled capture is inspected and admitted to the persistence queue.
  if (snapshot.recorder && !snapshot.recorder.captureDiscarded && res.writableEnded && !res.destroyed)
    await yieldToIo();
  enqueueExecutionRecording(executionProject, snapshot, {
    endpointName: options.endpointName,
    runKind: options.runKind,
    executionIdentity,
  });

  if (failure) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      console.error('Workflow execution failed after response delivery or disconnect:', {
        correlationId: executionIdentity.correlationId,
        endpointName: options.endpointName,
        runKind: options.runKind,
        error: getWorkflowErrorMessage(failure.error),
      });
      return;
    }
    setWorkflowExecutionDebugHeaders(res, executionProject, executionDurationMs);
    setCodeRunnerTelemetryHeaders(res, codeRunnerTelemetry);
    throw failure.error;
  }
}

async function handlePublishedWorkflowRequest(
  req: Request,
  res: Response,
  options: { internalRoute: boolean },
): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }
    // Public access must reflect the committed policy even before another replica
    // receives its asynchronous cache invalidation notification.
    const target = await resolvePublishedExecutionTarget(endpointName, !options.internalRoute, res);
    if (!options.internalRoute && res.destroyed) return;
    if (!target || (!options.internalRoute && target.endpointAccess === 'internal')) {
      sendJsonWithDuration(res, 404, { error: 'Published workflow not found' }, requestStartedAt);
      return;
    }

    const permit = acquirePublishedExecutionPermit('workflow-endpoint');
    try {
      const activeExecution = registerActiveHttpExecution();
      try {
        const executionProject = await target.load();
        // Loading can retry after a publication/access change. Never execute a
        // target that disappeared or became private during preparation.
        if (!executionProject || (!options.internalRoute && executionProject.endpointAccess === 'internal')) {
          sendJsonWithDuration(res, 404, { error: 'Published workflow not found' }, requestStartedAt);
          return;
        }
        activeExecution.signal.throwIfAborted();
        await executeWorkflowEndpoint(executionProject, requestStartedAt, req, res, {
          abortSignal: activeExecution.signal,
          enableRemoteDebugger: false,
          endpointName,
          runKind: 'published',
        });
      } finally {
        activeExecution.release();
      }
    } finally {
      permit.release();
    }
  } catch (error) {
    if (!res.destroyed) sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

publishedWorkflowsRouter.post(
  '/:endpointName',
  authorizePublishedWorkflowBeforeBody,
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => {
    await handlePublishedWorkflowRequest(req, res, { internalRoute: false });
  }),
);

internalPublishedWorkflowsRouter.post(
  '/:endpointName',
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => {
    await handlePublishedWorkflowRequest(req, res, { internalRoute: true });
  }),
);

async function handleLatestWorkflowRequest(req: Request, res: Response, internalRoute: boolean): Promise<void> {
  const requestStartedAt = performance.now();

  try {
    const { endpointName, channel } = getLatestRequestBinding(req);
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }

    const executionProject = await resolveLatestExecutionProject(endpointName, !internalRoute);
    if (!executionProject || (!internalRoute && executionProject.endpointAccess === 'internal')) {
      sendJsonWithDuration(res, 404, { error: 'Latest workflow not found' }, requestStartedAt);
      return;
    }

    const activeExecution = registerActiveHttpExecution();
    try {
      await executeWorkflowEndpoint(executionProject, requestStartedAt, req, res, {
        abortSignal: activeExecution.signal,
        enableRemoteDebugger: true,
        debuggerChannel: channel,
        endpointName,
        runKind: 'latest',
      });
    } finally {
      activeExecution.release();
    }
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

const latestRequestBindings = new WeakMap<Request, ReturnType<typeof parseLatestEndpointSegment>>();

function getLatestRequestBinding(req: Request) {
  const existing = latestRequestBindings.get(req);
  if (existing) return existing;
  try {
    const binding = Object.freeze(parseLatestEndpointSegment(String(req.params.endpointName ?? '')));
    latestRequestBindings.set(req, binding);
    return binding;
  } catch {
    throw badRequest('Invalid latest endpoint or debugger channel');
  }
}

latestWorkflowsRouter.post(
  '/:endpointName',
  authorizeLatestWorkflowBeforeBody,
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => handleLatestWorkflowRequest(req, res, false)),
);

internalLatestWorkflowsRouter.post(
  '/:endpointName',
  createJsonBodyParser(() => WORKFLOW_JSON_BODY_LIMIT_BYTES),
  asyncHandler(async (req, res) => handleLatestWorkflowRequest(req, res, true)),
);

export { publishedWebAppsRouter, latestWebAppsRouter } from './web-app-http.js';
