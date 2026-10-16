import { timingSafeEqual } from 'node:crypto';
import express, { type Router } from 'express';
import type { ProcessRetirement } from '../../studio-server-shared/process-retirement.js';

/** Never trust forwarded headers or a Rivet UI key for a process-local retirement capability. */
export function createProcessRetirementRouter(retirement: ProcessRetirement, token: string): Router {
  if (token.length < 32) throw new Error('Retirement capability token is too short.');
  const router = express.Router();
  router.use((req, res, next) => {
    const supplied = Buffer.from(String(req.headers['x-rivet-retirement-token'] ?? ''));
    const expected = Buffer.from(token);
    if (
      req.headers.origin !== undefined ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.status(403).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (_req, res) => {
    res.json(retirement.snapshot());
  });
  router.post('/', express.json({ limit: '1kb', strict: true }), (req, res) => {
    try {
      if (req.body?.protocol !== 1) throw new Error('Unsupported retirement protocol.');
      if (req.body.action !== undefined && !['withdraw', 'begin'].includes(req.body.action))
        throw new Error('Unknown retirement action.');
      res
        .status(202)
        .json(
          req.body.action === 'withdraw'
            ? retirement.withdraw(req.body.operationId, req.body.incarnation)
            : retirement.begin(req.body.operationId, req.body.incarnation),
        );
    } catch {
      res.status(409).json({ error: 'Retirement identity or protocol rejected.' });
    }
  });
  return router;
}
