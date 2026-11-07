import assert from 'node:assert/strict';
import https from 'node:https';
import http2 from 'node:http2';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { requestHttp1, requestHttp2 } from './continuity-http-transport.mjs';

export const diagnosticLabel = 'rivet.dev/connection-reset';
export const diagnosticNamespace = /^rivet-reset-[a-f0-9]{12}$/;
export const diagnosticResponseBytes = 16568;

export function diagnosticPodReady(pod) {
  const phase = pod?.status?.phase;
  const terminated = pod?.status?.containerStatuses?.find(
    (container) => container.name === 'diagnostic' && container.state?.terminated,
  );
  assert.ok(
    !['Succeeded', 'Failed'].includes(phase) && !terminated,
    `Diagnostic Pod ${pod?.metadata?.name ?? 'unknown'} exited before readiness`,
  );
  assert.ok(!pod?.metadata?.deletionTimestamp, 'Diagnostic Pod is being deleted');
  return (
    pod?.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True') ?? false
  );
}

// One compare-and-swap only. An uncertain acknowledgement is read back, never
// replayed. This adapter cannot address the retained application Service.
export async function changeDiagnosticService(api, namespace) {
  assert.match(namespace, diagnosticNamespace);
  const path = `/api/v1/namespaces/${namespace}/services/execution`;
  const before = await api('GET', path);
  const original = { [diagnosticLabel]: namespace, pool: 'a' };
  const selected = { ...original, pool: 'b' };
  assert.equal(before.metadata?.name, 'execution');
  assert.equal(before.metadata?.namespace, namespace);
  assert.equal(before.metadata?.labels?.[diagnosticLabel], namespace);
  assert.ok(before.metadata.uid && before.metadata.resourceVersion);
  assert.equal(before.spec?.type, 'ClusterIP');
  assert.ok(before.spec.clusterIP && before.spec.clusterIP !== 'None');
  assert.deepEqual(before.spec.selector, original);
  const patch = [
    { op: 'test', path: '/metadata/uid', value: before.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: before.metadata.resourceVersion },
    { op: 'test', path: '/spec/selector', value: original },
    { op: 'replace', path: '/spec/selector', value: selected },
  ];
  let writeError;
  try {
    await api('PATCH', path, patch);
  } catch (error) {
    writeError = error;
  }
  const after = await api('GET', path);
  const verified =
    after.metadata?.uid === before.metadata.uid &&
    after.metadata?.labels?.[diagnosticLabel] === namespace &&
    isDeepStrictEqual(after.spec?.selector, selected) &&
    isDeepStrictEqual(after.spec?.clusterIPs, before.spec.clusterIPs) &&
    after.spec?.clusterIP === before.spec.clusterIP &&
    isDeepStrictEqual(after.spec?.ports, before.spec.ports);
  if (!verified) throw writeError ?? Error('Diagnostic Service change was not confirmed');
  return { serviceUid: before.metadata.uid, before: original, after: selected, acknowledged: !writeError };
}

const errorFacts = (error) => ({
  name: /^[A-Za-z_]{1,64}$/.test(error?.name) ? error.name : 'Error',
  ...(/^[A-Z0-9_]{1,64}$/.test(error?.code) ? { code: error.code } : {}),
  ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
  ...(error?.continuityResponse
    ? {
        status: error.continuityResponse.status,
        bodyBytes: error.continuityResponse.bodyBytes,
        fullBody: false,
      }
    : {}),
});

/** Six POSTs: a three-transport control, then three responses held across one
 * endpoint change. Existing owners remain alive. This produces diagnostics,
 * never a release qualification or a claim about 300-second requests. */
