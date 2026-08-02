import type { UiComponentId } from './UiGraph.js';
import { normalizeGraphProgress, type GraphProgress } from './GraphProgress.js';
import { isAgentResponseTrace, type AgentResponseTrace } from './AgentResponseTrace.js';

export const RIVET_WEB_APP_ACTION_PROTOCOL_VERSION = 1 as const;

export type RivetWebAppActionStartMessage = {
  type: 'action.start';
  requestId: string;
  componentId: UiComponentId;
  revisionKey?: string;
  state: Record<string, unknown>;
  storage?: Record<string, unknown>;
};

export type RivetWebAppActionCancelMessage = {
  type: 'action.cancel';
  runId: string;
};

export type RivetWebAppRunResumeMessage = {
  type: 'run.resume';
  runId: string;
  lastSequence: number;
};

export type RivetWebAppClientHelloMessage = {
  type: 'client.hello';
  protocolVersion: typeof RIVET_WEB_APP_ACTION_PROTOCOL_VERSION;
};

export type RivetWebAppClientMessage =
  | RivetWebAppClientHelloMessage
  | RivetWebAppActionStartMessage
  | RivetWebAppActionCancelMessage
  | RivetWebAppRunResumeMessage;

type RunEventBase = {
  requestId: string;
  runId: string;
  sequence: number;
};

export type RivetWebAppServerMessage =
  | {
      type: 'server.ready';
      protocolVersion: typeof RIVET_WEB_APP_ACTION_PROTOCOL_VERSION;
    }
  | ({ type: 'action.accepted' } & RunEventBase)
  | ({ type: 'action.progress'; progress: GraphProgress } & RunEventBase)
  | ({
      type: 'action.completed';
      statePatch: Record<string, unknown>;
      storagePatch?: Record<string, unknown>;
      responseTrace?: AgentResponseTrace;
    } & RunEventBase)
  | ({ type: 'action.failed'; error: string; code?: string } & RunEventBase)
  | ({ type: 'action.cancelled' } & RunEventBase)
  | ({ type: 'action.interrupted'; error: string } & RunEventBase)
  | {
      type: 'action.rejected';
      requestId: string;
      error: string;
      code?: string;
    }
  | {
      type: 'run.rejected';
      runId: string;
      error: string;
      code?: string;
    }
  | {
      type: 'server.draining';
    };

export type RivetWebAppRunEvent = Exclude<
  RivetWebAppServerMessage,
  { type: 'server.ready' | 'action.rejected' | 'run.rejected' | 'server.draining' }
>;

export function parseRivetWebAppClientMessage(value: unknown): RivetWebAppClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  switch (value.type) {
    case 'client.hello':
      return value.protocolVersion === RIVET_WEB_APP_ACTION_PROTOCOL_VERSION
        ? { type: value.type, protocolVersion: value.protocolVersion }
        : undefined;
    case 'action.start':
      return isNonEmptyString(value.requestId) &&
        isNonEmptyString(value.componentId) &&
        isRecord(value.state) &&
        (value.storage == null || isRecord(value.storage)) &&
        (value.revisionKey == null || typeof value.revisionKey === 'string')
        ? {
            type: value.type,
            requestId: value.requestId,
            componentId: value.componentId as UiComponentId,
            state: value.state,
            ...(isRecord(value.storage) ? { storage: value.storage } : {}),
            ...(typeof value.revisionKey === 'string' ? { revisionKey: value.revisionKey } : {}),
          }
        : undefined;
    case 'action.cancel':
      return isNonEmptyString(value.runId) ? { type: value.type, runId: value.runId } : undefined;
    case 'run.resume':
      return isNonEmptyString(value.runId) &&
        typeof value.lastSequence === 'number' &&
        Number.isSafeInteger(value.lastSequence) &&
        value.lastSequence >= 0
        ? { type: value.type, runId: value.runId, lastSequence: value.lastSequence }
        : undefined;
    default:
      return undefined;
  }
}

export function parseRivetWebAppServerMessage(value: unknown): RivetWebAppServerMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  if (value.type === 'server.ready') {
    return value.protocolVersion === RIVET_WEB_APP_ACTION_PROTOCOL_VERSION
      ? { type: value.type, protocolVersion: value.protocolVersion }
      : undefined;
  }
  if (value.type === 'server.draining') return { type: value.type };
  if (value.type === 'action.rejected') {
    return isNonEmptyString(value.requestId) && isNonEmptyString(value.error)
      ? {
          type: value.type,
          requestId: value.requestId,
          error: value.error,
          ...(typeof value.code === 'string' ? { code: value.code } : {}),
        }
      : undefined;
  }
  if (value.type === 'run.rejected') {
    return isNonEmptyString(value.runId) && isNonEmptyString(value.error)
      ? {
          type: value.type,
          runId: value.runId,
          error: value.error,
          ...(typeof value.code === 'string' ? { code: value.code } : {}),
        }
      : undefined;
  }
  if (!hasRunEventBase(value)) return undefined;

  const base = {
    requestId: value.requestId,
    runId: value.runId,
    sequence: value.sequence,
  };
  switch (value.type) {
    case 'action.accepted':
    case 'action.cancelled':
      return { type: value.type, ...base };
    case 'action.progress': {
      if (!isRecord(value.progress)) return undefined;
      const progress = normalizeGraphProgress({
        message: typeof value.progress.message === 'string' ? value.progress.message : undefined,
        percent: typeof value.progress.percent === 'number' ? value.progress.percent : undefined,
      });
      return progress ? { type: value.type, ...base, progress } : undefined;
    }
    case 'action.completed':
      return isRecord(value.statePatch) &&
        (value.storagePatch == null || isRecord(value.storagePatch)) &&
        (value.responseTrace == null || isAgentResponseTrace(value.responseTrace))
        ? {
            type: value.type,
            ...base,
            statePatch: value.statePatch,
            ...(isRecord(value.storagePatch) ? { storagePatch: value.storagePatch } : {}),
            ...(isAgentResponseTrace(value.responseTrace) ? { responseTrace: value.responseTrace } : {}),
          }
        : undefined;
    case 'action.failed':
      return isNonEmptyString(value.error)
        ? {
            type: value.type,
            ...base,
            error: value.error,
            ...(typeof value.code === 'string' ? { code: value.code } : {}),
          }
        : undefined;
    case 'action.interrupted':
      return isNonEmptyString(value.error) ? { type: value.type, ...base, error: value.error } : undefined;
    default:
      return undefined;
  }
}

export function isRivetWebAppRunTerminalEvent(event: RivetWebAppRunEvent): boolean {
  return (
    event.type === 'action.completed' ||
    event.type === 'action.failed' ||
    event.type === 'action.cancelled' ||
    event.type === 'action.interrupted'
  );
}

function hasRunEventBase(value: Record<string, unknown>): value is Record<string, unknown> & RunEventBase {
  return (
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.runId) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
