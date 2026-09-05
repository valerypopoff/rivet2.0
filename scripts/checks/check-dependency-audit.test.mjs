import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { auditRetryDelaysMs, isTransientAuditFailure, runAuditWithRetries } from './dependency-audit-retry.mjs';

const scriptPath = resolve(import.meta.dirname, 'check-dependency-audit.mjs');

function withFixtures(auditRows, exceptions, callback) {
  const directory = mkdtempSync(resolve(tmpdir(), 'rivet-dependency-audit-'));
  const inputPath = resolve(directory, 'audit.ndjson');
  const exceptionsPath = resolve(directory, 'exceptions.json');
  writeFileSync(
    inputPath,
    `${auditRows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`,
  );
  writeFileSync(exceptionsPath, JSON.stringify(exceptions));

  try {
    callback(inputPath, exceptionsPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function highFinding(id = 1) {
  return {
    value: 'fixture-package',
    children: {
      Dependents: ['fixture-dependent@npm:1.0.0'],
      ID: id,
      Issue: 'fixture advisory',
      Severity: 'high',
    },
  };
}

function exception(id = 1) {
  return {
    version: 1,
    exceptions: [
      {
        advisoryIds: [id],
        packages: ['fixture-package'],
        dependents: ['fixture-dependent@npm:1.0.0'],
        expires: '2099-01-01',
        owner: 'Test owner',
        reason: 'Fixture exception.',
        scope: 'Fixture only.',
      },
    ],
  };
}

function registryTimeout() {
  return {
    status: 1,
    stderr: '',
    stdout: "➤ YN0001: RequestError: Timeout awaiting 'socket' for 120000ms",
  };
}

function processTimeout() {
  const error = new Error('Audit child did not exit before its deadline.');
  error.code = 'ETIMEDOUT';
  return { error, status: null, stderr: '', stdout: '' };
}

test('recognizes Node child-process timeout results as retryable', () => {
  const result = spawnSync(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)'], {
    encoding: 'utf8',
    timeout: 500,
  });

  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(isTransientAuditFailure(result), true);
});

test('retries transient registry failures through the bounded backoff schedule', async () => {
  const results = [registryTimeout(), registryTimeout(), { status: 0, stderr: '', stdout: '' }];
  const delays = [];
  const warnings = [];

  const result = await runAuditWithRetries({
    run: () => results.shift(),
    wait: async (delayMs) => delays.push(delayMs),
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.status, 0);
  assert.deepEqual(delays, auditRetryDelaysMs.slice(0, 2));
  assert.deepEqual(warnings, [
    'Dependency audit attempt 1 hit a transient registry failure; retrying before attempt 2 in 10s.',
    'Dependency audit attempt 2 hit a transient registry failure; retrying before attempt 3 in 30s.',
  ]);
});

test('stops after the bounded retry schedule when the registry remains unavailable', async () => {
  const delays = [];
  let attempts = 0;

  const result = await runAuditWithRetries({
    run: () => {
      attempts += 1;
      return registryTimeout();
    },
    wait: async (delayMs) => delays.push(delayMs),
    warn: () => {},
  });

  assert.equal(result.status, 1);
  assert.equal(attempts, auditRetryDelaysMs.length + 1);
  assert.deepEqual(delays, auditRetryDelaysMs);
});

test('retries a bounded audit-child timeout but not another spawn error', async () => {
  const delays = [];
  const success = { status: 0, stderr: '', stdout: '' };
  const timeoutThenSuccess = [processTimeout(), success];

  const result = await runAuditWithRetries({
    run: () => timeoutThenSuccess.shift(),
    wait: async (delayMs) => delays.push(delayMs),
    warn: () => {},
  });

  assert.equal(result, success);
  assert.deepEqual(delays, [auditRetryDelaysMs[0]]);

  const spawnError = new Error('Permission denied.');
  spawnError.code = 'EACCES';
  await assert.rejects(
    runAuditWithRetries({
      run: () => ({ error: spawnError, status: null, stderr: '', stdout: '' }),
      wait: () => assert.fail('A non-transient spawn error must not be retried.'),
    }),
    spawnError,
  );
});

test('does not retry audit output or non-transient failures', async () => {
  const auditOutput = {
    status: 1,
    stderr: 'RequestError: Timeout awaiting socket',
    stdout: '{"children":{"Severity":"high"}}',
  };
  let attempts = 0;

  const result = await runAuditWithRetries({
    run: () => {
      attempts += 1;
      return auditOutput;
    },
    wait: () => assert.fail('An audit result must not be retried.'),
  });

  assert.equal(result, auditOutput);
  assert.equal(attempts, 1);
  assert.equal(isTransientAuditFailure(auditOutput), false);
  assert.equal(isTransientAuditFailure({ status: 1, stderr: 'lockfile is out of date', stdout: '' }), false);
});

test('accepts a current exception that matches the audit ancestry', () => {
  withFixtures([highFinding()], exception(), (inputPath, exceptionsPath) => {
    execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
  });
});

test('ignores Yarn reporter lines around otherwise valid NDJSON audit rows', () => {
  withFixtures(
    ['➤ YN0000: Done in 1s', highFinding(), '➤ YN0000: Completed'],
    exception(),
    (inputPath, exceptionsPath) => {
      execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
        encoding: 'utf8',
      });
    },
  );
});

test('rejects non-JSON lines that are not Yarn reporter output', () => {
  withFixtures(['unexpected diagnostic'], { version: 1, exceptions: [] }, (inputPath, exceptionsPath) => {
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to parse dependency audit line 1/);
  });
});

test('rejects an unused exception', () => {
  withFixtures([], exception(), (inputPath, exceptionsPath) => {
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unused dependency exceptions/);
  });
});
