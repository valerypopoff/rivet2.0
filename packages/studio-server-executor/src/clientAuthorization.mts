import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Bounded admission for both debugger upgrades and periodic reauthorization. */
export function createHostedClientAuthorizer(options: {
  url: URL;
  getProxyToken(): string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}) {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Authorization timeout must be positive');
  const pending: Array<() => void> = [];
  let active = 0;

  function release() {
    active--;
    pending.shift()?.();
  }

  return async (request: IncomingMessage): Promise<boolean> => {
    const expected = options.getProxyToken();
    const provided = request.headers['x-rivet-proxy-auth'];
    if (!expected || typeof provided !== 'string') return false;
    const token = Buffer.from(provided);
    const expectedToken = Buffer.from(expected);
    if (token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) return false;
    if (request.socket.destroyed || (active >= 16 && pending.length >= 64)) return false;

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    request.socket.once('close', abort);
    let admitted = false;
    try {
      if (active >= 16) {
        const ready = await new Promise<boolean>((resolve) => {
          const cancel = () => {
            const index = pending.indexOf(start);
            if (index >= 0) pending.splice(index, 1);
            resolve(false);
          };
          const start = () => {
            controller.signal.removeEventListener('abort', cancel);
            active++;
            resolve(true);
          };
          pending.push(start);
          controller.signal.addEventListener('abort', cancel, { once: true });
        });
        if (!ready) return false;
      } else {
        active++;
      }
      admitted = true;
      if (controller.signal.aborted) return false;
      const headers: Record<string, string> = { 'x-rivet-proxy-auth': expected };
      for (const name of ['cookie', 'x-rivet-client-ip', 'host', 'x-forwarded-host', 'x-forwarded-proto']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const response = await fetchRequest(options.url, {
        headers, cache: 'no-store', redirect: 'manual', signal: controller.signal,
      });
      await response.body?.cancel();
      return !controller.signal.aborted && response.status === 204;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      request.socket.off('close', abort);
      if (admitted) release();
    }
  };
}
