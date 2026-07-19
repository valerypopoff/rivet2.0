export class ManagedAsyncBranches {
  readonly #pending = new Set<Promise<void>>();
  readonly #tailByKey = new Map<string, Promise<void>>();

  enqueue(key: string, run: () => Promise<void>, onError: (error: unknown) => void): void {
    const previous = this.#tailByKey.get(key) ?? Promise.resolve();
    const tracked = previous
      .then(run)
      .catch((error) => {
        onError(error);
      })
      .finally(() => {
        this.#pending.delete(tracked);
        if (this.#tailByKey.get(key) === tracked) {
          this.#tailByKey.delete(key);
        }
      });

    this.#tailByKey.set(key, tracked);
    this.#pending.add(tracked);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }
}
