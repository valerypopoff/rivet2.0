/** Attempt every owned cleanup without concealing the original test failure. */
export async function cleanupVerification(tasks, originalFailure) {
  const failures = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  const cleanupFailure = new AggregateError(failures, 'Isolated verification cleanup failed');
  if (originalFailure) {
    console.warn(cleanupFailure);
    return;
  }
  throw cleanupFailure;
}
