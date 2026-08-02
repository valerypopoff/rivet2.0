import type { ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { applyProcessEventToRunActivityJournal } from '../features/runActivity/runActivityProcessEvents.js';
import { runActivityJournalState } from '../state/dataFlow.js';
import { useStableCallback } from './useStableCallback.js';

export type RunActivityExecutionEventsApi = {
  onRunActivityEvent: <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) => void;
};

export function useRunActivityExecutionEvents(): RunActivityExecutionEventsApi {
  const setJournal = useSetAtom(runActivityJournalState);

  const onRunActivityEvent = useStableCallback(
    <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) => {
      const occurredAt = Date.now();
      setJournal((journal) =>
        applyProcessEventToRunActivityJournal({
          data,
          journal,
          message,
          occurredAt,
        }),
      );
    },
  );

  return { onRunActivityEvent };
}
