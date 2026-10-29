import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Test-only observation of the structural fixture's SQL ownership. */
export function createStructuralSqlLeaseGuard(withTransaction) {
  const ownership = new AsyncLocalStorage();
  return {
    withTransaction: (run) =>
      withTransaction((client, hooks) => {
        const lease = { held: true };
        assert.equal(typeof hooks?.onSettled, 'function', 'SQL lease observation requires after-release settlement');
        hooks.onSettled(() => {
          lease.held = false;
        });
        // Child continuations inherit this exact lease; independent requests do
        // not. A nested lease must not hide a still-held parent lease.
        return ownership.run([...(ownership.getStore() ?? []), lease], () => run(client, hooks));
      }),
    assertOutsideTransaction() {
      assert.equal(
        ownership.getStore()?.some((lease) => lease.held) ?? false,
        false,
        'Artifact preparation must not hold SQL leases.',
      );
    },
  };
}
