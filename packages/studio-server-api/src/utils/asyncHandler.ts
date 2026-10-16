import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { retainParsedRequestBody } from '../middleware/body-admission.js';
import { retainRequestWork } from '../request-work.js';

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    // A response may close while durable work (for example a project save) is
    // still using req.body. Keep the admission reservation until this handler
    // settles; release is idempotent for explicitly managed handlers.
    let releaseWork: () => void;
    try {
      releaseWork = retainRequestWork(req);
    } catch (error) {
      next(error);
      return;
    }
    const releaseBody = retainParsedRequestBody(req);
    const release = () => {
      releaseBody();
      releaseWork();
    };
    let promise: Promise<void>;
    try {
      // Invoke immediately: middleware may attach its durable work before a
      // caller observes a close event. The explicit catch retains Express's
      // normal error behavior for an accidental synchronous throw.
      promise = fn(req, res, next);
    } catch (error) {
      release();
      next(error);
      return;
    }
    void promise.then(release, (error) => {
      release();
      next(error);
    });
  };
}
