/** Playback delivers historical events; only a live execution may create new evidence. */
export function shouldCaptureExecutionRecording(options: { recordExecutions: boolean; isPlayback: boolean }): boolean {
  return options.recordExecutions && !options.isPlayback;
}
