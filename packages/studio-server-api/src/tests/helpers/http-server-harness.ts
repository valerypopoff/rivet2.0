import http from 'node:http';

export async function listenTestServer(
  server: http.Server,
  options: { host?: string; protocol?: 'http' | 'https' } = {},
): Promise<{
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}> {
  const host = options.host ?? '127.0.0.1';
  const protocol = options.protocol ?? 'http';

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }

  return {
    host,
    port: address.port,
    baseUrl: `${protocol}://${host}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}

/** Hold every reservation until the complete set exists, then hand it to child processes. */
export async function allocateDistinctTestPorts(count: number): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Test port count must be a positive integer.');
  const reservations: Awaited<ReturnType<typeof listenTestServer>>[] = [];
  try {
    for (let index = 0; index < count; index++) reservations.push(await listenTestServer(http.createServer()));
    return reservations.map((reservation) => reservation.port);
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.close()));
  }
}
