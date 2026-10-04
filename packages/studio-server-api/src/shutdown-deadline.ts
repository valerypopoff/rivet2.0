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
