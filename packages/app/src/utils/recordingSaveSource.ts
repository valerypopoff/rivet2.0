import type { ExecutionRecorder } from '@valerypopoff/rivet2-core';

export type RecordingSaveSource =
  | { kind: 'loaded-recording'; recorder: ExecutionRecorder }
  | { kind: 'last-live-recording'; serialized: string };

/**
 * Playback is a read-only view of past execution evidence. Export that
 * original artifact before considering the tab's most recent live recording.
 */
export function getRecordingSaveSource(options: {
  loadedRecording: { recorder: ExecutionRecorder } | undefined;
  lastLiveRecording: string | undefined;
}): RecordingSaveSource | undefined {
  if (options.loadedRecording != null) {
    return { kind: 'loaded-recording', recorder: options.loadedRecording.recorder };
  }

  return options.lastLiveRecording == null
    ? undefined
    : { kind: 'last-live-recording', serialized: options.lastLiveRecording };
}

export function serializeRecordingSaveSource(source: RecordingSaveSource): string {
  return source.kind === 'loaded-recording' ? source.recorder.serialize() : source.serialized;
}
