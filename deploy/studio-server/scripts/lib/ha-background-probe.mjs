// Self-contained: this exact function is sent into the retiring execution Pod.
export async function submitHaBackgroundProbe(url, key, { timeoutMs = 10000, fetchRequest = fetch } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error('Background retirement probe admission deadline exceeded');
    const response = await fetchRequest(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'preserved' }),
      signal: AbortSignal.timeout(Math.ceil(remaining)),
    });
    const body = await response.json();
    if (response.status === 200)
      return { status: response.status, correlationId: response.headers.get('x-rivet-correlation-id'), body };
    // Only this application-owned rejection proves execution never started.
    // Transport failures, draining and other errors must not replay the POST.
    if (response.status !== 429 || body?.error?.code !== 'execution_capacity_exceeded')
      throw Error(`Background retirement probe rejected (HTTP ${response.status})`);
    const retryAfter = response.headers.get('retry-after');
    if (!/^[1-9][0-9]*$/.test(retryAfter ?? ''))
      throw Error('Background retirement probe capacity rejection has no valid Retry-After');
    const delayMs = Number(retryAfter) * 1000;
    if (!Number.isSafeInteger(delayMs) || delayMs >= deadline - performance.now())
      throw Error('Background retirement probe capacity remained full within its admission deadline');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
