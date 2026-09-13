export type HttpError = Error & {
  status: number;
  expose?: boolean;
  code?: string;
  retryAfterSeconds?: number;
  closeConnection?: boolean;
};

export function createHttpError(
  status: number,
  message: string,
  options?: {
    expose?: boolean;
    code?: string;
    retryAfterSeconds?: number;
    closeConnection?: boolean;
  },
): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  if (options?.expose) {
    error.expose = true;
  }
  if (options?.code) error.code = options.code;
  if (options?.retryAfterSeconds != null) error.retryAfterSeconds = options.retryAfterSeconds;
  if (options?.closeConnection) error.closeConnection = true;
  return error;
}

export function badRequest(message: string): HttpError {
  return createHttpError(400, message);
}

export function conflict(message: string): HttpError {
  return createHttpError(409, message);
}
