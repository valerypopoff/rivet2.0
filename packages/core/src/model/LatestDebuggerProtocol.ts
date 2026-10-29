import type { ProcessEventMessageMap } from './ExecutorProtocol.js';

/** Managed latest-debugger routing labels are not credentials. */
export type LatestDebuggerChannel = string | null;
export type LatestDebuggerTarget = {
  rootRunId: string;
  projectId: string;
  owner: string;
  incarnation: string;
};
export type LatestDebuggerScope = LatestDebuggerTarget & {
  channel: LatestDebuggerChannel;
  promptId?: string;
  admittedAt?: number;
  /** This owner emits authoritative prompt closure in the same ordered stream. */
  promptLifecycle?: 1;
};
export type LatestDebuggerPromptClosedMessage = {
  message: 'latest-prompt-closed';
  rivetScope: LatestDebuggerScope;
  data: { promptId: string };
};
export type LatestDebuggerPrompt = { target: LatestDebuggerScope; promptId: string };
export type LatestDebuggerSessionMessage = {
  message: 'latest-session';
  data: {
    protocol: 2;
    channel: LatestDebuggerChannel;
    channelIsolation: true;
    runScopedControls: true;
    /** Per-origin event positions, bounded by the shared retained-event limit. */
    historyThrough?: string[];
  };
};
export type LatestDebuggerControlMessage = {
  type: 'latest-control';
  data: {
    commandId: string;
    target: LatestDebuggerScope;
  } & (
    | { action: 'pause' | 'resume' | 'abort' }
    | { action: 'user-input'; promptId: string; answers: { type: 'string[]'; value: string[] } }
  );
};
export type LatestDebuggerControlResult = {
  status: 'accepted' | 'rejected' | 'outcome-unknown';
  reason?: string;
};
export type LatestDebuggerControlResultMessage = {
  message: 'latest-control-result';
  data: LatestDebuggerControlResult & { commandId: string };
};
export type LatestDebuggerSettledMessage = {
  message: 'latest-settled';
  rivetScope: LatestDebuggerScope;
  data: Record<string, never>;
};
export type LatestDebuggerLifecycleMessage = LatestDebuggerPromptClosedMessage | LatestDebuggerSettledMessage;
export type LatestDebuggerProcessMessage = {
  [K in keyof ProcessEventMessageMap]: { message: K; data: ProcessEventMessageMap[K]; rivetScope: LatestDebuggerScope };
}[keyof ProcessEventMessageMap];
export type LatestDebuggerExecutionMessage = (LatestDebuggerProcessMessage | LatestDebuggerLifecycleMessage) & {
  rivetEventId?: string;
  /** Browser delivery only: local subscription history, or recovered peer history of unproven newness. */
  rivetHistory?: true | 'peer';
};
const diagnosticCodes = ['history-truncated', 'history-gap', 'event-too-large', 'owner-unavailable'] as const;
export type LatestDebuggerDiagnosticCode = (typeof diagnosticCodes)[number];
export type LatestDebuggerDiagnosticMessage = {
  message: 'latest-diagnostic';
  data: { protocol: 1; code: LatestDebuggerDiagnosticCode };
};
export type LatestDebuggerServerMessage =
  | LatestDebuggerSessionMessage
  | LatestDebuggerExecutionMessage
  | LatestDebuggerDiagnosticMessage
  | LatestDebuggerControlResultMessage;
export type LatestDebuggerMessage = LatestDebuggerServerMessage | LatestDebuggerControlMessage;
export const LATEST_DEBUGGER_PATH = '/ws/latest-debugger';

