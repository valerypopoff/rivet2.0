import { handleError } from '../utils/errorHandling.js';

export function dispatchGraphExecutionEvent(eventName: string, dispatch: () => void): boolean {
  try {
    dispatch();
    return true;
  } catch (error) {
    handleError(error, `Failed to update graph execution state for ${eventName}`);
    return false;
  }
}
