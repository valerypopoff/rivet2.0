// Benchmark-only candidate. Not imported by the server or selected at runtime.
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parseJsonStreamWithPaths, streamToIterable } from 'json-stream-es';
import { extractWorkflowInputFromSerializedRecording } from '../routes/workflows/recording-input-filter.js';

export async function extractStreamPrototype(bytes: Uint8Array) {
  const compressed = Readable.from(
    (function* () {
      for (let index = 0; index < bytes.length; index += 65536) yield bytes.subarray(index, index + 65536);
    })(),
  );
  const gunzip = createGunzip();
  compressed.on('error', (error) => gunzip.destroy(error));
  const decoded = Readable.toWeb(compressed.pipe(gunzip)) as ReadableStream<Uint8Array>;
  const selected = decoded
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      parseJsonStreamWithPaths(
        (path) =>
          (path.length === 2 && path[0] === 'recording' && path[1] === 'events') ||
          (path.length === 1 && path[0] === 'strings'),
      ),
    );
  const events: unknown[] = [];
  const strings: Record<string, unknown> = Object.create(null);
  try {
    for await (const { path, value } of streamToIterable(selected)) {
      if (path[0] === 'strings') strings[String(path[1])] = value;
      else if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value.type === 'start' || value.type === 'graphStart')
      )
        events.push(value);
    }
    return extractWorkflowInputFromSerializedRecording(JSON.stringify({ recording: { events }, strings }));
  } finally {
    compressed.destroy();
    gunzip.destroy();
  }
}
