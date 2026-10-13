import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export const RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS = 60 * 60 * 1000;
const ORDINARY_RECEIVE_TIMEOUT_MS = 120_000;

/** Classify the original HTTP path before Express mounts rewrite req.url. */
export function configureRequestReceiveDeadlines(
  server: Server,
  restoreEnabled: boolean,
  ordinaryTimeoutMs = ORDINARY_RECEIVE_TIMEOUT_MS,
): void {
  server.requestTimeout = restoreEnabled ? RESTORE_UPLOAD_RECEIVE_TIMEOUT_MS : ordinaryTimeoutMs;
  if (restoreEnabled)
    server.prependListener('request', (req, res) => retainOrdinaryReceiveDeadline(req, res, ordinaryTimeoutMs));
}

/** Extending Node's server-wide deadline for archive streaming must not extend ordinary request bodies. */
export function retainOrdinaryReceiveDeadline(
  req: IncomingMessage,
  res: ServerResponse,
  timeoutMs = ORDINARY_RECEIVE_TIMEOUT_MS,
): void {
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
