import type { RuntimeLibrariesBackend } from './backend.js';

/** One installation owns its backend; observation never acquires job ownership. */
export class RuntimeLibraryServices {
  private backend?: RuntimeLibrariesBackend;
  private draining = false;
  private closing?: Promise<void>;
  constructor(private readonly createBackend: () => RuntimeLibrariesBackend) {}

  get(): RuntimeLibrariesBackend {
    if (this.backend) return this.backend;
    if (this.draining) throw new Error('Runtime-library services are draining.');
    return (this.backend = this.createBackend());
  }

  beginDrain(): void {
    this.draining = true;
    this.backend?.beginDrain?.();
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.beginDrain();
    const backend = this.backend;
    this.closing = Promise.resolve()
      .then(() => backend?.dispose?.())
      .then(() => {
        this.backend = undefined;
      })
      .catch((error) => {
        this.closing = undefined;
        throw error;
      });
    return this.closing;
  }
}
