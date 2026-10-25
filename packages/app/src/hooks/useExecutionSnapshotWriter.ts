import { useStore, type createStore } from 'jotai';
import type { ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import { useDataRefs, type DataRefStore } from '../providers/ProvidersContext.js';
import { projectState } from '../state/savedGraphs.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { updateCurrentProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';
import {
  applyProcessEventToProjectExecutionSnapshot,
  type ProjectExecutionSnapshotEventOptions,
} from './projectExecutionSnapshotEvents.js';
import type { ProjectExecutionSnapshot } from '../state/dataFlow.js';

/** One effectful snapshot writer for interactive presentation and passive adapters. */
type EventOptions<K extends keyof ProcessEventMessageMap> = Pick<
  ProjectExecutionSnapshotEventOptions<K>,
  'policy' | 'activityOnly' | 'activityData'
>;
export type ExecutionSnapshotWriter = {
  store: ReturnType<typeof createStore>;
  refStore: DataRefStore;
  mutate: (update: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot) => void;
  event: <K extends keyof ProcessEventMessageMap>(
    message: K,
    data: ProcessEventMessageMap[K],
    options?: EventOptions<K>,
  ) => void;
};
export function useExecutionSnapshotWriter(): ExecutionSnapshotWriter {
  const store = useStore();
  const refStore = useDataRefs();
  const mutate = (update: (snapshot: ProjectExecutionSnapshot) => ProjectExecutionSnapshot) =>
    updateCurrentProjectExecutionSnapshot(store, update);
  const event = <K extends keyof ProcessEventMessageMap>(
    message: K,
    data: ProcessEventMessageMap[K],
    options: EventOptions<K> = {},
  ) => {
    mutate(
      (snapshot) =>
        applyProcessEventToProjectExecutionSnapshot({
          snapshot,
          message,
          data,
          refStore,
          projectId: store.get(projectState).metadata.id,
          previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
          activityData: false,
          ...options,
        }).snapshot,
    );
  };
  return { store, refStore, mutate, event };
}
