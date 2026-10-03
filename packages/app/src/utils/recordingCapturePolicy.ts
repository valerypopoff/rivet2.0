/** Playback delivers historical events; only a live execution may create new evidence. */
export function shouldCaptureExecutionRecording(options: { recordExecutions: boolean; isPlayback: boolean }): boolean {
  return options.recordExecutions && !options.isPlayback;
}

/** Successful early termination is not a failure; cleanup cannot demote a failed run. */
export function recordingStatusAfterAbort(
  status: 'succeeded' | 'failed' | 'suspicious',
  successful: boolean,
): 'succeeded' | 'failed' | 'suspicious' {
  return successful || status !== 'succeeded' ? status : 'suspicious';
}
