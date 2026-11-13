export type RecordingDiagnosticContext = {
  projectId?: string;
  graphId?: string;
  correlationId?: string;
  recordingId?: string;
  runKind?: string;
  surface?: string;
  phase?: 'admission' | 'serialization' | 'persistence' | 'notification' | 'cleanup';
};

/** Identifiers only: provider errors and Code-node exceptions may contain secrets. */
export function reportRecordingFailure(error: unknown, context: RecordingDiagnosticContext = {}): void {
  try {
    const fields = Object.fromEntries(
      (['projectId', 'graphId', 'correlationId', 'recordingId', 'runKind', 'surface', 'phase'] as const).flatMap(
        (key) => {
          const value = context[key];
          return typeof value === 'string' ? [[key, value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160)]] : [];
        },
      ),
    );
    const errorName = error instanceof Error ? error.name : undefined;
    const errorType =
      typeof errorName === 'string' &&
      ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError'].includes(errorName)
        ? errorName
        : 'UnknownError';
    const code =
      error instanceof Error && error.message === 'Managed app settings synchronization is unavailable or stale.'
        ? 'settings_unavailable'
        : 'recording_failed';
    console.error('[workflow-recordings] Recording operation failed.', { ...fields, errorType, code });
  } catch {
    // Reporting cannot replace a graph outcome or invalidate a committed replay.
  }
}

export async function notifyRecordingPersisted(
  callback: ((recordingId: string) => Promise<void>) | undefined,
  recordingId: string,
  context: RecordingDiagnosticContext,
): Promise<void> {
  try {
    await callback?.(recordingId);
  } catch (error) {
    reportRecordingFailure(error, { ...context, recordingId, phase: 'notification' });
  }
}
