import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAdmission, setAdmission } from './qualification-admission.mjs';
import { createQualificationGithubApi, githubFailureDetails } from './qualification-github-api.mjs';

function fixture({ responses = [], attempts = 1 } = {}) {
  let time = Date.parse('2026-11-07T00:00:00Z'),
    guards = 0;
  const name = 'RIVET_AUTOMATED_QUALIFICATION_ENABLED';
  const resources = ['actions/variables/', 'environments/rivet-managed-staging/variables/'].map((s) => s + name);
  const flags = new Map(
    resources.map((resource) => [resource, { name, value: 'false', created_at: 'created', updated_at: 'original' }]),
  );
  const records = new Map(),
    writes = [],
    sleeps = [];
  const f = {
    enabled: true,
    limits: { allowanceUsd: 30, testSeconds: 7200 },
    ownership: { operationId: 'local-test', requestSha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40) },
    recovery:
      attempts === 1 ? { maxAttempts: 1 } : { maxAttempts: attempts, deadline: new Date(time + 60000).toISOString() },
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    checkOwnership: async () => {
      guards++;
    },
    persist: async (name, value) => {
      assert.ok(!records.has(name), 'Exclusive receipt');
      records.set(name, structuredClone(value));
    },
    store: { exists: async (name) => records.has(name), read: async (name) => structuredClone(records.get(name)) },
    api: async (method, resource, body) => {
      if (method === 'GET') {
        if (flags.has(resource)) return { status: 200, value: structuredClone(flags.get(resource)) };
        return {
          status: 200,
          value: { value: resource.endsWith('MAX_USD') ? String(f.limits.allowanceUsd) : String(f.limits.testSeconds) },
        };
      }
      assert.equal(method, 'PATCH');
      assert.ok(resources.includes(resource));
      writes.push({ resource, body });
      const response = responses.shift() ?? { status: 204, applied: true };
      if (response.applied)
        flags.set(resource, { ...flags.get(resource), value: body.value, updated_at: String(time++) });
      if (response.error) throw response.error;
      return response;
    },
    resources,
    flags,
    records,
    writes,
    sleeps,
    guards: () => guards,
  };
  return f;
}

test('500 after application is adopted by GET without a second PATCH', async () => {
  const f = fixture({
    responses: [
      {
        status: 500,
        applied: true,
        value: { message: 'Internal Server Error' },
        diagnostics: { requestId: 'ABC:123' },
      },
    ],
  });
  await setAdmission(f);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(
    (await inspectAdmission(f.api, f.limits)).map((f) => f.value),
    ['true', 'true'],
  );
  assert.equal(f.records.get('ADMISSION-ENABLE-0-ACK.private.json').requestId, 'ABC:123');
});

test('500 without application retries only the constant PATCH under explicit policy', async () => {
  const f = fixture({ attempts: 2, responses: [{ status: 500 }] });
  await setAdmission(f);
  assert.equal(f.writes.length, 3);
  assert.deepEqual(f.writes[0], f.writes[1]);
  assert.ok(f.sleeps.includes(2000));
  assert.ok(f.records.has('ADMISSION-ENABLE-0-RETRY-1-COMMAND-INTENT.private.json'));
});

test('retry is disabled by default and cannot be enlarged on resume', async () => {
  const f = fixture({ responses: [{ status: 500 }] });
  await assert.rejects(setAdmission(f), /recovery exhausted/);
  await assert.rejects(
    setAdmission({ ...f, recovery: { maxAttempts: 2, deadline: '2026-11-07T00:01:00Z' } }),
    /retry policy changed/,
  );
  assert.equal(f.writes.length, 1);
});

test('persistent 500 is capped across invocations', async () => {
  const f = fixture({ attempts: 2, responses: [{ status: 500 }, { status: 500 }] });
  await assert.rejects(setAdmission(f), /recovery exhausted/);
  await assert.rejects(setAdmission(f), /recovery exhausted/);
  assert.equal(f.writes.length, 2);
});

test('lost transport acknowledgement is reconciled without replay', async () => {
  const f = fixture({ responses: [{ applied: true, error: new DOMException('sensitive', 'TimeoutError') }] });
  await setAdmission(f);
  assert.equal(f.writes.length, 2);
  assert.ok(!JSON.stringify([...f.records]).includes('sensitive'));
});

test('interruption after both writes resumes without repeating either PATCH', async () => {
  const f = fixture(),
    original = f.persist;
  f.persist = async (name, value) => {
    if (name === 'ADMISSION-ENABLED.private.json') throw Error('disk interrupted');
    return original(name, value);
  };
  await assert.rejects(setAdmission(f), /disk interrupted/);
  await setAdmission({ ...f, persist: original });
  await setAdmission({ ...f, persist: original });
  assert.equal(f.writes.length, 2);
});

test('missing ACK after an applied write resumes through readback', async () => {
  const f = fixture(),
    original = f.persist;
  f.persist = async (name, value) => {
    if (name === 'ADMISSION-ENABLE-0-ACK.private.json') throw Error('disk interrupted');
    return original(name, value);
  };
  await assert.rejects(setAdmission(f), /disk interrupted/);
  await setAdmission({ ...f, persist: original });
  assert.equal(f.writes.length, 2);
});

