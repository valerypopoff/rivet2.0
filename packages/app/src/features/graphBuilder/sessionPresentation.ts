import type { GraphBuilderImplementationMode } from '../../state/graphBuilderAi.js';
import type { GraphBuilderSessionViewState } from './sessionController.js';

export function selectGraphBuilderSessionState(
  mode: GraphBuilderImplementationMode | undefined,
  states: {
    legacy: GraphBuilderSessionViewState | undefined;
    planB: GraphBuilderSessionViewState | undefined;
  },
): GraphBuilderSessionViewState | undefined {
  if (mode === 'legacy') {
    return states.legacy;
  }
  if (mode === 'plan-b') {
    return states.planB;
  }
  return undefined;
}

export function isGraphBuilderSessionWorking(state: GraphBuilderSessionViewState | undefined): boolean {
  return state?.status === 'gathering-context' || state?.status === 'editing' || state?.status === 'repairing';
}
