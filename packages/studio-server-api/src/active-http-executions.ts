/**
 * Tracks graph processors started by HTTP requests so shutdown can distinguish
 * a disconnected client from execution that is still consuming host resources.
 *
 * The registry does not schedule or limit work. Published admission remains
 * responsible for capacity; this exists only to give accepted HTTP work its
 * shutdown grace period and then abort it before shared resources are disposed.
 */

export type ActiveHttpExecution = {
  readonly signal: AbortSignal;
  release(): void;
};

export type ActiveHttpExecutionRegistry = {
  abortActive(reason?: Error): number;
  beginDrain(): void;
  getActiveCount(): number;
  register(): ActiveHttpExecution;
};

export function createActiveHttpExecutionRegistry(): ActiveHttpExecutionRegistry {
  const active = new Set<AbortController>();
  let draining = false;

  return {
    abortActive(reason = new Error('HTTP workflow execution exceeded the shutdown grace period.')) {
      let aborted = 0;
      for (const controller of active) {
        if (controller.signal.aborted) continue;
        controller.abort(reason);
        aborted += 1;
      }
      return aborted;
    },
    beginDrain() {
      draining = true;
    },
    getActiveCount() {
      return active.size;
    },
    register() {
      const controller = new AbortController();
      active.add(controller);
      if (draining) {
        controller.abort(new Error('HTTP workflow execution started while the server was draining.'));
      }

      let released = false;
      return {
        signal: controller.signal,
        release() {
          if (released) return;
          released = true;
          active.delete(controller);
        },
      };
    },
  };
}

const defaultRegistry = createActiveHttpExecutionRegistry();

export function abortActiveHttpExecutions(reason?: Error): number {
  return defaultRegistry.abortActive(reason);
}

export function beginActiveHttpExecutionDrain(): void {
  defaultRegistry.beginDrain();
}

export function getActiveHttpExecutionCount(): number {
  return defaultRegistry.getActiveCount();
}

export function registerActiveHttpExecution(): ActiveHttpExecution {
  return defaultRegistry.register();
}