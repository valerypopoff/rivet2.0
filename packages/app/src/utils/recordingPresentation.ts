import type { ExecutionRecorder, GraphExecutionMetadata, RecordedEvents } from '@valerypopoff/rivet2-core';
import { getRecordingPlaybackGraphId } from './recordingPlayback.js';

/** Optional display snapshot; never used to authorize or execute playback. */
export type RecordingRunDetails = {
  id?: string;
  workflowId?: string;
  createdAt: string;
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  runKind?: 'published' | 'latest' | 'editor';
  sourceProjectName?: string;
  sourceProjectRelativePath?: string;
  endpointNameAtExecution?: string;
  errorMessage?: string;
  executionIdentity?: { surface: string; graphName?: string; scheduleName?: string; correlationId?: string };
};

export const RECORDING_STATUS_LABELS = { succeeded: 'Succeeded', failed: 'Failed', suspicious: 'Suspicious' };
export const SUSPICIOUS_RECORDING_DETAIL =
  'Completed without throwing, but the final output was control-flow-excluded.';
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
export function formatRecordingTimestamp(value: string | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timestampFormatter.format(date);
}
export function formatRecordingDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'Unavailable';
  if (durationMs < 1000) return `${durationMs.toFixed(2)} ms`;
  const centiseconds = Math.round(durationMs / 10);
  if (centiseconds < 6000) return `${(centiseconds / 100).toFixed(2)} s`;
  return `${Math.floor(centiseconds / 6000)}m ${((centiseconds % 6000) / 100).toFixed(2)}s`;
}

export function getRecordingPresentation(recording: { recorder: ExecutionRecorder; summary?: RecordingRunDetails }) {
  const events = recording.recorder.events;
  const graphId = getRecordingPlaybackGraphId(events);
  const start = events.find((event) => event.type === 'start');
  const graphStart = events.find((event) => event.type === 'graphStart' && event.data.graphId === graphId);
  const rootExecution = start?.data.execution ?? (graphStart?.type === 'graphStart' ? graphStart.data.execution : undefined);
  const isRootGraph = (data: { graphId: string; execution?: GraphExecutionMetadata }) =>
    data.graphId === graphId &&
    (!rootExecution ||
      (data.execution?.rootRunId === rootExecution.rootRunId &&
        data.execution?.graphRunId === rootExecution.graphRunId));
  const failure = events.find(
    (event) =>
      event.type === 'error' ||
      (event.type === 'abort' && !event.data?.successful) ||
      (event.type === 'graphError' && isRootGraph(event.data)) ||
      (event.type === 'graphAbort' && isRootGraph(event.data) && !event.data.successful),
  );
  let terminal: Extract<RecordedEvents, { type: 'done' | 'graphFinish' }> | undefined;
  for (const event of events) {
    if (event.type === 'done' || (event.type === 'graphFinish' && isRootGraph(event.data))) terminal = event;
  }
  const outputs =
    terminal?.type === 'done'
      ? terminal.data.results
      : terminal?.type === 'graphFinish'
        ? terminal.data.outputs
        : undefined;
  const inferred = failure
    ? 'failed'
    : !terminal || outputs?.output?.type === 'control-flow-excluded'
      ? 'suspicious'
      : 'succeeded';
  const summary = recording.summary;
  const status = summary?.status ?? inferred;
  const first = events[0]?.ts;
  const failureMessage =
    failure && failure.data && typeof failure.data === 'object' && 'error' in failure.data
      ? String(failure.data.error ?? '')
      : undefined;
  const started = first != null ? new Date(first) : undefined;
  return {
    status,
    color: status === 'failed' ? 'var(--error)' : status === 'succeeded' ? 'var(--success)' : 'var(--warning)',
    label: summary || terminal || failure ? RECORDING_STATUS_LABELS[status] : 'Outcome unavailable',
    createdAt:
      summary?.createdAt ?? (started && Number.isFinite(started.getTime()) ? started.toISOString() : undefined),
    endpoint:
      summary?.executionIdentity?.surface === 'subgraph_project' ? undefined : summary?.endpointNameAtExecution?.trim(),
    detail:
      summary?.errorMessage ??
      ((!summary && failureMessage) ||
        (status === 'suspicious'
          ? summary || terminal
            ? SUSPICIOUS_RECORDING_DETAIL
            : 'This recording has no terminal outcome. Its result cannot be confirmed.'
          : undefined)),
  };
}