const managedProcessMessages = {
  codeConsole: true,
  nodeStart: true,
  nodeFinish: true,
  nodeError: true,
  nodeExcluded: true,
  userInput: true,
  start: true,
  done: true,
  abort: true,
  graphAbort: true,
  graphStart: true,
  webAppStoragePatch: true,
  graphFinish: true,
  graphOutputsReady: true,
  partialOutput: true,
  progress: true,
  llmCallFinished: true,
  llmChatOutputSnapshot: true,
  llmProfileAttempt: true,
  toolCallFinished: true,
  nodeOutputsCleared: true,
  streamingOutputWatchSummary: true,
  error: true,
  graphError: true,
  trace: true,
  pause: true,
  resume: true,
} satisfies Record<keyof ProcessEventMessageMap, true>;

export function isLatestDebuggerExecutionMessage(message: string): boolean {
  return (
    Object.hasOwn(managedProcessMessages, message) || message === 'latest-settled' || message === 'latest-prompt-closed'
  );
}

/** Preserve historical writer ordering while readers accept arbitrary JSON ordering. */
export function encodeLatestDebuggerEnvelope(
  serialized: string,
  scope?: LatestDebuggerScope,
  eventId?: string,
  history: boolean | 'peer' = false,
): string {
  if (!scope && !eventId && !history) return serialized;
  const metadata = JSON.stringify({
    ...(eventId ? { rivetEventId: eventId } : {}),
    ...(scope ? { rivetScope: scope } : {}),
    ...(history ? { rivetHistory: history } : {}),
  });
  return `${metadata.slice(0, -1)},${serialized.slice(1)}`;
}

export function createLatestDebuggerSession(
  channel: LatestDebuggerChannel,
  historyThrough?: string[],
): LatestDebuggerSessionMessage {
  return {
    message: 'latest-session',
    data: {
      protocol: 2,
      channel,
      channelIsolation: true,
      runScopedControls: true,
      ...(historyThrough ? { historyThrough } : {}),
    },
  };
}

export function isLatestDebuggerSession(value: unknown): value is LatestDebuggerSessionMessage {
  const frame = value as LatestDebuggerSessionMessage | null;
  return (
    frame?.message === 'latest-session' &&
    frame.data?.protocol === 2 &&
    (frame.data.channel === null ||
      (typeof frame.data.channel === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(frame.data.channel))) &&
    frame.data.channelIsolation === true &&
    frame.data.runScopedControls === true &&
    (frame.data.historyThrough === undefined ||
      (Array.isArray(frame.data.historyThrough) &&
        frame.data.historyThrough.length <= 8192 &&
        frame.data.historyThrough.every((id) => readLatestDebuggerEventPosition(id) !== undefined)))
  );
}

/** Validate the routing contract only. Authored data and decoded sentinels stay intact. */
export function readLatestDebuggerExecution(value: unknown): LatestDebuggerExecutionMessage | undefined {
  const frame = value as { message?: unknown; data?: unknown; rivetScope?: unknown } | null;
  if (!frame || typeof frame.message !== 'string' || !isLatestDebuggerScope(frame.rivetScope)) return;
  if (!isLatestDebuggerExecutionMessage(frame.message)) return;
  if (frame.message === 'latest-prompt-closed') {
    const id = (frame.data as { promptId?: unknown } | null)?.promptId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return;
  }
  const root = (frame.data as { execution?: { rootRunId?: unknown } } | null)?.execution?.rootRunId;
  if (root !== undefined && root !== frame.rivetScope.rootRunId) return;
  return value as LatestDebuggerExecutionMessage;
}

export function createLatestDebuggerDiagnostic(code: LatestDebuggerDiagnosticCode): LatestDebuggerDiagnosticMessage {
  return { message: 'latest-diagnostic', data: { protocol: 1, code } };
}

export function isLatestDebuggerDiagnostic(value: unknown): value is LatestDebuggerDiagnosticMessage {
  const frame = value as LatestDebuggerDiagnosticMessage | null;
  return (
    frame?.message === 'latest-diagnostic' && frame.data?.protocol === 1 && diagnosticCodes.includes(frame.data.code)
  );
}

export function createLatestDebuggerControlResult(
  commandId: string,
  result: LatestDebuggerControlResult,
): LatestDebuggerControlResultMessage {
  return {
    message: 'latest-control-result',
    data: { status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }), commandId },
  };
}

