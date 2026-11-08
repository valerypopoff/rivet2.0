const statusReasons = new Set([
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'AlreadyExists',
  'Conflict',
  'Invalid',
  'BadRequest',
  'Timeout',
  'ServerTimeout',
  'TooManyRequests',
  'MethodNotAllowed',
  'NotAcceptable',
  'RequestEntityTooLarge',
  'UnsupportedMediaType',
  'InternalError',
  'ServiceUnavailable',
  'Expired',
  'Unknown',
]);
function safeStatus(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.kind !== 'Status') return undefined;
    return {
      reason: statusReasons.has(value.reason) ? value.reason : 'Unknown',
      causes: (Array.isArray(value.details?.causes) ? value.details.causes : []).slice(0, 4).map((cause) => ({
        ...(statusReasons.has(cause.reason) || /^Field(?:Value|Manager)[A-Za-z]{1,32}$/.test(cause.reason ?? '')
          ? { reason: cause.reason }
          : {}),
        ...(/^(?:metadata|spec|status|data|binaryData)(?:[.[/][A-Za-z0-9_.\[\]/-]{0,140})?$/.test(cause.field ?? '')
          ? { field: cause.field }
          : {}),
      })),
    };
  } catch {
    return undefined;
  }
}
export class KubernetesResponseError extends Error {
  constructor(method, response, bytes) {
    const status = safeStatus(bytes);
    const auditId = /^[a-f0-9-]{36}$/i.test(response.headers['audit-id'] ?? '')
      ? response.headers['audit-id']
      : undefined;
    super(
      `Kubernetes ${method} failed (${response.statusCode}${status ? `; ${status.reason}` : ''})${auditId ? `; audit ${auditId}` : ''}${method === 'GET' ? '.' : '; write acknowledgement may be unknown.'}`,
    );
    this.status = response.statusCode;
    this.retryAfter = response.headers['retry-after'];
    // Status messages and cause messages can echo submitted source or secrets.
    // Retain only bounded reason/field metadata and the server's audit ID.
    if (status) this.kubernetesStatus = status;
    if (auditId) this.auditId = auditId;
  }
}
