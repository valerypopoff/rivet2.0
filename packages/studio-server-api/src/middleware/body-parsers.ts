import { type Request, type RequestHandler } from 'express';
import { parseBoundedBody } from './body-reader.js';

import {
  createAdmittedBodyParser,
  createAdmittedJsonBodyParser,
  isJsonRequest,
  isUrlEncodedRequest,
} from './body-admission.js';

/** Default upper bound for authenticated control-plane JSON requests. */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

export function createJsonBodyParser(getLimitBytes: (req: Request) => number): RequestHandler {
  return createAdmittedJsonBodyParser({
    getLimitBytes,
    rejectUnsupportedMediaType: true,
    parse: parseBoundedBody,
  });
}

export function createControlPlaneJsonBodyParser(): RequestHandler {
  return createJsonBodyParser(() => DEFAULT_JSON_BODY_LIMIT_BYTES);
}

/** Small, unauthenticated credential form parser used only by sign-in routes. */
export function createSmallCredentialBodyParser(): RequestHandler {
  const limitBytes = 64 * 1024;
  return createAdmittedBodyParser({
    getLimitBytes: () => limitBytes,
    shouldParse: (req) => isJsonRequest(req) || isUrlEncodedRequest(req),
    rejectUnsupportedMediaType: true,
    parse: parseBoundedBody,
  });
}
