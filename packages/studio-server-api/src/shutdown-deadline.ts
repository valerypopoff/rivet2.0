import type { Server } from 'node:http';
import type { AcceptedWork } from '../../studio-server-shared/process-retirement.js';

/** A deadline race must release its timer when the operation settles first.
 * Otherwise an already drained Node process remains alive until the deadline. */
export async function settleBeforeDeadline(operation: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Stop accepting connections within the existing grace period. Node's close()
 * also closes idle sockets, including ended responses still waiting to flush. */
export async function closeHttpServerBeforeDeadline(
  server: Server,
  requestWork: AcceptedWork,
  deadline: number,
): Promise<boolean> {
  if (!server.listening) return true;
  // Response finish owns one admission reference even after its handler has
  // returned. Fence new work and flush those responses before Node's idle close.
  // Once grace expires, still close the listener; the caller may force sockets.
  await settleBeforeDeadline(requestWork.drain(), deadline);
  let closed = false;
  const closing = new Promise<void>((resolve) => {
    server.close(() => {
      closed = true;
      resolve();
    });
  });
  await settleBeforeDeadline(closing, deadline);
  return closed;
}
