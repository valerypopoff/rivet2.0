import { createServer } from 'node:net';

/** Select one fixture's ports together, then release them for its child processes. */
export async function unusedLoopbackPorts(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('A positive fixture port count is required.');
  const listeners = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      listeners.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return listeners.map((server) => server.address().port);
  } finally {
    await Promise.all(
      listeners.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
}
