import { atom } from 'jotai';
import { createExecutionObservationCoordinator } from '../domain/execution/executionObservationCoordinator.js';
import { createLocalExecutionObservationRouter } from '../domain/execution/localExecutionObservation.js';

export const executionObservationCoordinatorState = atom(() => createExecutionObservationCoordinator());
export const localExecutionObservationState = atom((get) => ({
  router: createLocalExecutionObservationRouter(get(executionObservationCoordinatorState)),
  users: 0,
}));
