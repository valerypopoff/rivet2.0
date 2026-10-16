import { createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isTrustedProxyRequest } from './auth.js';
import { isServerUiAuthRequestAllowed } from './server-ui-auth.js';

export type OwnerRoutingConfig = {
  pod: string;
  incarnation: string;
  headless: string;
  backendName: string;
  apiPort: number;
  executorPort: number;
  installation: string;
  key: string;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PREFIX = '/ws/executor/owner/';

export function readOwnerRoutingConfig(): OwnerRoutingConfig | undefined {
  if (process.env.RIVET_HA_PROTOCOL !== '1') return undefined;
  const config = {
    pod: process.env.RIVET_POD_NAME ?? '',
    incarnation: process.env.RIVET_PROCESS_INCARNATION ?? '',
    headless: process.env.RIVET_HA_HEADLESS_SERVICE ?? '',
    backendName: process.env.RIVET_HA_BACKEND_NAME ?? '',
    apiPort: Number(process.env.RIVET_BACKEND_API_PORT),
    executorPort: Number(process.env.RIVET_BACKEND_EXECUTOR_PORT),
    installation: process.env.RIVET_LEGACY_RESTORE_INSTALLATION ?? '',
    key: process.env.RIVET_KEY ?? '',
  };
  if (
    !/^[a-z0-9-]+$/.test(config.backendName) ||
    !/^[a-z0-9.-]+$/.test(config.headless) ||
    !config.installation ||
    !config.key ||
    !UUID.test(config.incarnation) ||
    !config.pod.startsWith(`${config.backendName}-`) ||
    !/^\d+$/.test(config.pod.slice(config.backendName.length + 1)) ||
    ![config.apiPort, config.executorPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536)
  )
    throw new Error('Incomplete HA owner routing identity');
  return config;
}
function signature(config: OwnerRoutingConfig, pod: string, incarnation: string): string {
  return createHmac('sha256', config.key)
    .update(JSON.stringify(['rivet-owner-v1', config.installation, pod, incarnation]))
    .digest('hex');
}
export function executorOwnerPath(config: OwnerRoutingConfig): string {
  return `${PREFIX}${config.pod}/${config.incarnation}/${signature(config, config.pod, config.incarnation)}`;
}
export function parseExecutorOwnerPath(
  config: OwnerRoutingConfig,
  pathname: string,
): { pod: string; incarnation: string } {
  const [pod, incarnation, supplied, extra] = pathname.slice(PREFIX.length).split('/');
  if (
    !pathname.startsWith(PREFIX) ||
    extra != null ||
    !pod?.startsWith(`${config.backendName}-`) ||
    !/^\d{1,4}$/.test(pod.slice(config.backendName.length + 1)) ||
    !UUID.test(incarnation ?? '') ||
    !/^[a-f0-9]{64}$/.test(supplied ?? '')
  )
    throw new Error('Invalid executor owner route');
  if (!timingSafeEqual(Buffer.from(supplied!), Buffer.from(signature(config, pod, incarnation!))))
    throw new Error('Invalid executor owner capability');
  return { pod, incarnation: incarnation! };
}

/** A pod-local relay preserves a signed owner route after normal readiness withdrawal. No run retry. */
export function installExecutorOwnerRouting(server: Server, config: OwnerRoutingConfig): () => void {
  const sockets = new Set<Duplex>();
  const pending = new Set<ReturnType<typeof httpRequest>>();
  let disposed = false;
  const handle = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith(PREFIX)) return;
    let owner: ReturnType<typeof parseExecutorOwnerPath>;
    try {
      if (!isTrustedProxyRequest(request) || !isServerUiAuthRequestAllowed(request)) throw new Error('Unauthorized');
      owner = parseExecutorOwnerPath(config, pathname);
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const local = owner.pod === config.pod;
    if (local && owner.incarnation !== config.incarnation) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = httpRequest({
      hostname: local ? '127.0.0.1' : `${owner.pod}.${config.headless}`,
      port: local ? config.executorPort : config.apiPort,
      path: local ? '/internal' : pathname,
      method: 'GET',
      headers: request.headers,
    });
    pending.add(upstream);
    sockets.add(socket);
    const abortHandshake = () => upstream.destroy();
    socket.on('error', abortHandshake);
    socket.once('close', () => sockets.delete(socket));
    upstream.once('close', () => pending.delete(upstream));
    let accepted = false;
    const deadline = setTimeout(() => upstream.destroy(new Error('Executor owner unavailable')), 5000);
    deadline.unref();
    socket.once('close', () => {
      clearTimeout(deadline);
      if (!accepted) upstream.destroy();
    });
    upstream.once('error', () => {
      clearTimeout(deadline);
      if (accepted) socket.destroy();
      else if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    });
    upstream.once('response', (response) => {
      clearTimeout(deadline);
      response.resume();
      socket.end(`HTTP/1.1 ${response.statusCode ?? 503} Owner unavailable\r\nConnection: close\r\n\r\n`);
    });
    upstream.once('upgrade', (response, remote, remoteHead) => {
      pending.delete(upstream);
      if (disposed || socket.destroyed) { remote.destroy(); return; }
      accepted = true;
      clearTimeout(deadline);
      socket.off('error', abortHandshake);
      sockets.add(remote);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n')}\r\n\r\n`,
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.on('error', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.once('close', () => {
        remote.destroy();
      });
      remote.once('close', () => {
        sockets.delete(remote);
        socket.destroy();
      });
      socket.pipe(remote);
      remote.pipe(socket);
    });
    upstream.end();
  };
  server.on('upgrade', handle);
  return () => {
    disposed = true;
    server.off('upgrade', handle);
    for (const upstream of pending) upstream.destroy();
    pending.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
