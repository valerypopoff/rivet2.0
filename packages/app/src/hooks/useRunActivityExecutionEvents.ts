import type { ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import { useStableCallback } from './useStableCallback.js';
import { useExecutionSnapshotWriter } from './useExecutionSnapshotWriter.js';

export type RunActivityExecutionEventsApi = {
  onRunActivityEvent: <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) => void;
};

export function useRunActivityExecutionEvents(): RunActivityExecutionEventsApi {
  const writer = useExecutionSnapshotWriter();

  const onRunActivityEvent = useStableCallback(
    <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) => {
      writer.event(message, data, { activityOnly: true, activityData: data });
    },
  );

  return { onRunActivityEvent };
}
