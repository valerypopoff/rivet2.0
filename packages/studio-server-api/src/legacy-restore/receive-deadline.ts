import type { IncomingMessage, ServerResponse } from 'node:http';

export const RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS = 60 * 60 * 1000;

/** Extending Node's server-wide deadline for archive streaming must not extend ordinary request bodies. */
export function retainOrdinaryReceiveDeadline(req: IncomingMessage, res: ServerResponse, timeoutMs = 120000): void {
  if (req.complete || (req.method === 'POST' && req.url?.split('?')[0] === '/api/legacy-restore/upload')) return;
  const cleanup = () => {
    clearTimeout(timer);
    req.off('end', cleanup);
    req.off('close', cleanup);
  };
  const timer = setTimeout(() => {
    cleanup();
    if (!res.headersSent) res.writeHead(408, { Connection: 'close' }).end(() => req.destroy());
    else req.destroy();
  }, timeoutMs);
  timer.unref();
  req.once('end', cleanup);
  req.once('close', cleanup);
}
