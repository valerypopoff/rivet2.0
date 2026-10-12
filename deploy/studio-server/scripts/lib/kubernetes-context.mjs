/** Minikube can update current-context even with --keep-context. Restore only
 * when it selected our target, never over a different concurrently chosen context.
 */
export async function preserveKubernetesContext({ targetContext, readContext, restoreContext }, operation) {
  const previous = await readContext();
  let operationFailed = false;
  let operationFailure;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
    throw error;
  } finally {
    try {
      if (previous && previous !== targetContext && (await readContext()) === targetContext) {
        await restoreContext(previous);
      }
    } catch (error) {
      if (operationFailed)
        throw new AggregateError(
          [operationFailure, error],
          'Kubernetes operation and context restoration both failed.',
        );
      throw error;
    }
  }
}
