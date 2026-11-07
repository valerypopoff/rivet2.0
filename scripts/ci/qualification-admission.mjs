import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { githubFailureDetails } from './qualification-github-api.mjs';

const name = 'RIVET_AUTOMATED_QUALIFICATION_ENABLED';
const scopes = ['actions/variables', 'environments/rivet-managed-staging/variables'];
const transient = new Set([429, 500, 502, 503, 504]);
const stepName = 'Run approved provider operation and compile evidence after cleanup';
const identity = ({ value, updated_at, ...rest }) => rest;
const transportFailure = (error) =>
  error instanceof TypeError ||
  error instanceof SyntaxError ||
  ['TimeoutError', 'AbortError'].includes(error.name) ||
  ['ECONNRESET', 'ETIMEDOUT'].includes(error.code);

async function get(api, resource) {
  const result = await api('GET', resource);
  assert.equal(result.status, 200, 'Admission settings must be readable');
  return result.value;
}

export async function inspectAdmission(api, { allowanceUsd, testSeconds }) {
  assert.ok(Number.isFinite(allowanceUsd) && allowanceUsd > 0);
  assert.ok(Number.isSafeInteger(testSeconds) && testSeconds > 0);
  const flags = await Promise.all(scopes.map((scope) => get(api, scope + '/' + name)));
  for (const flag of flags) {
    assert.equal(flag.name, name);
    assert.ok(['false', 'true'].includes(flag.value), 'Unknown admission state');
  }
  for (const [key, expected] of [
    ['MAX_USD', allowanceUsd],
    ['MAX_SECONDS', testSeconds],
  ])
    assert.equal(
      (await get(api, scopes[1] + '/RIVET_QUALIFICATION_' + key)).value,
      String(expected),
      'Protected limit differs from this approval',
    );
  return flags;
}

