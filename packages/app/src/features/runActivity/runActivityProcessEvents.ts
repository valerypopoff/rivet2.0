import type { ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import {
  reduceRunActivityJournal,
  type RunActivityEvent,
  type RunActivityJournal,
  type RunActivityResultOrigin,
} from './runActivityJournal.js';

export type RunActivityProcessEventName = RunActivityEvent['type'];

const RUN_ACTIVITY_PROCESS_EVENT_NAMES = new Set<keyof ProcessEventMessageMap>([
  'start',
  'graphStart',
  'graphOutputsReady',
  'graphFinish',
  'graphError',
  'graphAbort',
  'nodeStart',
  'partialOutput',
  'nodeFinish',
  'nodeError',
  'nodeExcluded',
  'nodeOutputsCleared',
  'llmCallFinished',
  'toolCallFinished',
  'done',
  'abort',
  'error',
  'pause',
  'resume',
]);

export function isRunActivityProcessEventName(
  message: keyof ProcessEventMessageMap,
): message is RunActivityProcessEventName {
  return RUN_ACTIVITY_PROCESS_EVENT_NAMES.has(message);
}

export function applyProcessEventToRunActivityJournal<K extends keyof ProcessEventMessageMap>(options: {
  data: ProcessEventMessageMap[K];
  journal: RunActivityJournal;
  message: K;
  occurredAt: number;
}): RunActivityJournal {
  if (!isRunActivityProcessEventName(options.message)) {
    return options.journal;
  }

  return reduceRunActivityJournal(options.journal, {
    type: options.message,
    data: options.data,
    occurredAt: options.occurredAt,
    resultOrigin: getResultOrigin(options.message, options.data),
  } as RunActivityEvent);
}

function getResultOrigin(message: keyof ProcessEventMessageMap, data: unknown): RunActivityResultOrigin | undefined {
  if (typeof data !== 'object' || data == null) {
    return undefined;
  }

  const candidate = data as { processId?: unknown; resultOrigin?: unknown };
  if (
    candidate.resultOrigin === 'executed' ||
    candidate.resultOrigin === 'preloaded' ||
    candidate.resultOrigin === 'frozen' ||
    candidate.resultOrigin === 'editor-cache' ||
    candidate.resultOrigin === 'unknown'
  ) {
    return candidate.resultOrigin;
  }

  // GraphProcessor uses this reserved process identity for editor run-from
  // preload events. Current runtimes otherwise emit resultOrigin explicitly;
  // missing metadata belongs to an older host or recording and must remain
  // unknown rather than being inferred from the event shape.
  if (candidate.processId === 'preload') return 'preloaded';
  return message === 'nodeStart' ||
    message === 'partialOutput' ||
    message === 'nodeFinish' ||
    message === 'nodeError' ||
    message === 'nodeExcluded'
    ? 'unknown'
    : undefined;
}
