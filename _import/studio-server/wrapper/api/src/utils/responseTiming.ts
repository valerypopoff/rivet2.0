import type { RequestHandler } from 'express';

export function createResponseTimingMiddleware(): RequestHandler {
  return (_req, res, next) => {
    const startedAt = performance.now();
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
      if (!res.headersSent && !res.hasHeader('x-duration-ms')) {
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        res.setHeader('x-duration-ms', String(durationMs));
      }

      return originalWriteHead(...args);
    }) as typeof res.writeHead;

    next();
  };
}