// Recovery is restricted to these two constant-value PATCHes. The caller owns
// the operation fence and must revalidate approval, source and competing runs.
// Persist/create must be exclusive; receipts survive interruption and bound retries.
export async function setAdmission({
  api,
  persist,
  store,
  limits,
  enabled,
  ownership,
  checkOwnership,
  recovery = { maxAttempts: 1 },
  now = Date.now,
  sleep = delay,
}) {
  assert.equal(typeof enabled, 'boolean');
  assert.equal(typeof checkOwnership, 'function', 'Admission requires an ownership guard');
  assert.ok(ownership?.operationId);
  assert.match(ownership?.requestSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(ownership?.sourceSha ?? '', /^[a-f0-9]{40}$/);
  assert.ok(Number.isInteger(recovery.maxAttempts) && recovery.maxAttempts >= 1 && recovery.maxAttempts <= 3);
  if (recovery.maxAttempts > 1)
    assert.ok(Number.isFinite(Date.parse(recovery.deadline)), 'Retry needs an explicit deadline');
  const target = String(enabled),
    tag = enabled ? 'ENABLE' : 'CLOSE';
  const intentName = `ADMISSION-${tag}-INTENT.private.json`;
  await checkOwnership();
  let before;
  if (await store.exists(intentName)) {
    const intent = await store.read(intentName);
    assert.deepEqual(intent.ownership, ownership, 'Admission owner changed');
    assert.deepEqual(intent.limits, limits, 'Admission allowance changed');
    assert.deepEqual(intent.recovery, recovery, 'Admission retry policy changed');
    assert.equal(intent.target, target);
    before = intent.before;
  } else {
    before = await inspectAdmission(api, limits);
    assert.ok(
      before.every((flag) => flag.value === String(!enabled)),
      'Admission state differs; inspect before writing',
    );
    await persist(intentName, { before, target, ownership, limits, recovery });
  }
  assert.equal(before.length, scopes.length);
  assert.ok(before.every((flag) => flag.name === name && flag.value === String(!enabled)));
  const expected = structuredClone(before);
  const initial = await inspectAdmission(api, limits);
  // Reconstruct previously confirmed writes before checking the untouched flag.
  // This covers interruption after either PATCH, including before the final receipt.
  for (let index = 0; index < scopes.length; index++) {
    if (initial[index].value !== target) {
      assert.deepEqual(initial[index], before[index], 'Admission changed during preparation');
      continue;
    }
    let ack,
      issued = false;
    for (let attempt = 0; attempt < recovery.maxAttempts; attempt++) {
      const stem = `ADMISSION-${tag}-${index}${attempt ? '-RETRY-' + attempt : ''}`;
      if (!(await store.exists(stem + '-COMMAND-INTENT.private.json'))) break;
      const command = await store.read(stem + '-COMMAND-INTENT.private.json');
      assert.equal(command.resource, scopes[index] + '/' + name);
      assert.equal(command.target, target);
      assert.deepEqual(command.ownership, ownership);
      issued = true;
      ack = (await store.exists(stem + '-ACK.private.json')) ? await store.read(stem + '-ACK.private.json') : null;
    }
    assert.ok(
      issued && (!ack || ack.status === 204 || ack.transportError || transient.has(ack.status)),
      'Admission changed without an owned recoverable write',
    );
    assert.deepEqual(identity(initial[index]), identity(before[index]), 'Admission identity changed');
    expected[index] = initial[index];
  }
  const valid = () => {
    if (recovery.maxAttempts > 1) assert.ok(now() < Date.parse(recovery.deadline), 'Admission recovery expired');
  };
  for (let index = 0; index < scopes.length; index++) {
    const resource = scopes[index] + '/' + name;
    if (expected[index].value === target) continue;
    let complete = false;
    for (let attempt = 0; attempt < recovery.maxAttempts; attempt++) {
      const stem = `ADMISSION-${tag}-${index}${attempt ? '-RETRY-' + attempt : ''}`;
      const commandName = stem + '-COMMAND-INTENT.private.json',
        ackName = stem + '-ACK.private.json';
      const issued = await store.exists(commandName);
      if (issued) {
        const command = await store.read(commandName);
        assert.equal(command.resource, resource);
        assert.equal(command.target, target);
        assert.deepEqual(command.ownership, ownership);
      }
      await checkOwnership();
      valid();
      let current = await inspectAdmission(api, limits);
      for (let other = 0; other < scopes.length; other++)
        if (other !== index) assert.deepEqual(current[other], expected[other], 'Another admission flag changed');
      const priorAck = (await store.exists(ackName)) ? await store.read(ackName) : null;
      const mayReconcile =
        issued && (!priorAck || priorAck.status === 204 || priorAck.transportError || transient.has(priorAck.status));
      if (current[index].value === target) {
        assert.ok(mayReconcile, 'Admission changed without an owned recoverable write');
        assert.deepEqual(identity(current[index]), identity(before[index]), 'Admission identity changed');
        expected[index] = current[index];
        complete = true;
        break;
      }
      assert.deepEqual(current[index], before[index], 'Admission changed during preparation');
      let ack = priorAck;
      if (!issued) {
        await checkOwnership();
        valid();
        await persist(commandName, { resource, target, ownership });
        let response;
        try {
          response = await api('PATCH', resource, { name, value: target });
        } catch (error) {
          if (!transportFailure(error)) throw error;
          ack = {
            transportError: true,
            errorType: ['TimeoutError', 'AbortError', 'SyntaxError'].includes(error.name)
              ? error.name
              : 'TransportError',
          };
        }
        if (response) ack = githubFailureDetails(response);
        await persist(ackName, ack);
      }
      const recoverable = !ack || ack.status === 204 || ack.transportError || transient.has(ack.status);
      assert.ok(recoverable, 'Admission API rejected the write; inspect diagnostics');
      // Readback is safe even without retry permission. Give propagation a short,
      // bounded window before considering a separately authorized second PATCH.
      for (let read = 0; read < 3; read++) {
        if (read) await sleep(500);
        await checkOwnership();
        valid();
        current = await inspectAdmission(api, limits);
        for (let other = 0; other < scopes.length; other++)
          if (other !== index) assert.deepEqual(current[other], expected[other], 'Another admission flag changed');
        if (current[index].value === target) {
          assert.deepEqual(identity(current[index]), identity(before[index]), 'Admission identity changed');
          expected[index] = current[index];
          complete = true;
          break;
        }
        assert.deepEqual(current[index], before[index], 'Admission changed during recovery');
      }
      if (complete) break;
      assert.ok(
        attempt + 1 < recovery.maxAttempts && ack?.status !== 204,
        'Uncertain admission write; recovery exhausted, inspect without replay',
      );
      const resetWait =
        ack?.rateLimitRemaining === '0' && ack.rateLimitReset
          ? Math.max(0, Number(ack.rateLimitReset) * 1000 - now())
          : 0;
      const wait = Math.max(2000 * (attempt + 1), Number(ack?.retryAfter ?? 0) * 1000, resetWait);
      assert.ok(wait <= 30000 && now() + wait < Date.parse(recovery.deadline), 'Admission retry exceeds deadline');
      await sleep(wait);
    }
    assert.ok(complete, 'Admission write not confirmed');
  }
  await checkOwnership();
  valid();
  const after = await inspectAdmission(api, limits);
  assert.deepEqual(after, expected, 'Admission changed before completion');
  const completed = `ADMISSION-${enabled ? 'ENABLED' : 'CLOSED'}.private.json`;
  if (!(await store.exists(completed))) await persist(completed, { flags: after, enabled, ownership });
  else assert.deepEqual((await store.read(completed)).flags, after);
}

export function canCloseAdmission(run, jobs) {
  assert.ok(Array.isArray(jobs));
  return (
    run.status === 'completed' ||
    jobs.some(
      (job) =>
        ['failure', 'cancelled', 'timed_out'].includes(job.conclusion) ||
        (job.name.startsWith('Staging') &&
          job.steps?.some((step) => step.name === stepName && ['in_progress', 'completed'].includes(step.status))),
    )
  );
}
