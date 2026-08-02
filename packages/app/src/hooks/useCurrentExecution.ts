import { useExecutionDataFlow } from './useExecutionDataFlow';
import { type GraphExecutionEventsOptions, useGraphExecutionEvents } from './useGraphExecutionEvents';
import { useNodeExecutionEvents } from './useNodeExecutionEvents';
import { useRunActivityExecutionEvents } from './useRunActivityExecutionEvents.js';

export function useCurrentExecution(options: GraphExecutionEventsOptions = {}) {
  const dataFlow = useExecutionDataFlow();
  const nodeEvents = useNodeExecutionEvents(dataFlow);
  const graphEvents = useGraphExecutionEvents(dataFlow, options);
  const runActivityEvents = useRunActivityExecutionEvents();

  return {
    ...dataFlow,
    ...nodeEvents,
    ...graphEvents,
    ...runActivityEvents,
  };
}
