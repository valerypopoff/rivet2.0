export type GraphRunLifecyclePhase = 'idle' | 'running' | 'aborting' | 'finished';

export type GraphRunAbortDecision = {
  successful: boolean;
  error?: Error | string | undefined;
};

/** Owns run-level state only. Scheduling and event emission remain in GraphProcessor. */
export class GraphRunLifecycle {
  #phase: GraphRunLifecyclePhase = 'idle';
  #paused = false;
  #abort: GraphRunAbortDecision | undefined;
  #finishClaimed = false;

  get phase(): GraphRunLifecyclePhase {
    return this.#phase;
  }

  get isRunning(): boolean {
    return this.#phase === 'running' || this.#phase === 'aborting';
  }

  get isPaused(): boolean {
    return this.#paused;
  }

  get isAborted(): boolean {
    return this.#abort != null;
  }

  get abortSuccessful(): boolean {
    return this.#abort?.successful ?? false;
  }

  get abortError(): Error | string | undefined {
    return this.#abort?.error;
  }

  begin(): void {
    if (this.isRunning) {
      throw new Error('Cannot process graph while already processing');
    }

    this.#phase = 'running';
    this.#abort = undefined;
    this.#finishClaimed = false;
  }

  complete(): void {
    if (this.#phase !== 'idle') this.#phase = 'finished';
  }

  requestAbort(successful: boolean, error?: Error | string): GraphRunAbortDecision | undefined {
    if (!this.isRunning || this.#abort) return undefined;

    this.#phase = 'aborting';
    this.#abort = { successful, error };
    return this.#abort;
  }

  pause(): boolean {
    if (this.#paused) return false;
    this.#paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.#paused) return false;
    this.#paused = false;
    return true;
  }

  claimRootFinish(isSubProcessor: boolean): boolean {
    if (isSubProcessor || this.#finishClaimed) return false;
    this.#finishClaimed = true;
    return true;
  }

  getAbortError(): Error {
    if (typeof this.#abort?.error === 'string') return new Error(this.#abort.error);
    return this.#abort?.error ?? new Error('Processing aborted');
  }
}
