import Button from '@atlaskit/button';
import type { FC, RefObject } from 'react';

import type { JobState, RuntimeLibraryJobLogEntry } from './runtimeLibrariesApi';

interface RuntimeLibrariesJobPanelProps {
  displayedJob: JobState | null;
  logEntries: RuntimeLibraryJobLogEntry[];
  jobResult: { status: 'succeeded' | 'failed'; error?: string } | null;
  isJobActive: boolean;
  isStalled: boolean;
  nowMs: number;
  cancellingJob: boolean;
  logPanelRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatLogTimestamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export const RuntimeLibrariesJobPanel: FC<RuntimeLibrariesJobPanelProps> = ({
  displayedJob,
  logEntries,
  jobResult,
  isJobActive,
  isStalled,
  nowMs,
  cancellingJob,
  logPanelRef,
  onCancel,
}) => {
  if (!displayedJob && !jobResult && logEntries.length === 0) {
    return null;
  }

  const lastProgressAtMs = displayedJob?.lastProgressAt ? new Date(displayedJob.lastProgressAt).getTime() : null;
  const phaseLabel = displayedJob ? (
    displayedJob.status === 'queued' ? 'Queued' :
      displayedJob.status === 'running' ? 'Installing dependencies' :
        displayedJob.status === 'validating' ? 'Validating release' :
          displayedJob.status === 'activating' ? 'Activating release' :
            displayedJob.status === 'succeeded' ? 'Completed' : 'Failed'
  ) : null;
  const elapsedMs = displayedJob
    ? Math.max(0, nowMs - new Date(displayedJob.startedAt ?? displayedJob.createdAt).getTime())
    : 0;
  const statusToneClass = jobResult
    ? jobResult.status
    : isStalled
      ? 'warning'
      : isJobActive
        ? 'running'
        : 'idle';

  return (
    <div className="project-settings-field runtime-libraries-section">
      <label className="project-settings-label">
        {displayedJob?.type === 'remove' ? 'Remove job' : 'Install job'}
      </label>

      {isJobActive ? (
        <>
          <div className={`runtime-libraries-status ${statusToneClass}`}>
            <div className="runtime-libraries-status-head">
              <span>Status: {phaseLabel}</span>
              <span>{formatDuration(elapsedMs)} elapsed</span>
            </div>
            {displayedJob?.cancelRequestedAt ? (
              <div className="runtime-libraries-status-detail">
                Cancellation requested. Waiting for the backend to stop the job safely.
              </div>
            ) : null}
            {isStalled ? (
              <div className="runtime-libraries-status-detail">
                No new output for {formatDuration(nowMs - (lastProgressAtMs ?? nowMs))}. The job may be stalled.
              </div>
            ) : null}
          </div>
          <div className="runtime-libraries-job-actions">
            <Button
              appearance="subtle"
              className="runtime-libraries-cancel-button button-size-s"
              onClick={onCancel}
              isDisabled={cancellingJob || Boolean(displayedJob?.cancelRequestedAt)}
            >
              {displayedJob?.cancelRequestedAt || cancellingJob ? 'Cancelling...' : 'Cancel job'}
            </Button>
          </div>
        </>
      ) : null}

      {jobResult ? (
        <div className={`runtime-libraries-status ${jobResult.status}`}>
          {jobResult.status === 'succeeded' ? 'Completed successfully' : `Failed: ${jobResult.error ?? 'Unknown error'}`}
        </div>
      ) : null}

      {logEntries.length > 0 ? (
        <div className="runtime-libraries-log-panel" ref={logPanelRef}>
          {logEntries.map((entry, index) => (
            <div
              key={`${entry.createdAt}-${entry.source}-${index}`}
              className={`runtime-libraries-log-line${entry.message.startsWith('ERROR:') ? ' error' : ''}`}
            >
              <span className="runtime-libraries-log-meta">
                [{formatLogTimestamp(entry.createdAt)}] [{entry.source}]
              </span>{' '}
              {entry.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
