import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { submitHaBackgroundProbe } from './lib/ha-background-probe.mjs';

for (const scenario of [
  'draining',
  'unknown429',
  'server',
  'transport',
  'body',
  'accepted',
  'missing-header',
  'deadline',
]) {
  test(`background admission never replays an uncertain or invalid request: ${scenario}`, async () => {
    let calls = 0;
    const fetchRequest = async () => {
      calls++;
      if (scenario === 'transport') throw Error('connection reset after acceptance');
      if (scenario === 'body') return new Response('truncated', { status: 200 });
      if (scenario === 'accepted')
        return Response.json({ output: { value: 'preserved' } }, { headers: { 'x-rivet-correlation-id': 'once' } });
      const status = scenario === 'draining' ? 503 : scenario === 'server' ? 500 : 429;
      const code = scenario === 'unknown429' ? 'unknown' : 'execution_capacity_exceeded';
      return Response.json(
        { error: { code } },
        {
          status,
          headers: scenario === 'missing-header' ? {} : { 'retry-after': '1' },
        },
      );
    };
    const run = () => submitHaBackgroundProbe('http://unused.invalid', 'fixture-key', { timeoutMs: 100, fetchRequest });
    if (scenario === 'accepted') assert.equal((await run()).correlationId, 'once');
    else await assert.rejects(run());
    assert.equal(calls, 1);
  });
}

test('background admission uses one deadline across explicitly rejected attempts', async () => {
  let calls = 0;
  let now = 0;
  const run = runInNewContext(`(${submitHaBackgroundProbe.toString()})`, {
    performance: { now: () => now },
    AbortSignal,
    setTimeout: (resolve, ms) => {
      now += ms;
      resolve();
    },
    fetch: async () => {
      calls++;
      return Response.json(
        { error: { code: 'execution_capacity_exceeded' } },
        {
          status: 429,
          headers: { 'retry-after': '1' },
        },
      );
    },
  });
  await assert.rejects(run('http://unused.invalid', 'fixture-key', { timeoutMs: 1500 }), /capacity remained full/);
  assert.equal(calls, 2);
  assert.equal(now, 1000);
});

test('bundling preserves the self-contained Pod probe without compiler-only dependencies', async () => {
  const result = await build({
    stdin: { contents: `export ${submitHaBackgroundProbe.toString()}`, loader: 'js' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
  });
  const bundled = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
  let calls = 0;
  const run = runInNewContext(`(${bundled.submitHaBackgroundProbe.toString()})`, {
    performance,
    AbortSignal,
    fetch: async () => {
      calls++;
      return Response.json(
        { output: { value: 'preserved' } },
        { headers: { 'x-rivet-correlation-id': 'bundled-once' } },
      );
    },
  });
  assert.equal((await run('http://unused.invalid', 'fixture-key')).correlationId, 'bundled-once');
  assert.equal(calls, 1);
});

for (const phase of ['headers', 'body']) {
  test(`background admission aborts a stalled ${phase} without replaying the request`, async (t) => {
    const server = createServer((_req, res) => {
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{'); // Execution may have started; an incomplete reply must never be retried.
      }
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let calls = 0;
    await assert.rejects(
      submitHaBackgroundProbe(`http://127.0.0.1:${server.address().port}`, 'fixture-key', {
        timeoutMs: 500,
        fetchRequest: (...args) => {
          calls++;
          return fetch(...args);
        },
      }),
      (error) => ['AbortError', 'TimeoutError'].includes(error.name),
    );
    assert.equal(calls, 1);
  });
}
