import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { requestHttp1 } from './continuity-http-transport.mjs';

const errorFacts = (error) => ({
  name: error?.name ?? 'Error',
  ...(error?.code ? { code: error.code } : {}),
  ...(error?.status ? { status: error.status } : {}),
  ...(error?.auditId ? { auditId: error.auditId } : {}),
  ...(error?.kubernetesStatus ? { kubernetesStatus: error.kubernetesStatus } : {}),
  ...(error?.continuityResponse ? { response: error.continuityResponse } : {}),
});

/** Five workflow POSTs: two quick controls, then a changed-route/unchanged-route
 * pair, then one quick request on B. No backend retirement and no POST retries. */
export async function runRivetResponseReset({
  baseUrl,
  backendA,
  backendB,
  change,
  durationMs = 295000,
  evidence = () => {},
}) {
  assert.ok([1000, 295000].includes(durationMs));
  const report = { protocol: 1, qualification: false, durationMs, startedAt: new Date().toISOString(), requests: [] };
  const running = [];
  const settlementDeadline = performance.now() + durationMs + 45000;
  let failure,
    stage = 'setup';
  const emit = (event, data) => {
    try {
      evidence({ event, at: new Date().toISOString(), ...data });
    } catch {
      report.evidenceIncomplete = true;
    }
  };
  const fail = (error) => {
    if (failure) return;
    failure = error;
    emit('first-failure', { stage, error: errorFacts(error) });
  };
  const state = async (backend) => {
    const response = await fetch(backend + '/diagnostic/state', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const send = (stable, hold, owner) => {
    if (failure) return Promise.resolve();
    const requestId = randomUUID();
    const body = JSON.stringify({ requestId, delayMs: hold ? durationMs : 0, input: 'x'.repeat(16384) });
    const receipt = { requestId, route: stable ? 'unchanged' : 'changed', hold, outcome: 'pending' };
    report.requests.push(receipt);
    const started = performance.now();
    const pending = Promise.resolve()
      .then(async () => {
        const result = await requestHttp1(baseUrl + (stable ? '/control' : '') + '/workflows/reset', {
          body,
          agent: false,
          timeoutMs: hold ? durationMs + 30000 : 10000,
          headers: { 'x-diagnostic-request': requestId, 'x-diagnostic-control': stable ? '1' : '0' },
        });
        Object.assign(receipt, { status: result.status, bodyBytes: result.bytes, fullBody: true });
        assert.equal(result.status, 200);
        assert.equal(Number(result.headers['content-length']), result.bytes);
        assert.equal(JSON.parse(result.body).output.value, body);
        assert.equal(result.headers['x-diagnostic-owner'], owner.uid);
        assert.ok(!hold || performance.now() - started >= durationMs, 'Full execution duration must be observed');
        Object.assign(receipt, {
          outcome: 'passed',
          ownerUid: owner.uid,
          bodySha256: createHash('sha256').update(result.body).digest('hex'),
        });
      })
      .catch((error) => {
        Object.assign(receipt, { outcome: 'failed', error: errorFacts(error) });
        fail(error);
      })
      .finally(() => {
        receipt.elapsedMs = performance.now() - started;
      });
    running.push(pending);
    return pending;
  };
  try {
    const [a, b] = await Promise.all([state(backendA), state(backendB)]);
    assert.ok(a.owner.uid && b.owner.uid && a.owner.uid !== b.owner.uid);
    report.owners = { a: a.owner, b: b.owner };
    stage = 'control';
    await Promise.all([send(false, false, a.owner), send(true, false, a.owner)]);
    if (failure) throw failure;
    stage = 'acceptance';
    const pair = [send(false, true, a.owner), send(true, true, a.owner)];
    const held = report.requests.filter((r) => r.hold).map((r) => r.requestId);
    const deadline = performance.now() + 10000;
    for (;;) {
      if (failure) throw failure;
      const current = await state(backendA);
      assert.deepEqual(current.owner, a.owner);
      const rows = current.requests.filter((r) => held.includes(r.requestId));
      if (rows.length === 2 && rows.every((r) => r.accepted && !r.finished && !r.closed)) {
        assert.ok(rows.every((r) => r.upstreamConnection === 'close'));
        report.accepted = rows;
        emit('accepted-before-change', { requests: rows });
        break;
      }
      assert.ok(performance.now() < deadline, 'Real Rivet executions were not observed admitted');
      await delay(5);
    }
    stage = 'routing';
    assert.ok(report.requests.filter((r) => r.hold).every((r) => r.outcome === 'pending'));
    report.changeAttempted = true;
    report.change = await change();
    report.routingChangedAt = new Date().toISOString();
    emit('routing-changed', { change: report.change });
    if (failure) throw failure;
    assert.ok(
      report.requests.filter((r) => r.hold).every((r) => r.outcome === 'pending'),
      'Responses ended before routing change was confirmed',
    );
    // A successful Service PATCH does not prove dataplane convergence. Observe
    // fresh GETs before sending the one post-change workflow request.
    const routingDeadline = performance.now() + 20000;
    for (;;) {
      if (failure) throw failure;
      const response = await requestHttp1(baseUrl + '/readyz', { agent: false, timeoutMs: 3000 });
      assert.equal(response.status, 200);
      const uid = JSON.parse(response.body).owner?.uid;
      if (uid === b.owner.uid) break;
      assert.equal(uid, a.owner.uid, 'Foreign diagnostic backend');
      assert.ok(performance.now() < routingDeadline, 'Fresh connections did not converge to B');
      await delay(25);
    }
    await send(false, false, b.owner);
    if (failure) throw failure;
    report.newConnectionsReachedB = true;
    stage = 'responses';
    await Promise.all(pair);
  } catch (error) {
    fail(error);
  } finally {
    // Do not cancel/replay accepted graph work after another request fails.
    await Promise.allSettled(running);
    try {
      for (;;) {
        const [a, b] = await Promise.all([state(backendA), state(backendB)]);
        assert.deepEqual(a.owner, report.owners.a);
        assert.deepEqual(b.owner, report.owners.b);
        report.final = { a, b };
        const rows = [...a.requests, ...b.requests];
        report.acceptedWorkSettled =
          a.activeRuns === 0 &&
          b.activeRuns === 0 &&
          [...a.requests, ...b.requests].every((r) => r.finished || r.closed);
        if (report.acceptedWorkSettled) {
          const ids = new Set(rows.map((r) => r.requestId));
          assert.equal(ids.size, rows.length, 'Duplicate workflow execution');
          assert.ok(
            rows.every((row) => report.requests.some((r) => r.requestId === row.requestId)),
            'Unexpected workflow execution',
          );
          report.unobservedRequests = report.requests.filter((r) => !ids.has(r.requestId)).map((r) => r.requestId);
          assert.ok(
            report.requests.filter((r) => !ids.has(r.requestId)).every((r) => r.outcome === 'failed'),
            'Successful response has no execution receipt',
          );
          break;
        }
        assert.ok(performance.now() < settlementDeadline, 'Accepted Rivet executions have not settled');
        await delay(50);
      }
    } catch (error) {
      fail(error);
    }
  }
  report.outcome = failure
    ? report.requests.some((r) => r.outcome === 'failed')
      ? 'failed'
      : 'inconclusive'
    : 'passed';
  if (failure) report.error = errorFacts(failure);
  report.finishedAt = new Date().toISOString();
  return report;
}
