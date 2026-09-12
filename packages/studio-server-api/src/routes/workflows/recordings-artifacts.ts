import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import type { WorkflowRecordingBlobEncoding } from '../../../../studio-server-shared/workflow-recording-types.js';
import {
  getWorkflowRecordingPath,
  getWorkflowRecordingReplayDatasetPath,
  getWorkflowRecordingReplayProjectPath,
} from './fs-helpers.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type WorkflowRecordingArtifactKind = 'recording' | 'replay-project' | 'replay-dataset';

export function getRecordingArtifactPath(
  bundlePath: string,
  artifact: WorkflowRecordingArtifactKind,
  encoding: WorkflowRecordingBlobEncoding,
): string {
  switch (artifact) {
    case 'recording':
      return getWorkflowRecordingPath(bundlePath, encoding);
    case 'replay-project':
      return getWorkflowRecordingReplayProjectPath(bundlePath, encoding);
    case 'replay-dataset':
      return getWorkflowRecordingReplayDatasetPath(bundlePath, encoding);
  }
}

export async function readArtifactBuffer(
  filePath: string,
  encoding: WorkflowRecordingBlobEncoding,
  signal?: AbortSignal,
): Promise<{ compressed: Buffer; uncompressed: Buffer }> {
  const compressed = await readArtifactCompressedBuffer(filePath, signal);
  return {
    compressed,
    uncompressed: encoding === 'gzip' ? await gunzipAsync(compressed) : compressed,
  };
}

/**
 * Reads the stored bytes without decompressing or decoding them. Input-filter
 * extraction transfers these bytes to its worker, keeping large-recording
 * decompression and JSON parsing off the API event loop.
 */
export async function readArtifactCompressedBuffer(
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return fs.readFile(filePath, { signal });
}

export async function readArtifactBytes(
  filePath: string,
  encoding: WorkflowRecordingBlobEncoding,
): Promise<{ compressedBytes: number; uncompressedBytes: number }> {
  const { compressed, uncompressed } = await readArtifactBuffer(filePath, encoding);
  return {
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

export async function serializeArtifact(
  text: string,
  encoding: WorkflowRecordingBlobEncoding,
  gzipLevel: number,
): Promise<{ buffer: Buffer; compressedBytes: number; uncompressedBytes: number }> {
  const uncompressed = Buffer.from(text, 'utf8');
  if (encoding === 'identity') {
    return {
      buffer: uncompressed,
      compressedBytes: uncompressed.byteLength,
      uncompressedBytes: uncompressed.byteLength,
    };
  }

  const compressed = await gzipAsync(uncompressed, { level: gzipLevel });
  return {
    buffer: compressed,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

export async function readArtifactText(
  filePath: string,
  encoding: WorkflowRecordingBlobEncoding,
  signal?: AbortSignal,
): Promise<string> {
  const { uncompressed } = await readArtifactBuffer(filePath, encoding, signal);
  return uncompressed.toString('utf8');
}
