import {
  configureAppExecutorHost,
  hasAppExecutorModuleLoaded,
  type AppExecutorHostOptions,
} from './executorHostState.mjs';

export type { AppExecutorHostOptions, AppExecutorProcessorOptionsContext } from './executorHostState.mjs';

let startPromise: Promise<unknown> | undefined;

/**
 * Host entrypoint for wrappers that need to inject request-scoped processor
 * options into editor runs. The ordinary executor entrypoint remains
 * configuration-free and starts with the same defaults as before.
 */
export function startAppExecutor(options: AppExecutorHostOptions = {}): Promise<unknown> {
  if (startPromise) {
    return startPromise;
  }
  if (hasAppExecutorModuleLoaded()) {
    return Promise.reject(new Error('The app executor already started through its standalone entrypoint.'));
  }

  configureAppExecutorHost(options);
  startPromise = import('./executor.mjs');
  return startPromise;
}
