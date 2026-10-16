import type { Request, RequestHandler } from 'express';
import { AcceptedWork } from '../../studio-server-shared/process-retirement.js';
import { createHttpError } from './utils/httpError.js';

const requests = new WeakMap<Request, { references: number; release(): void }>();

/** Installed before parsers. Async handlers retain the same admission through response close. */
export function createRequestWorkBarrier(work: AcceptedWork): RequestHandler {
  return (req, res, next) => {
    const release = work.acquire();
    if (!release) {
      res.setHeader('Connection', 'close');
      res.status(503).json({ error: 'This server is retiring.', code: 'server_retiring' });
      return;
    }
    const entry = { references: 1, release };
    requests.set(req, entry);
    let responseReleased = false;
    const finish = () => {
      if (responseReleased) return;
      responseReleased = true;
      if (--entry.references === 0) entry.release();
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
}

export function retainRequestWork(req: Request): () => void {
  const entry = requests.get(req);
  if (!entry) return () => {}; // Other hosts/tests need not install retirement admission.
  if (!entry.references) throw createHttpError(503, 'Request admission has already ended.');
  entry.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.references === 0) entry.release();
  };
}
