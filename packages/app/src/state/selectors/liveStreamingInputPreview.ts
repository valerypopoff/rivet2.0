import type { NodeId } from '@valerypopoff/rivet2-core';
import { atom } from 'jotai';
import { graphState } from '../graph.js';
import { graphRunningState, lastRunDataByNodeState, resolvedGraphSelectionState } from '../dataFlow.js';
import { currentProjectLoadedRecordingState } from '../execution.js';
import { filterProcessDataForSelection, getSelectedGraphRunId } from './executionSelectors.js';
import { getLiveStreamingInputPreview } from '../../components/nodeOutput/liveStreamingInputPreview.js';

/** Mounted by a consumer only; no mutable preview state or snapshot lifecycle. */
export function createLiveStreamingInputPreviewAtom(nodeId: NodeId) {
  return atom((get) => {
    if (!get(graphRunningState) || get(currentProjectLoadedRecordingState)) return undefined;
    const graph = get(graphState);
    const selection = get(resolvedGraphSelectionState);
    const selectedRunId = getSelectedGraphRunId(selection.graphRuns, selection.selectedGraphRun);
    const selectedRun = selection.graphRuns?.find((run) => run.graphRunId === selectedRunId);
    if (selectedRun?.status && selectedRun.status !== 'running') return undefined;
    const runs = get(lastRunDataByNodeState);
    return getLiveStreamingInputPreview(graph, nodeId, (sourceId) =>
      filterProcessDataForSelection({
        ...selection,
        processData: runs[sourceId]?.filter((process) => process.graphId === graph.metadata?.id),
      }),
    );
  });
}