test('permanent API rejection is never retried', async () => {
  for (const status of [401, 403, 404, 422]) {
    const f = fixture({ attempts: 2, responses: [{ status }] });
    await assert.rejects(setAdmission(f), /API rejected/);
    assert.equal(f.writes.length, 1);
  }
});

test('deadline expiry, ownership loss, allowance and flag drift prevent retry', async () => {
  for (const kind of ['expiry', 'owner', 'limits', 'flag']) {
    const f = fixture({ attempts: 2, responses: [{ status: 500 }] });
    const sleep = f.sleep;
    f.sleep = async (ms) => {
      await sleep(ms);
      if (kind === 'expiry') f.now = () => Date.parse(f.recovery.deadline);
      if (kind === 'owner')
        f.checkOwnership = async () => {
          throw Error('owner lost');
        };
      if (kind === 'limits') f.api = async () => ({ status: 200, value: { value: 'unapproved' } });
      if (kind === 'flag')
        f.flags.set(f.resources[1], { ...f.flags.get(f.resources[1]), updated_at: 'concurrent edit' });
    };
    // Mutable injected callbacks delegate to the current fixture hooks.
    await assert.rejects(
      setAdmission({
        ...f,
        now: () => f.now(),
        api: (...args) => f.api(...args),
        checkOwnership: () => f.checkOwnership(),
      }),
    );
    assert.equal(f.writes.length, 1, kind);
  }
});

test('Retry-After is honored, and excessive delay stops rather than shortening it', async () => {
  const f = fixture({ attempts: 2, responses: [{ status: 429, diagnostics: { retryAfter: '5' } }] });
  await setAdmission(f);
  assert.ok(f.sleeps.includes(5000));
  const excessive = fixture({ attempts: 2, responses: [{ status: 429, diagnostics: { retryAfter: '120' } }] });
  await assert.rejects(setAdmission(excessive), /exceeds deadline/);
  assert.equal(excessive.writes.length, 1);
  const limited = fixture({
    attempts: 2,
    responses: [
      {
        status: 429,
        diagnostics: {
          rateLimitRemaining: '0',
          rateLimitReset: String(Date.parse('2026-11-07T00:02:00Z') / 1000),
        },
      },
    ],
  });
  await assert.rejects(setAdmission(limited), /exceeds deadline/);
  assert.equal(limited.writes.length, 1);
});

test('successful acknowledgement with stale reads cannot authorize another PATCH', async () => {
  const f = fixture({ attempts: 2, responses: [{ status: 204, applied: false }] });
  await assert.rejects(setAdmission(f), /recovery exhausted/);
  assert.equal(f.writes.length, 1);
});

test('transport failure before application is bounded by the same retry policy', async () => {
  const f = fixture({ attempts: 2, responses: [{ error: new DOMException('timeout', 'TimeoutError') }] });
  await setAdmission(f);
  assert.equal(f.writes.length, 3);
});

test('owned records cannot be resumed by another owner or with altered limits', async () => {
  const f = fixture({ responses: [{ status: 500 }] });
  await assert.rejects(setAdmission(f), /recovery exhausted/);
  await assert.rejects(setAdmission({ ...f, ownership: { ...f.ownership, operationId: 'other' } }), /owner changed/);
  await assert.rejects(setAdmission({ ...f, limits: { ...f.limits, allowanceUsd: 40 } }), /allowance changed/);
  assert.equal(f.writes.length, 1);
});

test('request IDs and allowlisted metadata survive; raw body and header secrets do not', async () => {
  const secret = 'private-token-and-values';
  const api = createQualificationGithubApi({
    repository: 'example/repo',
    token: () => secret,
    fetch: async (url, options) => {
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ message: `Internal Server Error ${secret}`, errors: [secret] }), {
        status: 500,
        headers: {
          'x-github-request-id': 'ABC:123',
          'retry-after': '2',
          'set-cookie': secret,
          date: 'Sat, 07 Nov 2026 00:00:00 GMT',
          'x-ratelimit-remaining': '42',
          'x-ratelimit-reset': '1794009600',
        },
      });
    },
  });
  const details = githubFailureDetails(await api('PATCH', 'actions/variables/FLAG', { value: 'true' }));
  assert.equal(details.message, 'Internal Server Error');
  assert.equal(details.requestId, 'ABC:123');
  assert.equal(details.retryAfter, '2');
  assert.equal(details.rateLimitRemaining, '42');
  assert.ok(!JSON.stringify(details).includes(secret));
});

test('transport retains status/request ID for non-JSON errors and never retries writes', async () => {
  let calls = 0;
  const api = createQualificationGithubApi({
    repository: 'example/repo',
    token: () => 'test',
    fetch: async () => {
      calls++;
      return new Response('<html>private upstream response</html>', {
        status: 502,
        headers: { 'x-github-request-id': 'ABC:456' },
      });
    },
  });
  const result = await api('POST', 'actions/workflows/release.yml/dispatches', {});
  assert.equal(calls, 1);
  assert.equal(result.status, 502);
  assert.equal(result.diagnostics.requestId, 'ABC:456');
  assert.ok(!JSON.stringify(result.diagnostics).includes('private upstream'));
  await assert.rejects(api('GET', '../../../other/repo'), /escaped/);
});