/** Validate only the wire control contract, never authored graph payloads. */
export function readLatestDebuggerControl(value: unknown): LatestDebuggerControlMessage | undefined {
  const message = value as LatestDebuggerControlMessage | null;
  const data = message?.data;
  if (
    message?.type !== 'latest-control' ||
    !data ||
    typeof data.commandId !== 'string' ||
    !data.commandId ||
    data.commandId.length > 200 ||
    !isLatestDebuggerScope(data.target)
  )
    return;
  if (data.action === 'pause' || data.action === 'resume' || data.action === 'abort') return message;
  if (
    data.action === 'user-input' &&
    typeof data.promptId === 'string' &&
    data.promptId.length > 0 &&
    data.promptId.length <= 200 &&
    data.answers?.type === 'string[]' &&
    Array.isArray(data.answers.value) &&
    data.answers.value.every((answer) => typeof answer === 'string')
  )
    return message;
}

export function readLatestDebuggerEventId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const id = (value as { rivetEventId?: unknown }).rivetEventId;
  return typeof id === 'string' && /^[a-z0-9:-]{1,200}$/.test(id) ? id : undefined;
}

export function readLatestDebuggerEventPosition(value: unknown): { origin: string; sequence: number } | undefined {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-z0-9:-]+:[1-9]\d{0,15}$/.test(value)) return;
  const split = value.lastIndexOf(':');
  const sequence = Number(value.slice(split + 1));
  if (!Number.isSafeInteger(sequence)) return;
  return { origin: value.slice(0, split), sequence };
}

export function isLatestDebuggerControlResult(value: unknown): value is LatestDebuggerControlResultMessage {
  const message = value as LatestDebuggerControlResultMessage | null;
  return (
    message?.message === 'latest-control-result' &&
    typeof message.data?.commandId === 'string' &&
    message.data.commandId.length > 0 &&
    message.data.commandId.length <= 200 &&
    ['accepted', 'rejected', 'outcome-unknown'].includes(message.data.status) &&
    (message.data.reason === undefined || typeof message.data.reason === 'string')
  );
}

/** Input is a decoded single path segment. Never decode it again. */
export function parseLatestEndpointSegment(segment: string): { endpointName: string; channel: LatestDebuggerChannel } {
  const [endpointName, channel, extra] = segment.split('@');
  if (
    !endpointName ||
    !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(endpointName) ||
    extra !== undefined ||
    (channel !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(channel))
  )
    throw new Error('Invalid latest endpoint or debugger channel');
  return { endpointName, channel: channel ?? null };
}

/** URL.pathname is still encoded. Decode exactly once, rejecting path separators. */
export function parseLatestDebuggerPath(pathname: string): LatestDebuggerChannel {
  const decoded = decodeURIComponent(pathname);
  if (decoded === LATEST_DEBUGGER_PATH) return null;
  if (!decoded.startsWith(`${LATEST_DEBUGGER_PATH}@`)) throw new Error('Invalid latest debugger path');
  const channel = decoded.slice(LATEST_DEBUGGER_PATH.length + 1);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(channel)) throw new Error('Invalid debugger channel');
  return channel;
}

export function isLatestDebuggerScope(value: unknown): value is LatestDebuggerScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as LatestDebuggerScope;
  return (
    (scope.channel === null || (typeof scope.channel === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(scope.channel))) &&
    [scope.rootRunId, scope.projectId, scope.owner, scope.incarnation].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 200,
    ) &&
    (scope.promptId === undefined ||
      (typeof scope.promptId === 'string' && scope.promptId.length > 0 && scope.promptId.length <= 200)) &&
    (scope.admittedAt === undefined || (Number.isSafeInteger(scope.admittedAt) && scope.admittedAt >= 0)) &&
    (scope.promptLifecycle === undefined || scope.promptLifecycle === 1)
  );
}
