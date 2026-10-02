type ActivationStatus = { pending: boolean; error?: string };
type ActivationQueue = {
  revision: number;
  tail: Promise<unknown>;
  controller?: AbortController;
  status: ActivationStatus;
  listeners: Set<() => void>;
};
const queues = new WeakMap<object, ActivationQueue>();

function getQueue(owner: object): ActivationQueue {
  let queue = queues.get(owner);
  if (!queue) {
    queue = { revision: 0, tail: Promise.resolve(), status: { pending: false }, listeners: new Set() };
    queues.set(owner, queue);
  }
  return queue;
}

function publish(queue: ActivationQueue, status: ActivationStatus): void {
  queue.status = status;
  for (const listener of queue.listeners) listener();
}
export const getProjectActivationStatus = (owner: object): ActivationStatus => getQueue(owner).status;
export function subscribeProjectActivation(owner: object, listener: () => void): () => void {
  const queue = getQueue(owner);
  queue.listeners.add(listener);
  return () => queue.listeners.delete(listener);
}

/** Loading placeholders are selections too, even before their IO completes. */
export function supersedeProjectActivation(owner: object): void {
  const queue = getQueue(owner);
  queue.revision++;
  queue.controller?.abort();
  queue.controller = new AbortController();
  publish(queue, { pending: false });
}

export function getProjectActivationSignal(owner: object): AbortSignal {
  const queue = getQueue(owner);
  queue.controller ??= new AbortController();
  return queue.controller.signal;
}

/** Lets a close fallback distinguish failed IO from a newer user selection. */
export function getProjectActivationRevision(owner: object): number {
  return queues.get(owner)?.revision ?? 0;
}

export async function waitForPendingProjectActivations(owner: object): Promise<void> {
  let tail: Promise<unknown> | undefined;
  do {
    tail = queues.get(owner)?.tail;
    await tail;
  } while (tail !== queues.get(owner)?.tail);
}

/** Preparation does not hold a queue lock. Commits must guard isCurrent and
 * contain no asynchronous IO. Even non-abortable providers cannot block a new
 * selection, and their late completion cannot commit. */
export function runLatestProjectActivation(
  owner: object,
  activate: (isCurrent: () => boolean, signal: AbortSignal) => Promise<boolean>,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const queue = getQueue(owner);
  queue.controller?.abort();
  const controller = new AbortController();
  queue.controller = controller;
  const revision = ++queue.revision;
  publish(queue, { pending: true });
  const isCurrent = () => queue.revision === revision && !controller.signal.aborted;
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => {
      if (
        queue.revision === revision &&
        controller.signal.reason instanceof Error &&
        controller.signal.reason.name !== 'AbortError'
      ) {
        publish(queue, { pending: false, error: controller.signal.reason.message });
      }
      resolve(false);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => controller.abort(new Error('Project loading timed out. Please retry.')),
      options.timeoutMs ?? 60_000,
    );
  });
  const preparation = Promise.resolve().then(async () => {
    if (!isCurrent()) return false;
    return (await activate(isCurrent, controller.signal)) && isCurrent();
  });
  const result = Promise.race([preparation, cancelled]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (queue.revision === revision && queue.status.pending) publish(queue, { pending: false });
  });
  // A failed restore must not poison later selections.
  queue.tail = result.catch(() => undefined);
  return result;
}
