import type Emittery from 'emittery';
import type { GraphProcessor, ProcessEvents } from './GraphProcessor.js';
import { getGraphAbortReasonFromSignal } from './GraphAbortReasons.js';

type GraphLifecycleEvent = ProcessEvents['graphFinish'] | ProcessEvents['graphAbort'] | ProcessEvents['graphError'];

function subscribeOwnGraphRunLifecycle(processor: GraphProcessor, onLifecycleEvent: () => void): () => void {
  let ownGraphRunId: ProcessEvents['graphStart']['execution']['graphRunId'] | undefined;

  const unsubscribeGraphStart = processor.on('graphStart', (event) => {
    ownGraphRunId ??= event.execution.graphRunId;
  });

  const onPossibleLifecycleEvent = (event: GraphLifecycleEvent) => {
    if (ownGraphRunId != null && event.execution.graphRunId === ownGraphRunId) {
      onLifecycleEvent();
    }
  };

  const unsubscribeGraphFinish = processor.on('graphFinish', onPossibleLifecycleEvent);
  const unsubscribeGraphAbort = processor.on('graphAbort', onPossibleLifecycleEvent);
  const unsubscribeGraphError = processor.on('graphError', onPossibleLifecycleEvent);

  return () => {
    unsubscribeGraphStart();
    unsubscribeGraphFinish();
    unsubscribeGraphAbort();
    unsubscribeGraphError();
  };
}

export function wireSubprocessorEvents(
  processor: GraphProcessor,
  parentEmitter: Emittery<ProcessEvents>,
  parentState: {
    autoCleanup?: boolean;
    isPaused: () => boolean;
    pause: () => void;
    resume: () => void;
    /** Intercepts forwarded child evidence before it reaches outer observers. */
    forwardEvent?: <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]) => Promise<void> | undefined;
  },
): () => void {
  const forward = <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]): Promise<void> | undefined => {
    // `undefined` is a deliberate interceptor result: the Watch history
    // boundary uses it to retain an event without forwarding it yet. Do not
    // fall through to the parent emitter in that case.
    if (parentState.forwardEvent) {
      return parentState.forwardEvent(event, data);
    }
    return parentEmitter.emit(event, data);
  };
  // Some successful graph-abort paths can emit node terminals just after their
  // graph-level terminal event. Keep passive forwarding alive for the
  // subprocessor object lifetime so remote-debugger/recorder consumers do not
  // miss those node terminals.
  const passiveUnsubscribers = [
    processor.on('nodeError', (event) => forward('nodeError', event)),
    processor.on('nodeFinish', (event) => forward('nodeFinish', event)),
    processor.on('partialOutput', (event) => forward('partialOutput', event)),
    processor.on('progress', (event) => forward('progress', event)),
    processor.on('llmCallFinished', (event) => forward('llmCallFinished', event)),
    processor.on('llmChatOutputSnapshot', (event) => forward('llmChatOutputSnapshot', event)),
    processor.on('llmProfileAttempt', (event) => forward('llmProfileAttempt', event)),
    processor.on('toolCallFinished', (event) => forward('toolCallFinished', event)),
    processor.on('nodeExcluded', (event) => forward('nodeExcluded', event)),
    processor.on('nodeStart', (event) => forward('nodeStart', event)),
    processor.on('graphAbort', (event) => forward('graphAbort', event)),
    processor.on('graphError', (event) => forward('graphError', event)),
    processor.on('userInput', (event) => forward('userInput', event)),
    processor.on('graphStart', (event) => forward('graphStart', event)),
    processor.on('graphFinish', (event) => forward('graphFinish', event)),
    processor.on('nodeOutputsCleared', (event) => forward('nodeOutputsCleared', event)),
    processor.on('streamingOutputWatchSummary', (event) => forward('streamingOutputWatchSummary', event)),
    processor.on('globalSet', (event) => forward('globalSet', event)),
    processor.on('newAbortController', (event) => forward('newAbortController', event)),
  ];

  const controlUnsubscribers: Array<() => void> = [
    processor.on('pause', () => {
      if (!parentState.isPaused()) {
        parentState.pause();
      }
    }),
    processor.on('resume', () => {
      if (parentState.isPaused()) {
        parentState.resume();
      }
    }),
  ];

  const unsubscribeAny = processor.onAny((event, data) => {
    if (event.startsWith('globalSet:')) {
      void forward(event, data);
    }
  });

  let controlsCleanedUp = false;
  const cleanupControls = () => {
    if (controlsCleanedUp) {
      return;
    }

    controlsCleanedUp = true;
    controlUnsubscribers.forEach((unsubscribe) => unsubscribe());
  };

  if (parentState.autoCleanup !== false) {
    controlUnsubscribers.push(subscribeOwnGraphRunLifecycle(processor, cleanupControls));
  }

  return () => {
    cleanupControls();
    passiveUnsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribeAny();
  };
}

export function wireSubprocessorLifecycle(
  processor: GraphProcessor,
  options: {
    autoCleanup?: boolean;
    signal?: AbortSignal;
    parentAbortSignal: AbortSignal;
    onParentPause: (listener: () => void) => () => void;
    onParentResume: (listener: () => void) => () => void;
  },
): () => void {
  let unsubscribePendingAbort: (() => void) | undefined;
  const abortProcessor = (successful: boolean, error?: Error | string) => {
    if (processor.isRunning) {
      void processor.abort(successful, error);
      return;
    }

    unsubscribePendingAbort ??= processor.on('graphStart', () => {
      unsubscribePendingAbort?.();
      unsubscribePendingAbort = undefined;
      void processor.abort(successful, error);
    });
  };
  const abortFromSignal = () => {
    const abortReason = getGraphAbortReasonFromSignal(options.signal);
    abortProcessor(abortReason?.successful ?? false, abortReason?.error);
  };
  const abortFromParent = () => {
    const abortReason = getGraphAbortReasonFromSignal(options.parentAbortSignal);
    abortProcessor(abortReason?.successful ?? false, abortReason?.error);
  };
  const pauseProcessor = () => {
    void processor.pause();
  };
  const resumeProcessor = () => {
    void processor.resume();
  };

  options.signal?.addEventListener('abort', abortFromSignal, { once: true });
  options.parentAbortSignal.addEventListener('abort', abortFromParent, { once: true });

  const unsubscribers: Array<() => void> = [
    () => options.signal?.removeEventListener('abort', abortFromSignal),
    () => options.parentAbortSignal.removeEventListener('abort', abortFromParent),
    () => unsubscribePendingAbort?.(),
    options.onParentPause(pauseProcessor),
    options.onParentResume(resumeProcessor),
  ];

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };

  if (options.autoCleanup !== false) {
    unsubscribers.push(subscribeOwnGraphRunLifecycle(processor, cleanup));
  }
  if (options.signal?.aborted) {
    abortFromSignal();
  } else if (options.parentAbortSignal.aborted) {
    abortFromParent();
  }
  return cleanup;
}
