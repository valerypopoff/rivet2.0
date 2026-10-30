/** Private, bounded error provenance. Never serialize request bodies, process
 * environments, stdout or arbitrary properties from an adapter/command error. */
export function deploymentFailureDetails(error) {
  const seen = new Set();
  let remaining = 24;
  const visit = (value, depth = 0) => {
    if (remaining-- <= 0 || depth > 6) return { truncated: true };
    if (value && typeof value === 'object') {
      if (seen.has(value)) return { circular: true };
      seen.add(value);
    }
    if (!(value instanceof Error)) return { message: String(value).slice(0, 4096) };
    return {
      name: typeof value.name === 'string' ? value.name.slice(0, 128) : 'Error',
      message: value.message.slice(0, 12000),
      stack: value.stack?.slice(0, 16000),
      ...(typeof value.code === 'string' ? { code: value.code.slice(0, 128) } : {}),
      ...(value.cause === undefined ? {} : { cause: visit(value.cause, depth + 1) }),
      ...(Array.isArray(value.errors) ? { errors: value.errors.slice(0, 8).map((e) => visit(e, depth + 1)) } : {}),
    };
  };
  return { formatVersion: 1, error: visit(error) };
}
