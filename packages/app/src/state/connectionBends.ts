import { atom } from 'jotai';
import { getProjectConnectionComparisonKey } from '@valerypopoff/rivet2-core';
import { connectionsState, graphMetadataState } from './atoms/graph.js';
import { loadedProjectState, projectState } from './savedGraphs.js';

export const connectionBendSelectionScopeState = atom((get) =>
  JSON.stringify([get(loadedProjectState).path, get(projectState).metadata.id, get(graphMetadataState)?.id]),
);
const selectionState = atom<{ scope?: string; keys: string[] }>({ keys: [] });

/** Session-only selection of authored bends; never include synthetic Data Bus wires. */
export const selectedConnectionBendsState = atom(
  (get) => {
    const selection = get(selectionState);
    if (selection.scope !== get(connectionBendSelectionScopeState)) return [];
    const liveKeys = new Set(
      get(connectionsState)
        .filter((connection) => connection.bendPoint)
        .map(getProjectConnectionComparisonKey),
    );
    return selection.keys.filter((key) => liveKeys.has(key));
  },
  (get, set, keys: string[]) =>
    set(selectionState, {
      scope: get(connectionBendSelectionScopeState),
      keys: [...new Set(keys)],
    }),
);
