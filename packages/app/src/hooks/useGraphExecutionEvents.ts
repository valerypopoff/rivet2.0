import type { ProcessEvents } from '@valerypopoff/rivet2-core';
import { handleError } from '../utils/errorHandling.js';
import type { ExecutionDataFlowApi } from './useExecutionDataFlow.js';
import type { MissingDebuggerTerminalEvent } from './graphExecutionEventHelpers.js';
import { stopProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { useExecutionSnapshotWriter } from './useExecutionSnapshotWriter.js';

export type GraphExecutionEventsApi = {
  onAbort: (data: ProcessEvents['abort']) => void;
  onDone: (data: ProcessEvents['done']) => void;
  onError: (data: ProcessEvents['error']) => void;
  onGraphAbort: (data: ProcessEvents['graphAbort']) => void;
  onGraphError: (data: ProcessEvents['graphError']) => void;
  onGraphFinish: (data: ProcessEvents['graphFinish']) => void;
  onGraphStart: (data: ProcessEvents['graphStart']) => void;
  onPause: () => void;
  onResume: () => void;
  onStart: (data: ProcessEvents['start']) => void;
  onStop: () => void;
};
export type GraphExecutionEventsOptions = {
  onMissingDebuggerTerminalEvent?: (event: MissingDebuggerTerminalEvent) => void;
};

/** Controls/notifications are policy; all event data uses the shared snapshot reducer. */
export function useGraphExecutionEvents(
  {
    clearNodeRunDataPreservationForNextStart,
    consumeNodeRunDataPreservationForNextStart,
    evaluationRunningLatest,
  }: Pick<
    ExecutionDataFlowApi,
    | 'clearNodeRunDataPreservationForNextStart'
    | 'consumeNodeRunDataPreservationForNextStart'
    | 'evaluationRunningLatest'
  >,
  options: GraphExecutionEventsOptions = {},
): GraphExecutionEventsApi {
  const writer = useExecutionSnapshotWriter();
  const clear = clearNodeRunDataPreservationForNextStart;
  return {
    onStart(data) {
      writer.event('start', data, {
        policy: {
          start: {
            preserveNodeIds: consumeNodeRunDataPreservationForNextStart(),
            evaluationRunning: Boolean(evaluationRunningLatest.current),
          },
        },
      });
    },
    onDone(data) {
      clear();
      const notify = options.onMissingDebuggerTerminalEvent;
      const missing: MissingDebuggerTerminalEvent[] = [];
      writer.event('done', data, {
        policy: { missingTerminalEvents: notify ? missing : undefined },
      });
      // Diagnostics are external observers: publish after the terminal snapshot
      // commits, so a callback cannot prevent cleanup or clobber a replacement.
      for (const event of missing) {
        try {
          notify!(event);
        } catch (error) {
          handleError(error, 'Failed to report missing execution terminal event', { toastError: false });
        }
      }
    },
    onAbort(data) {
      clear();
      writer.event('abort', data);
    },
    onError(data) {
      clear();
      writer.event('error', data, { policy: { keepRunningNodesOnError: true } });
      handleError(data.error, 'Graph execution error');
    },
    onGraphStart: (data) => writer.event('graphStart', data),
    onGraphFinish: (data) => writer.event('graphFinish', data),
    onGraphAbort: (data) => writer.event('graphAbort', data),
    onGraphError: (data) => writer.event('graphError', data),
    onPause: () => writer.event('pause', {} as ProcessEvents['pause']),
    onResume: () => writer.event('resume', {} as ProcessEvents['resume']),
    onStop() {
      clear();
      writer.mutate(stopProjectExecutionSnapshot);
    },
  };
}
