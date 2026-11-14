import { performance } from 'node:perf_hooks';
import { type Response } from 'express';
import {
  getPublishedExecutionAdmission,
  PublishedExecutionAdmissionError,
  toPublishedExecutionAdmissionError,
  type PublishedExecutionPermit,
  type PublishedExecutionSurface,
} from '../../published-execution-admission.js';
import {
  getManagedCodeRunnerTelemetrySnapshot,
  isManagedCodeRunnerTelemetryEnabled,
  type ManagedCodeRunnerTelemetry,
} from '../../runtime-libraries/managed-code-runner.js';
import { type WorkflowExecutionProject, isJsonObjectRecord } from './web-app-execution.js';

export function sendJsonWithDuration(
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

export function sendWorkflowErrorWithDuration(res: Response, error: unknown, requestStartedAt: number): void {
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

function shouldEmitWorkflowExecutionDebugHeaders(): boolean {
  return isEnvFlagEnabled(process.env.RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS, false);
}

export function shouldCollectCodeRunnerTelemetry(): boolean {
  return shouldEmitWorkflowExecutionDebugHeaders() && isManagedCodeRunnerTelemetryEnabled();
}

export function setWorkflowExecutionDebugHeaders(
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

export function setCodeRunnerTelemetryHeaders(res: Response, telemetry: ManagedCodeRunnerTelemetry | null): void {
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

export function acquirePublishedExecutionPermit(surface: PublishedExecutionSurface): PublishedExecutionPermit {
  const result = getPublishedExecutionAdmission().acquire(surface);
  if (result.kind === 'accepted') return result.permit;
  throw toPublishedExecutionAdmissionError(result);
}
