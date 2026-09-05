const transientRegistryFailurePattern =
  /RequestError: Timeout awaiting 'socket'|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|Response Code: (?:408|425|429|500|502|503|504)\b/u;

export const auditRetryDelaysMs = [10_000, 30_000, 60_000];

export const hasPotentialAuditJsonRows = (text) => text.split(/\r?\n/).some((line) => line.trimStart().startsWith('{'));

export const isTransientAuditFailure = (result) => {
  const output = result.stdout ?? '';
  if (hasPotentialAuditJsonRows(output)) return false;

  return (
    result.error?.code === 'ETIMEDOUT' ||
    (result.status !== 0 && transientRegistryFailurePattern.test(`${output}\n${result.stderr ?? ''}`))
  );
};

const formatDelay = (delayMs) => `${delayMs / 1000}s`;
const waitForRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const runAuditWithRetries = async ({
  run,
  warn = console.warn,
  wait = waitForRetry,
  retryDelays = auditRetryDelaysMs,
}) => {
  let result;
  for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
    result = run();
    const isTransient = isTransientAuditFailure(result);
    if (result.error && !isTransient) throw result.error;

    const retryDelayMs = retryDelays[attempt - 1];
    if (!isTransient || retryDelayMs === undefined) return result;

    warn(
      `Dependency audit attempt ${attempt} hit a transient registry failure; retrying before attempt ${attempt + 1} in ${formatDelay(retryDelayMs)}.`,
    );
    await wait(retryDelayMs);
  }

  throw new Error('Dependency audit retry loop ended without a result.');
};
