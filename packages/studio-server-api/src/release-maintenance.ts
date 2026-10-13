import type { RequestHandler } from 'express';

export function isReleaseMaintenanceActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RIVET_RELEASE_MAINTENANCE;
  if (value == null || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('RIVET_RELEASE_MAINTENANCE must be true or false.');
}

/** Validation pods expose probes, not application traffic or writes. */
export const releaseMaintenanceBarrier: RequestHandler = (req, res, next) => {
  if (!isReleaseMaintenanceActive()) return next();
  // The co-located executor must obtain its protected bootstrap configuration
  // to become ready. Its route still enforces loopback plus both host tokens;
  // client authorization and every execution route remain closed.
  if (req.method === 'GET' && req.path === '/internal/executor-runtime-config') return next();
  res.setHeader('Retry-After', '60');
  res.status(503).json({ code: 'release_maintenance', error: 'Rivet Server is paused for release validation.' });
};
