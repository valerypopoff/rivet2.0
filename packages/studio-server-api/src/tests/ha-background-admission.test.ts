import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createPublishedExecutionAdmission,
  toPublishedExecutionAdmissionError,
} from '../published-execution-admission.js';

const { HaReleaseProbes } = (await import(
  new URL('../../../../deploy/studio-server/scripts/lib/ha-release-probes.mjs', import.meta.url).href
)) as {
  HaReleaseProbes: new (
    gate: unknown,
    base: string,
    root: string,
  ) => {
    backgroundEndpoint: string;
    backgroundWorkflowId: string;
    background: { correlationId: string; uid: string }[];
    beforeRetirement(pod: { name: string; uid: string; container: string }): Promise<void>;
  };
};

test('retirement probe waits for explicit capacity rejection at the real four-run limit and starts work once', async (t) => {
  const admission = createPublishedExecutionAdmission({ mode: 'enforce', maxActiveRuns: 4, retryAfterSeconds: 1 });
  const permits = Array.from({ length: 4 }, () => {
    const result = admission.acquire('workflow-endpoint');
    assert.equal(result.kind, 'accepted');
    if (result.kind !== 'accepted') throw Error('fixture admission failed');
    return result.permit;
  });
  let rejected = 0;
  let started = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/workflows/background');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { input: 'preserved' });
    const result = admission.acquire('workflow-endpoint');
    res.setHeader('content-type', 'application/json');
    if (result.kind !== 'accepted') {
      rejected++;
      const error = toPublishedExecutionAdmissionError(result);
      res.writeHead(error.status, { 'Retry-After': String(error.retryAfterSeconds) });
      res.end(JSON.stringify({ error: { code: error.code } }));
      permits[0]!.release(); // An existing run settles; rejected work never acquired a permit.
      return;
    }
    permits.push(result.permit);
    started++;
    res.setHeader('x-rivet-correlation-id', 'accepted-background');
    res.end(JSON.stringify({ output: { value: JSON.stringify({ input: 'preserved' }) } }));
  });
  t.after(async () => {
    permits.forEach((permit) => permit.release());
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const gate = {
    config: { namespace: 'fixture' },
    kubectl: async (args: string[]) => {
      let stdout = '';
      // Execute the exact self-contained source sent to the retiring Pod.
      await runInNewContext(`(async () => { ${args.at(-1)} })()`, {
        fetch,
        AbortSignal,
        performance,
        setTimeout,
        process: { env: { PORT: String(address.port), RIVET_KEY: 'fixture-key' } },
        console: {
          log: (line: string) => {
            stdout += line;
          },
        },
      });
      return { stdout };
    },
  };
  const probes = new HaReleaseProbes(gate, 'http://unused.invalid', '.');
  probes.backgroundEndpoint = 'background';
  probes.backgroundWorkflowId = 'owned-workflow';
  await probes.beforeRetirement({ name: 'fixture-ha-execution-0', uid: 'original-owner', container: 'backend' });
  assert.equal(rejected, 1);
  assert.equal(started, 1);
  assert.equal(admission.getSnapshot().activeRuns, 4, 'accepted background work retains its permit');
  assert.equal(probes.background.length, 1);
  assert.equal(probes.background[0]!.uid, 'original-owner');
  assert.equal(probes.background[0]!.correlationId, 'accepted-background');
});
