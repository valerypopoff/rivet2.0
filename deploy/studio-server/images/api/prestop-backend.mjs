import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestBackendRetirement } from './retire-backend.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const drained = (status) =>
  status?.protocol === 1 &&
  status.withdrawalProtocol === 1 &&
  status.routingWithdrawn === true &&
  status.state === 'drained' &&
  uuid.test(status.incarnation ?? '') &&
  uuid.test(status.operationId ?? '');

/** Planned HA retirement already observed routing propagation and finalized all
 * accepted work before Pod deletion. Every other exit keeps the normal delay.
 * This hook only reads status; it never initiates or acknowledges retirement. */
export async function backendPreStop({ delaySeconds, readStatus, wait = sleep }) {
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 2_147_483)
    throw Error('Invalid preStop delay');
  if (delaySeconds > 0)
    try {
      const first = await readStatus();
      if (drained(first)) {
        const second = await readStatus();
        if (drained(second) && second.incarnation === first.incarnation && second.operationId === first.operationId)
          return 'coordinated-drain-complete';
      }
    } catch {
      /* Missing/older/restarting retirement servers retain the delay. */
    }
  await wait(delaySeconds * 1000);
  return 'normal-delay';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  backendPreStop({
    delaySeconds: Number(process.argv[2]),
    readStatus: () =>
      requestBackendRetirement(
        process.env.RIVET_ROLLING_RETIREMENT_SOCKET || '/tmp/rivet-retirement.sock',
        'GET',
        undefined,
        { timeoutMs: 1000 },
      ),
  })
    .then((mode) => console.log(`[prestop] ${mode}`))
    .catch(() => {
      process.exitCode = 1;
    });
}
