const messages = {
  'history-truncated':
    'Latest debugger history was truncated by its replay limit. Earlier diagnostics may be unavailable; executions were not replayed.',
  'history-gap':
    'Latest debugger history has a gap. Earlier diagnostics may be unavailable; executions were not replayed.',
  'event-too-large':
    'A latest debugger event exceeded its diagnostic size limit. Some diagnostic values were omitted; the execution was not interrupted.',
  'owner-unavailable': 'A debugger owner is unavailable. The control was not retried.',
} as const;

export type LatestDebuggerDiagnostic = { code: keyof typeof messages; message: string };

/** Session notices are not graph-terminal errors. Recognize exact old notices
 * as well so that mixed-version HA rollouts do not break active observations. */
export function readLatestDebuggerDiagnostic(value: unknown): LatestDebuggerDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as { message?: unknown; requestId?: unknown; data?: unknown };
  if (!envelope.data || typeof envelope.data !== 'object') return undefined;
  const data = envelope.data as { protocol?: unknown; code?: unknown; error?: unknown; execution?: unknown };
  if (
    envelope.message === 'latest-diagnostic' &&
    data.protocol === 1 &&
    typeof data.code === 'string' &&
    Object.hasOwn(messages, data.code)
  ) {
    const code = data.code as keyof typeof messages;
    return { code, message: messages[code] };
  }
  if (envelope.message === 'error' && envelope.requestId == null && data.execution == null) {
    for (const code of ['history-truncated', 'history-gap', 'owner-unavailable'] as const)
      if (data.error === messages[code]) return { code, message: messages[code] };
  }
  return undefined;
}
