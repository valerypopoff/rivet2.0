import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import type { WorkflowRecordingBlobEncoding } from '../../../../studio-server-shared/workflow-recording-types.js';
import {
  extractWorkflowInputFromSerializedRecording,
  type WorkflowRecordingExtractedInput,
} from './recording-input-filter.js';

/**
 * A recording source for input extraction. Artifact bytes intentionally remain
 * encoded until the bounded extraction worker receives them, so a large gzip
 * payload never expands into a decoded JavaScript string on the API thread.
 */
export type WorkflowRecordingInputSource =
  | {
      kind: 'serialized';
      serializedRecording: string;
    }
  | {
      kind: 'artifact';
      bytes: Uint8Array;
      encoding: WorkflowRecordingBlobEncoding;
    };

/**
 * Durations produced where extraction actually happens. They deliberately do
 * not include artifact I/O or worker-message transit; those belong to the
 * caller and make benchmark reports actionable instead of a single opaque
 * number.
 */
export type WorkflowRecordingInputExtractionTiming = {
  decompressionMs: number;
  parseAndExtractMs: number;
};

export function normalizeWorkflowRecordingInputSource(
  source: WorkflowRecordingInputSource | string,
): WorkflowRecordingInputSource {
  return typeof source === 'string' ? { kind: 'serialized', serializedRecording: source } : source;
}

export function extractWorkflowRecordingInputFromSource(
  source: WorkflowRecordingInputSource,
): WorkflowRecordingExtractedInput | null {
  return extractWorkflowRecordingInputFromSourceWithTiming(source).input;
}

export function extractWorkflowRecordingInputFromSourceWithTiming(source: WorkflowRecordingInputSource): {
  input: WorkflowRecordingExtractedInput | null;
  timing: WorkflowRecordingInputExtractionTiming;
} {
  const decodeStartedAt = performance.now();
  const serializedRecording =
    source.kind === 'serialized'
      ? source.serializedRecording
      : decodeWorkflowRecordingArtifact(source.bytes, source.encoding);
  const decompressionMs = source.kind === 'serialized' ? 0 : performance.now() - decodeStartedAt;
  const parseStartedAt = performance.now();
  const input = extractWorkflowInputFromSerializedRecording(serializedRecording);
  if (input == null) {
    // A valid recording with no captured input returns exists:false. Do not
    // silently classify malformed content as a completed non-matching search.
    throw new Error('Malformed recording artifact: expected valid JSON with a recording object.');
  }
  return {
    input,
    timing: {
      decompressionMs,
      parseAndExtractMs: performance.now() - parseStartedAt,
    },
  };
}

function decodeWorkflowRecordingArtifact(bytes: Uint8Array, encoding: WorkflowRecordingBlobEncoding): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (encoding === 'gzip' ? gunzipSync(buffer) : buffer).toString('utf8');
}
