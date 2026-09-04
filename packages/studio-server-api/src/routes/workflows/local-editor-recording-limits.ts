export const MAX_LOCAL_EDITOR_RECORDING_UPLOAD_BYTES = 24 * 1024 * 1024;

// The content limit above applies to the decoded UTF-8 snapshots. Their JSON
// transport can grow because project and recording strings must escape quotes,
// backslashes, and line breaks. Keep the parser well below the general 100 MiB
// control-plane cap without rejecting valid content solely for its encoding.
export const MAX_LOCAL_EDITOR_RECORDING_REQUEST_BYTES = 48 * 1024 * 1024;
