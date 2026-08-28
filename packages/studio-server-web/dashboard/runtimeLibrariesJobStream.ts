import type { RuntimeLibraryJobLogEntry } from './runtimeLibrariesApi';
import { streamJobLogs, type JobState, type JobStatus, type SSEEvent } from './runtimeLibrariesApi';

export function mergeRuntimeLibraryLogEntries(
  previous: RuntimeLibraryJobLogEntry[],
  incoming: RuntimeLibraryJobLogEntry[],
): RuntimeLibraryJobLogEntry[] {
  if (incoming.length === 0) {
    return previous;
  }

  const seen = new Set(previous.map((entry) => `${entry.createdAt}\u0000${entry.source}\u0000${entry.message}`));
  const merged = [...previous];

  for (const entry of incoming) {
    const key = `${entry.createdAt}\u0000${entry.source}\u0000${entry.message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(entry);
  }

  return merged;
}

export function openRuntimeLibrariesJobStream(
  jobId: string,
  options: {
    onLog(entry: RuntimeLibraryJobLogEntry): void;
    onStatus(event: Extract<SSEEvent, { type: 'status' }>): void;
    onDone(event: Extract<SSEEvent, { type: 'done' }>): void;
    onError(): void;
  },
): EventSource {
  return streamJobLogs(
    jobId,
    (event: SSEEvent) => {
      if (event.type === 'log' && event.message) {
        options.onLog({
          message: event.message,
          createdAt: event.createdAt ?? new Date().toISOString(),
          source: event.source ?? 'system',
        });
        return;
      }

      if (event.type === 'status' && event.status) {
        options.onStatus(event as Extract<SSEEvent, { type: 'status' }>);
        return;
      }

      if (event.type === 'done') {
        options.onDone(event as Extract<SSEEvent, { type: 'done' }>);
      }
    },
    () => {
      options.onError();
    },
  );
}

export function patchRuntimeLibrariesJobLogState(
  base: JobState,
  nextLogEntries: RuntimeLibraryJobLogEntry[],
  lastProgressAt?: string | null,
): JobState {
  return {
    ...base,
    logs: nextLogEntries.map((entry) => entry.message),
    logEntries: nextLogEntries,
    lastProgressAt: lastProgressAt ?? base.lastProgressAt,
  };
}

export function patchRuntimeLibrariesJobStatusState(
  base: JobState,
  patch: {
    status: JobStatus;
    error?: string;
    createdAt?: string | null;
    cancelRequestedAt?: string | null;
  },
): JobState {
  return {
    ...base,
    status: patch.status,
    error: patch.error ?? base.error,
    lastProgressAt: patch.createdAt ?? base.lastProgressAt,
    cancelRequestedAt: patch.cancelRequestedAt ?? base.cancelRequestedAt,
  };
}
