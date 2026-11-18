import { Router, json } from 'express';
import { isTrustedExecutorRequest } from '../auth.js';
import { getResourceMonitoringHub } from './runtime.js';
import { unavailableResourceHistory } from './service.js';
import { RESOURCE_PERIODS } from './history.js';
import type { ResourcePeriod } from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';

export function createResourceReportRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!isTrustedExecutorRequest(req)) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  router.post('/', json({ limit: '128kb', strict: true }), (req, res) => {
    const hub = getResourceMonitoringHub();
    if (!hub) {
      res.sendStatus(503);
      return;
    }
    try {
      hub.ingest(req.body);
      res.sendStatus(202);
    } catch {
      res.status(400).json({ error: 'Invalid resource report' });
    }
  });
  return router;
}

/** Mounted only beneath the existing authenticated control-plane boundary. */
export function createResourceHistoryRouter(): Router {
  const router = Router();
  router.get('/', (req, res, next) => {
    const period = req.query.period ?? '1h';
    if (typeof period !== 'string' || !Object.hasOwn(RESOURCE_PERIODS, period)) {
      res.status(400).json({ error: 'Invalid resource period' });
      return;
    }
    const selected = period as ResourcePeriod;
    const hub = getResourceMonitoringHub();
    const result = hub ? hub.history(selected) : Promise.resolve(unavailableResourceHistory(selected));
    void result.then((data) => res.set('Cache-Control', 'no-store').json(data)).catch(next);
  });
  return router;
}
