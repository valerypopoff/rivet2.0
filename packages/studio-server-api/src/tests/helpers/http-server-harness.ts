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

  await new Promise<void>((resolve) => {
    server.listen(0, host, () => resolve());
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
