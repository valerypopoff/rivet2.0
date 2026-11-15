const pending = new Set<Promise<unknown>>();
const deferred: Array<() => Promise<void>> = [];
let scheduled = false;
export function pendingEvidenceWorkCount(): number {
  return pending.size;
}
function scheduleNext(): void {
  if (scheduled || deferred.length === 0) return;
  scheduled = true;
  setImmediate(() => {
    const next = deferred.shift()!;
    void next().finally(() => {
      scheduled = false;
      scheduleNext();
    });
  });
}
/** One background writer, yielding between jobs so foreground I/O stays responsive. */
export function deferEvidenceWork<T>(work: () => Promise<T>): Promise<T> {
  const task = new Promise<T>((resolve, reject) => {
    deferred.push(async () => {
      try {
        resolve(await work());
      } catch (error) {
        reject(error);
      }
    });
    scheduleNext();
  });
  pending.add(task);
  void task.then(
    () => pending.delete(task),
    () => pending.delete(task),
  );
  return task;
}
export async function flushEvidenceWork(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
