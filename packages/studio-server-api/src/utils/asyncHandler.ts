import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { retainParsedRequestBody } from '../middleware/body-admission.js';

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    // A response may close while durable work (for example a project save) is
    // still using req.body. Keep the admission reservation until this handler
    // settles; release is idempotent for explicitly managed handlers.
    const releaseBody = retainParsedRequestBody(req);
    let promise: Promise<void>;
    try {
      // Invoke immediately: middleware may attach its durable work before a
      // caller observes a close event. The explicit catch retains Express's
      // normal error behavior for an accidental synchronous throw.
      promise = fn(req, res, next);
    } catch (error) {
      releaseBody();
      next(error);
      return;
    }
    void promise.then(releaseBody, (error) => {
      releaseBody();
      next(error);
    });
  };
}
