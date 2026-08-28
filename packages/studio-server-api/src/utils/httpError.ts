export type HttpError = Error & { status: number; expose?: boolean };

export function createHttpError(
  status: number,
  message: string,
  options?: { expose?: boolean },
): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  if (options?.expose) {
    error.expose = true;
  }
  return error;
}

export function badRequest(message: string): HttpError {
  return createHttpError(400, message);
}

export function conflict(message: string): HttpError {
  return createHttpError(409, message);
}