export async function runConnectionResetDiagnostic({
  baseUrl,
  backendA,
  backendB,
  change,
  timeoutMs = 20000,
  evidence = () => {},
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20000);
  const report = {
    protocol: 1,
    qualification: false,
    startedAt: new Date().toISOString(),
    requests: [],
    changeState: 'not-attempted',
  };
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const session = http2.connect(baseUrl);
  session.on('error', () => {});
  const running = [];
  let firstFailure,
    releaseAttempted = false,
    stage = 'control';
  const heldIds = [];
  const emit = (event, data) => {
    try {
      evidence({ event, at: new Date().toISOString(), ...data });
    } catch {
      report.evidenceIncomplete = true;
    }
  };
  const fail = (error) => {
    if (!firstFailure) {
      firstFailure = error;
      emit('first-failure', { stage, error: errorFacts(error), requests: structuredClone(report.requests) });
    }
  };
  const json = async (url, body) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)),
    });
    if (response.status !== 200)
      throw Object.assign(Error('Diagnostic control request failed'), {
        code: 'DIAGNOSTIC_CONTROL_HTTP',
        status: response.status,
      });
    return response.json();
  };
  const until = async (check) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (firstFailure) throw firstFailure;
      const value = await check();
      if (value) return value;
      await delay(50);
    }
    throw Error('Diagnostic observation deadline exceeded');
  };
  const batch = (hold, expectedOwner) => {
    return ['fresh-http1', 'pooled-http1', 'http2'].map((transport) => {
      const requestId = randomUUID();
      const body = JSON.stringify({ requestId, hold, input: 'x'.repeat(16384) });
      const receipt = { stage, transport, requestId, startedAt: new Date().toISOString(), outcome: 'pending' };
      if (hold) heldIds.push(requestId);
      report.requests.push(receipt);
      const work = Promise.resolve()
        .then(async () => {
          if (firstFailure) throw firstFailure;
          const result = await (transport === 'http2'
            ? requestHttp2(session, '/workflows/fixture', {
                body,
                headers: { 'x-diagnostic-request': requestId },
                timeoutMs: 45000,
              })
            : requestHttp1(baseUrl + '/workflows/fixture', {
                body,
                headers: { 'x-diagnostic-request': requestId },
                agent: transport === 'pooled-http1' ? agent : false,
                timeoutMs: 45000,
              }));
          Object.assign(receipt, { status: result.status, bodyBytes: result.bytes, responseEnded: true });
          assert.equal(result.status, 200);
          assert.equal(result.bytes, diagnosticResponseBytes);
          assert.equal(JSON.parse(result.body).output.value, body);
          assert.equal(result.headers['x-diagnostic-owner'], expectedOwner.uid);
          Object.assign(receipt, {
            outcome: 'passed',
            fullBody: true,
            ownerUid: expectedOwner.uid,
            bodySha256: createHash('sha256').update(result.body).digest('hex'),
          });
        })
        .catch((error) => {
          receipt.outcome = 'failed';
          receipt.error = errorFacts(error);
          fail(error);
        })
        .finally(() => {
          receipt.finishedAt = new Date().toISOString();
          receipt.elapsedMs = Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt);
        });
      running.push(work);
      return work;
    });
  };
  try {
    report.owners = { a: (await json(backendA + '/state')).owner, b: (await json(backendB + '/state')).owner };
    assert.ok(report.owners.a.uid && report.owners.b.uid && report.owners.a.uid !== report.owners.b.uid);
    assert.equal((await requestHttp1(baseUrl + '/readyz', { agent, timeoutMs: 3000 })).status, 200);
    assert.equal((await requestHttp2(session, '/readyz', { timeoutMs: 3000 })).status, 200);
    assert.equal(session.socket.alpnProtocol, 'h2');
    await new Promise(setImmediate);
    await Promise.all(batch(false, report.owners.a));
    if (firstFailure) throw firstFailure;
    stage = 'endpoint-change';
    const pending = batch(true, report.owners.a);
    const accepted = await until(async () => {
      const state = await json(backendA + '/state');
      const rows = state.requests.filter((r) => heldIds.includes(r.requestId));
      return rows.length === 3 && rows.every((r) => r.held && r.prefixBytes > 0 && !r.finished && !r.closed) && state;
    });
    report.accepted = accepted.requests.filter((r) => heldIds.includes(r.requestId));
    for (const owner of report.accepted)
      Object.assign(
        report.requests.find((r) => r.requestId === owner.requestId),
        {
          acceptedAt: owner.acceptedAt,
          ownerUid: owner.ownerUid,
        },
      );
    if (firstFailure) throw firstFailure;
    emit('accepted-before-change', { owners: report.owners, accepted: report.accepted });
    report.changeState = 'uncertain';
    report.change = await change();
    report.changeState = 'confirmed';
    report.changedAt = new Date().toISOString();
    emit('selector-change-confirmed', { change: report.change });
    // Read-only fresh connections observe data-plane convergence; no POST retry.
    await until(async () => {
      const response = await requestHttp1(baseUrl + '/owner', { agent: false, timeoutMs: 3000 });
      assert.equal(response.status, 200);
      return JSON.parse(response.body).uid === report.owners.b.uid;
    });
    const beforeRelease = await json(backendA + '/state');
    assert.deepEqual(beforeRelease.owner, report.owners.a, 'Original owner changed');
    assert.deepEqual((await json(backendB + '/state')).owner, report.owners.b, 'Replacement owner changed');
    assert.ok(
      heldIds.every((id) =>
        beforeRelease.requests.some((r) => r.requestId === id && r.held && !r.closed && !r.finished && !r.autoReleased),
      ),
    );
    report.newConnectionsReachedB = true;
    releaseAttempted = true;
    await json(backendA + '/release', { requestIds: heldIds });
    await Promise.all(pending);
    if (firstFailure) throw firstFailure;
    report.outcome = 'passed';
  } catch (error) {
    fail(error);
    report.failure = { stage, ...errorFacts(firstFailure) };
    report.outcome = 'failed';
  } finally {
    // No new workflow requests after failure. Release only our accepted work,
    // once, then let every issued response finish before closing transports.
    if (heldIds.length && !releaseAttempted) {
      releaseAttempted = true;
      try {
        const state = await json(backendA + '/state');
        const requestIds = state.requests
          .filter((r) => heldIds.includes(r.requestId) && r.held && !r.released)
          .map((r) => r.requestId);
        if (requestIds.length) await json(backendA + '/release', { requestIds });
      } catch (error) {
        report.settlementError = errorFacts(error);
      }
    }
    await Promise.allSettled(running);
    try {
      report.final = { a: await json(backendA + '/state'), b: await json(backendB + '/state') };
      const rows = [...report.final.a.requests, ...report.final.b.requests];
      assert.equal(rows.length, report.requests.length, 'Unexpected or duplicated workflow execution');
      assert.equal(new Set(rows.map((r) => r.requestId)).size, rows.length);
      assert.ok(rows.every((r) => !r.held && (r.finished || r.closed)));
      report.acceptedWorkSettled = true;
      assert.ok(
        rows.every((r) => !r.autoReleased),
        'Observation exceeded the short response hold',
      );
    } catch (error) {
      report.outcome = 'failed';
      report.settlementError ??= errorFacts(error);
    }
    agent.destroy();
    session.destroy();
    // Setup, API admission and observation deadlines are not proof of a
    // broken response. Keep them distinct from a reproduced transport failure.
    if (report.outcome === 'failed' && report.requests.every((request) => request.outcome !== 'failed'))
      report.outcome = 'inconclusive';
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
