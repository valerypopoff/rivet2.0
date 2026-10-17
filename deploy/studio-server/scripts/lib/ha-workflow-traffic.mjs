import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** One non-retrying request stream. Stop settles the last request before callers
 * judge the report; closing observation must never hide a late failure. */
export function startHaWorkflowTraffic(gate, baseUrl, phase = () => 'rollout') {
  const report = { samples: 0, failures: [], failedRequests: [], slowestRequest: null };
  let running = true;
  const completion = (async () => {
    while (running) {
      const requestId = randomUUID();
      const observation = { requestId, phase: phase(), startedAt: new Date().toISOString() };
      const start = performance.now();
      try {
        const result = await gate.requestWorkflow(baseUrl, '/workflows/managed-release-workflow', {
          method: 'POST',
          body: JSON.stringify({ input: `ha-sample-${requestId}` }),
          headers: { 'x-rivet-ha-probe-id': requestId },
          timeoutMs: 15_000,
        });
        if (!result) throw Error('Empty execution');
        report.samples++;
      } catch (error) {
        // Do not retain bodies, authorization, URLs, stacks or nested causes.
        observation.error = {
          name: error?.name ?? 'Error',
          code: error?.cause?.code ?? error?.code ?? null,
          status: Number.isInteger(error?.status) ? error.status : null,
        };
        report.failures.push(`${observation.phase} request ${requestId}: ${observation.error.name}`);
        report.failedRequests.push(observation);
      } finally {
        observation.elapsedMs = Math.round(performance.now() - start);
        observation.finishedAt = new Date().toISOString();
        if (!report.slowestRequest || observation.elapsedMs > report.slowestRequest.elapsedMs)
          report.slowestRequest = observation;
      }
      if (running) await new Promise(resolve => setTimeout(resolve, 25));
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
