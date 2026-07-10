import { produce } from 'immer';
import { useSetAtom } from 'jotai';
import type { UiComponentId, UiGraph, UiGraphComponent, UiGraphId } from '@valerypopoff/rivet2-core';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { projectState } from '../../state/savedGraphs.js';

export function useUiGraphMutations(selectedUiGraphId: UiGraphId | undefined) {
  const setProject = useSetAtom(projectState);

  const updateUiGraph = useStableCallback((updater: (uiGraph: UiGraph) => void) => {
    if (!selectedUiGraphId) {
      return;
    }

    setProject((currentProject) =>
      produce(currentProject, (draft) => {
        const uiGraph = draft.uiGraphs?.[selectedUiGraphId];
        if (uiGraph) {
          updater(uiGraph);
        }
      }),
    );
  });

  const updateComponent = useStableCallback(
    (componentId: UiComponentId, updater: (component: UiGraphComponent) => void) => {
      updateUiGraph((uiGraph) => {
        const component = uiGraph.components.find(({ id }) => id === componentId);
        if (component) {
          updater(component);
        }
      });
    },
  );

  return { updateComponent, updateUiGraph };
}
