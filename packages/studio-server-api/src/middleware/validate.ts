import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type ZodType } from 'zod';

import { badRequest } from '../utils/httpError.js';

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(badRequest(result.error.issues[0]?.message ?? 'Invalid request body'));
      return;
    }

    req.body = result.data;
    next();
  };
}
