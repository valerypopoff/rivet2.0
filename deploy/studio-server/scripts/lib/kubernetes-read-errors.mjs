// Classification only: callers must scope this to GETs and keep their existing
// observation deadline. Never use it to replay a write or an entire rollout.
export function kubernetesReadRetryReason(error, { allowNotFound = false } = {}) {
  if (['AbortError', 'TimeoutError', 'SyntaxError'].includes(error?.name)) return null;
  const reason = /^Error from server \(([A-Za-z]+)\):/m.exec(error?.message ?? '')?.[1];
  if (
    [
      'TooManyRequests',
      'ServiceUnavailable',
      'InternalError',
      'Timeout',
      'ServerTimeout',
      'BadGateway',
      'GatewayTimeout',
    ].includes(reason) ||
    (allowNotFound && reason === 'NotFound')
  )
    return reason;
  return null;
}
