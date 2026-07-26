type GraphBuilderStartupTaskResult<T> = { status: 'completed'; value: T } | { status: 'aborted' };

/**
 * Lets a host-owned startup stop waiting without assuming the injected task
 * honors cancellation. Rejection handlers remain attached after an abort so a
 * late failure from the abandoned task cannot become unhandled.
 */
export function waitForGraphBuilderStartupTask<T>(
  task: PromiseLike<T>,
  abortSignal: AbortSignal,
): Promise<GraphBuilderStartupTaskResult<T>> {
  const observedTask = Promise.resolve(task);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      settle(() => resolve({ status: 'aborted' }));
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    observedTask.then(
      (value) => settle(() => resolve({ status: 'completed', value })),
      (error: unknown) => settle(() => reject(error)),
    );
    if (abortSignal.aborted) {
      onAbort();
    }
  });
}
