import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Pod-local client. A timeout leaves the owner alive and blocks the rollout. */
export async function requestBackendRetirement(socketPath, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/retirement',
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        timeout: 5000,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          if ((bytes += chunk.length) > 4096) {
            response.destroy(new Error('Retirement acknowledgement too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            if (![200, 202].includes(response.statusCode)) throw new Error('Retirement command was rejected.');
            const status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              status.protocol !== 1 ||
              typeof status.incarnation !== 'string' ||
              !['serving', 'checking', 'withdrawing', 'draining', 'drained', 'failed'].includes(status.state)
            )
              throw new Error('Retirement acknowledgement is incompatible.');
            resolve(status);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('Retirement acknowledgement timed out.')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function retireBackend({
  socketPath,
  operationId,
  incarnation,
  timeoutMs = 300000,
  requestStatus = requestBackendRetirement,
  now = Date.now,
  wait = () => new Promise((resolve) => setTimeout(resolve, 500)),
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid retirement wait deadline.');
  const deadline = now() + timeoutMs;
  const before = await requestStatus(socketPath);
  if (before.incarnation !== incarnation) throw new Error('Backend process changed; replacement is blocked.');
  await requestStatus(socketPath, 'POST', { protocol: 1, incarnation, operationId });
  while (true) {
    const status = await requestStatus(socketPath);
    if (status.incarnation !== incarnation || status.operationId !== operationId)
      throw new Error('Retirement acknowledgement belongs to a different owner.');
    if (status.state === 'drained') return status;
    if (!['checking', 'draining'].includes(status.state)) throw new Error('Retirement failed; replacement is blocked.');
    if (now() >= deadline)
      throw new Error('Accepted work has not drained. Backend was not terminated; replacement is blocked.');
    await wait();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [operationId, incarnation, seconds = '300'] = process.argv.slice(2);
    const socketPath = process.env.RIVET_ROLLING_RETIREMENT_SOCKET || '/tmp/rivet-retirement.sock';
    const status =
      operationId && ['--housekeeping-acquire', '--housekeeping-release'].includes(seconds)
        ? await requestBackendRetirement(socketPath, 'POST', { protocol: 1, action: seconds.slice(2), operationId, incarnation })
        : operationId && seconds === '--withdraw-only'
        ? await requestBackendRetirement(socketPath, 'POST', {
            protocol: 1,
            action: 'withdraw',
            operationId,
            incarnation,
          })
        : operationId && seconds === '--begin-only'
          ? await requestBackendRetirement(socketPath, 'POST', { protocol: 1, operationId, incarnation })
          : operationId
            ? await retireBackend({ socketPath, operationId, incarnation, timeoutMs: Number(seconds) * 1000 })
            : await requestBackendRetirement(socketPath);
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
