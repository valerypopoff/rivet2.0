import { useMemo } from 'react';
import type { LoadedRecording } from '../state/execution.js';
import { formatRecordingTimestamp, getRecordingPresentation } from '../utils/recordingPresentation.js';

export function LoadedRecordingInfo({ recording }: { recording: LoadedRecording }) {
  const info = useMemo(() => getRecordingPresentation(recording), [recording]);
  return (
    <div className="loaded-recording-info" data-recording-status={info.status}>
      <div className="loaded-recording-heading">
        <strong className="loaded-recording-tag" style={{ color: info.color }}>
          {info.label}
        </strong>
        <span>{info.createdAt ? formatRecordingTimestamp(info.createdAt) : 'Time unavailable'}</span>
      </div>
      <div>
        <span className="loaded-recording-label">Endpoint at execution:</span> {info.endpoint || '—'}
      </div>
      {info.detail && (
        <div className="loaded-recording-detail" style={{ borderColor: info.color }}>
          {info.detail}
        </div>
      )}
    </div>
  );
}
