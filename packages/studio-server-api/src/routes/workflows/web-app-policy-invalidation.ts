/**
 * Process-local acceleration for WebSocket access-policy rechecks.
 *
 * Commands always read the current policy, and the five-second recheck remains
 * the fallback for missed notifications. These notifications merely make a
 * successful publication mutation or managed LISTEN event visible to the
 * affected local sockets without waiting for the next timer tick.
 */
const listenersByKey = new Map<string, Set<() => void>>();

export function subscribeWebAppSocketPolicyInvalidation(key: string, listener: () => void): () => void {
  const listeners = listenersByKey.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByKey.delete(key);
  };
}

export function notifyWebAppSocketPolicyInvalidation(key: string): void {
  for (const listener of listenersByKey.get(key) ?? []) {
    try {
      listener();
    } catch {
      // Notification is only an acceleration path. A faulty listener must not
      // turn a successfully committed publication mutation into a failure.
    }
  }
}

export function notifyAllWebAppSocketPolicyInvalidations(): void {
  for (const listeners of listenersByKey.values()) {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // See notifyWebAppSocketPolicyInvalidation above.
      }
    }
  }
}
