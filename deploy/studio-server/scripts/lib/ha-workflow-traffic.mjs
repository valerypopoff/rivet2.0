import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** One non-retrying request stream. Stop settles the last request before callers
 * judge the report; closing observation must never hide a late failure. */
export function startHaWorkflowTraffic(gate, baseUrl, phase = () => 'rollout') {
  return startTraffic(phase, async (requestId) => {
    const result = await gate.requestWorkflow(baseUrl, '/workflows/managed-release-workflow', {
      method: 'POST',
      body: JSON.stringify({ input: `ha-sample-${requestId}` }),
      headers: { 'x-rivet-ha-probe-id': requestId },
      timeoutMs: 15_000,
    });
    if (!result) throw Error('Empty execution');
  }, 25);
}

export function startHaWebAppTraffic(gate, baseUrl, phase = () => 'rollout') {
  return startTraffic(phase, async (requestId) => {
    const html = await gate.requestWorkflow(baseUrl, '/apps/release-gate-web-app', {
      headers: { 'x-rivet-ha-probe-id': requestId }, timeoutMs: 15_000,
    });
    if (typeof html !== 'string' || !html.includes('Managed release gate app'))
      throw Error('Missing published web app');
  }, 1000);
}

function startTraffic(phase, request, intervalMs) {
  const report = { samples: 0, failures: [], failedRequests: [], slowestRequest: null };
  let running = true;
  const completion = (async () => {
    while (running) {
      const requestId = randomUUID();
      const observation = { requestId, phase: phase(), startedAt: new Date().toISOString() };
      const start = performance.now();
      try {
        await request(requestId);
        report.samples++;
      } catch (error) {
        // Do not retain bodies, authorization, URLs, stacks or nested causes.
        observation.error = {
          name: error?.name ?? 'Error',
          code: error?.cause?.code ?? error?.code ?? null,
          status: Number.isInteger(error?.status) ? error.status : null,
        };
        // Copy only the bounded, source-owned classification, never an arbitrary
        // error object or response body into the sanitized traffic receipt.
        if (error?.httpEvidence) {
          const e = error.httpEvidence;
          if (['nginx', 'google', 'other'].includes(e.server) && ['html', 'json', 'other'].includes(e.format) &&
              /^[a-f0-9]{64}$/.test(e.bodySha256) && Number.isSafeInteger(e.bodyBytes) && e.bodyBytes >= 0)
            observation.http = { server: e.server, format: e.format, bodySha256: e.bodySha256, bodyBytes: e.bodyBytes };
        }
        report.failures.push(`${observation.phase} request ${requestId}: ${observation.error.name}`);
        report.failedRequests.push(observation);
      } finally {
        observation.elapsedMs = Math.round(performance.now() - start);
        observation.finishedAt = new Date().toISOString();
        if (!report.slowestRequest || observation.elapsedMs > report.slowestRequest.elapsedMs)
          report.slowestRequest = observation;
      }
      if (running) await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    report,
    async stop() {
      running = false;
      await completion;
      return report;
    },
  };
}
