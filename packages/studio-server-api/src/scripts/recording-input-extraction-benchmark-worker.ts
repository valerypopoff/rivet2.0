import { parentPort } from 'node:worker_threads';
import { extractWorkflowRecordingInputFromSourceWithTiming } from '../routes/workflows/recording-input-source.js';
import { extractStreamPrototype } from './recording-input-stream-prototype.js';

async function measure({ bytes, mode }: { bytes: Uint8Array; mode: string }) {
  const start = performance.now();
  try {
    const input =
      mode === 'tokenizer'
        ? await extractStreamPrototype(bytes)
        : extractWorkflowRecordingInputFromSourceWithTiming({ kind: 'artifact', encoding: 'gzip', bytes }).input;
    const result = { input, elapsedMs: performance.now() - start, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
    if (parentPort) parentPort.postMessage(result);
    else process.send?.(result);
  } catch (error) {
    const result = { error: error instanceof Error ? error.message : String(error) };
    if (parentPort) parentPort.postMessage(result);
    else process.send?.(result);
  }
}
if (parentPort) parentPort.on('message', measure);
else
  process.on('message', (message) => {
    void measure(message as { bytes: Uint8Array; mode: string });
  });
