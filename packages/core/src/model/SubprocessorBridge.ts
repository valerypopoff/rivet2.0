import type Emittery from 'emittery';
import type { GraphProcessor, ProcessEvents } from './GraphProcessor.js';
import { getGraphAbortReasonFromSignal } from './GraphAbortReasons.js';
import { logRuntimeWarn } from '../utils/runtimeLogging.js';

type GraphLifecycleEvent = ProcessEvents['graphFinish'] | ProcessEvents['graphAbort'] | ProcessEvents['graphError'];

/** Drain before invoking disposers so cleanup is exhaustive and reentrant/idempotent. */
function releaseSubscriptions(...groups: Array<Array<() => void>>): void {
  const errors: unknown[] = [];
  const subscriptions = groups.flatMap((group) => group.splice(0));
  for (const unsubscribe of subscriptions) {
    try {
      unsubscribe();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Failed to release child execution subscriptions');
}

function rollbackSubscriptions(error: unknown, ...groups: Array<Array<() => void>>): never {
  try {
    releaseSubscriptions(...groups);
  } catch {
    // Setup failure remains authoritative; every acquired disposer was attempted.
  }
  throw error;
}

/** Cleanup must not replace an execution/setup failure already being propagated. */
export function cleanupSubprocessorBindings(
  lifecycle: (() => void) | undefined,
  events: (() => void) | undefined,
  executionFailed: boolean,
): void {
  try {
    releaseSubscriptions(lifecycle ? [lifecycle] : [], events ? [events] : []);
  } catch (error) {
    if (!executionFailed) throw error;
    // Disposer errors may contain authored data. Keep secondary failure visible
    // without logging messages or changing the primary Error identity.
    try {
      logRuntimeWarn('Child execution cleanup failed after an execution or setup failure.', {
        failedBindings: error instanceof AggregateError ? error.errors.length : 1,
      });
    } catch {
      // A host-provided logger must not replace the primary failure either.
    }
  }
}

function subscribeOwnGraphRunLifecycle(processor: GraphProcessor, onLifecycleEvent: () => void): () => void {
  let ownGraphRunId: ProcessEvents['graphStart']['execution']['graphRunId'] | undefined;

  const onPossibleLifecycleEvent = (event: GraphLifecycleEvent, executionFailed: boolean) => {
    if (ownGraphRunId != null && event.execution.graphRunId === ownGraphRunId) {
      if (executionFailed) cleanupSubprocessorBindings(onLifecycleEvent, undefined, true);
      else onLifecycleEvent();
    }
  };

  const subscriptions: Array<() => void> = [];
  try {
    subscriptions.push(
      processor.on('graphStart', (event) => {
        ownGraphRunId ??= event.execution.graphRunId;
      }),
    );
    subscriptions.push(processor.on('graphFinish', (event) => onPossibleLifecycleEvent(event, false)));
    subscriptions.push(processor.on('graphAbort', (event) => onPossibleLifecycleEvent(event, !event.successful)));
    subscriptions.push(processor.on('graphError', (event) => onPossibleLifecycleEvent(event, true)));
  } catch (error) {
    rollbackSubscriptions(error, subscriptions);
  }
  return () => releaseSubscriptions(subscriptions);
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
  const passiveUnsubscribers: Array<() => void> = [];
  const controlUnsubscribers: Array<() => void> = [];
  const cleanupControls = () => releaseSubscriptions(controlUnsubscribers);
  try {
    const passiveEvents = [
      'nodeError',
      'nodeFinish',
      'partialOutput',
      'progress',
      'llmCallFinished',
      'llmChatOutputSnapshot',
      'llmProfileAttempt',
      'toolCallFinished',
      'nodeExcluded',
      'nodeStart',
      'graphAbort',
      'graphError',
      'userInput',
      'graphStart',
      'graphFinish',
      'nodeOutputsCleared',
      'streamingOutputWatchSummary',
      'globalSet',
      'newAbortController',
    ] as const;
    for (const event of passiveEvents) {
      passiveUnsubscribers.push(processor.on(event, (data) => forward(event, data)));
    }
    controlUnsubscribers.push(
      processor.on('pause', () => {
        if (!parentState.isPaused()) parentState.pause();
      }),
    );
    controlUnsubscribers.push(
      processor.on('resume', () => {
        if (parentState.isPaused()) parentState.resume();
      }),
    );
    passiveUnsubscribers.push(
      processor.onAny((event, data) => {
        if (event.startsWith('globalSet:')) void forward(event, data);
      }),
    );
    if (parentState.autoCleanup !== false) {
      controlUnsubscribers.push(subscribeOwnGraphRunLifecycle(processor, cleanupControls));
    }
  } catch (error) {
    rollbackSubscriptions(error, controlUnsubscribers, passiveUnsubscribers);
  }
  return () => releaseSubscriptions(controlUnsubscribers, passiveUnsubscribers);
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

  const unsubscribers: Array<() => void> = [];
  const cleanup = () => releaseSubscriptions(unsubscribers);
  try {
    options.signal?.addEventListener('abort', abortFromSignal, { once: true });
    unsubscribers.push(() => options.signal?.removeEventListener('abort', abortFromSignal));
    options.parentAbortSignal.addEventListener('abort', abortFromParent, { once: true });
    unsubscribers.push(() => options.parentAbortSignal.removeEventListener('abort', abortFromParent));
    unsubscribers.push(() => unsubscribePendingAbort?.());
    unsubscribers.push(options.onParentPause(pauseProcessor));
    unsubscribers.push(options.onParentResume(resumeProcessor));
    if (options.autoCleanup !== false) {
      unsubscribers.push(subscribeOwnGraphRunLifecycle(processor, cleanup));
    }
    if (options.signal?.aborted) abortFromSignal();
    else if (options.parentAbortSignal.aborted) abortFromParent();
  } catch (error) {
    rollbackSubscriptions(error, unsubscribers);
  }
  return cleanup;
}
