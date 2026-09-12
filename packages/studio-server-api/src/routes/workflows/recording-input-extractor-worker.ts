import { parentPort } from 'node:worker_threads';

import {
  extractWorkflowRecordingInputFromSourceWithTiming,
  type WorkflowRecordingInputSource,
} from './recording-input-source.js';

type ExtractRequest = {
  id: number;
  source: WorkflowRecordingInputSource;
};

parentPort?.on('message', (message: ExtractRequest) => {
  try {
    parentPort?.postMessage({
      id: message.id,
      ...extractWorkflowRecordingInputFromSourceWithTiming(message.source),
    });
  } catch (error: unknown) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
