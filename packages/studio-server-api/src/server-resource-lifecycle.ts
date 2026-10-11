export type ServerResourcePhase = 'new' | 'initializing' | 'ready' | 'draining' | 'disposing' | 'disposed';

export class ServerStartupCancelledError extends Error {}

export interface ServerResource {
  name: string;
  /** Admission is fenced synchronously, before waiting for accepted work. */
  beginDrain?(): void;
  /** Declared in dependency order: callers are disposed before their stores. */
  dispose(interrupt: boolean): void | Promise<void>;
}

/** Composition owns ordering; each resource retains its own transaction/drain rules. */
export class ServerResourceLifecycle {
  private state: ServerResourcePhase = 'new';
  private initialization?: Promise<void>;
  private disposal = Promise.resolve();
  private readonly remaining: Set<ServerResource>;
  private readonly fenced = new Set<ServerResource>();

  constructor(resources: readonly ServerResource[]) {
    if (new Set(resources.map((resource) => resource.name)).size !== resources.length)
      throw new Error('Server resource names must be unique.');
    this.remaining = new Set(resources);
  }

  get phase(): ServerResourcePhase {
    return this.state;
  }
  get pendingResourceNames(): string[] {
    return [...this.remaining].map((resource) => resource.name);
  }

  initialize(start: () => Promise<void>): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.state !== 'new') return Promise.reject(new ServerStartupCancelledError());
    this.state = 'initializing';
    this.initialization = Promise.resolve()
      .then(() => {
        this.assertStartupActive();
        return start();
      })
      .then(() => {
        this.assertStartupActive();
        this.state = 'ready';
      });
    return this.initialization;
  }

  assertStartupActive(): void {
    if (this.state !== 'initializing') throw new ServerStartupCancelledError();
  }

  beginDrain(): void {
    if (this.state === 'disposing' || this.state === 'disposed') return;
    this.state = 'draining';
    const errors: unknown[] = [];
    for (const resource of this.remaining) {
      if (this.fenced.has(resource)) continue;
      try {
        resource.beginDrain?.();
        this.fenced.add(resource);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Server admission fencing failed.');
  }

  dispose(interrupt: boolean): Promise<void> {
    // A failed pass must not poison later cleanup attempts or detach its resource.
    const next = this.disposal
      .catch(() => undefined)
      .then(async () => {
        if (this.state === 'disposed') return;
        this.beginDrain();
        await this.initialization?.catch(() => undefined);
        this.state = 'disposing';
        for (const resource of this.remaining) {
          try {
            await resource.dispose(interrupt);
            this.remaining.delete(resource);
          } catch (error) {
            // Stop at the dependency boundary: its downstream stores may still be
            // required by an accepted producer whose termination is unconfirmed.
            this.state = 'draining';
            throw new Error(`Failed to dispose server resource ${resource.name}.`, { cause: error });
          }
        }
        this.state = 'disposed';
      });
    this.disposal = next;
    return next;
  }
}
