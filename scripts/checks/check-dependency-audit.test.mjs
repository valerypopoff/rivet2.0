import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertAuditProcessCompleted,
  auditRetryDelaysMs,
  isTransientAuditFailure,
  runAuditWithRetries,
} from './dependency-audit-retry.mjs';
import { workspaceOwnersForDependent } from './dependency-audit-scope.mjs';

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

test('interrupted or abnormal audit processes cannot certify partial JSON output', () => {
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 2 }, { status: null }])
    assert.throws(
      () => assertAuditProcessCompleted({ ...result, stdout: JSON.stringify(highFinding()) }),
      /did not complete/,
    );
  assert.doesNotThrow(() => assertAuditProcessCompleted({ status: 0 }));
  assert.doesNotThrow(() => assertAuditProcessCompleted({ status: 1 }));
  assert.throws(
    () =>
      assertAuditProcessCompleted({
        status: 1,
        stdout: JSON.stringify(highFinding()),
        stderr: 'Error: incomplete report',
      }),
    /unexpected stderr/,
  );
});

for (const report of [
  { type: 'info', name: 1, displayName: 'YN0001', data: 'No audit suggestions' },
  '➤ YN0001: No audit suggestions',
]) {
  test(`accepts Yarn's no-findings response: ${JSON.stringify(report)}`, () => {
    withFixtures([report], { version: 1, exceptions: [] }, (inputPath, exceptionsPath) => {
      execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath]);
    });
  });
}

test('accepts a real leap-day expiry without altering it', () => {
  const document = exception();
  document.exceptions[0].expires = '2096-02-29';
  withFixtures([highFinding()], document, (inputPath, exceptionsPath) => {
    execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath]);
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

test('audit parse diagnostics preserve source line numbers across blank lines and CRLF', () => {
  withFixtures(['\uFEFF\r', 'unexpected diagnostic'], { version: 1, exceptions: [] }, (inputPath, exceptionsPath) => {
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to parse dependency audit line 2/);
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

for (const diagnostic of [
  { value: 'unexpected-package', children: { Severity: 'unknown', ID: 2, Issue: 'unrecognized severity' } },
  { error: 'registry report could not be completed' },
  { type: 'error', name: 1, data: 'registry report could not be completed' },
  '➤ YN0001: registry report could not be completed',
]) {
  test(`a partial accepted report cannot hide ${JSON.stringify(diagnostic)}`, () => {
    withFixtures([highFinding(), diagnostic], exception(), (inputPath, exceptionsPath) => {
      const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /Accepted/);
    });
  });
}

test('rejects expiry dates that JavaScript would silently roll into the following month', () => {
  const document = exception();
  document.exceptions[0].expires = '2099-02-30';
  withFixtures([highFinding()], document, (inputPath, exceptionsPath) => {
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid dependency exception expiry date/);
  });
});

const ancestryNode = (value, children = {}) => ({ value, children });

test('finds new workspace owners through Yarn deduplicated virtual dependency references', () => {
  const got = 'got@virtual:fixture#npm:12.6.1';
  const dependent = 'cacheable-request@npm:10.2.14';
  const docs = ancestryNode('docs@workspace:packages/docs', {
    got: ancestryNode(got, { cache: ancestryNode({ locator: dependent }) }),
  });
  const api = ancestryNode('api@workspace:packages/api', { got: ancestryNode(got) });
  assert.deepEqual(workspaceOwnersForDependent([docs, api, docs], dependent), [
    'api@workspace:packages/api',
    'docs@workspace:packages/docs',
  ]);
});

test('workspace ancestry checks exact versions and terminates on dependency cycles', () => {
  const root = 'docs@workspace:packages/docs';
  const rows = [ancestryNode(root, { watcher: ancestryNode('chokidar@npm:4.0.0', { cycle: ancestryNode(root) }) })];
  assert.deepEqual(workspaceOwnersForDependent(rows, 'chokidar@npm:3.5.3'), []);
  assert.deepEqual(workspaceOwnersForDependent(rows, 'chokidar@npm:4.0.0'), [root]);
});

test('invalid or non-workspace ancestry fails closed', () => {
  assert.throws(() => workspaceOwnersForDependent([null], 'fixture@npm:1.0.0'), /Invalid dependency ancestry/);
  assert.throws(
    () => workspaceOwnersForDependent([ancestryNode('fixture@npm:1.0.0')], 'fixture@npm:1.0.0'),
    /root is not a workspace/,
  );
});

test('audit CLI blocks an unreviewed workspace even when the immediate dependent is accepted', () => {
  const finding = highFinding();
  finding.children.Dependents = ['cacheable-request@npm:10.2.14'];
  const document = exception();
  document.exceptions[0].dependents = finding.children.Dependents;
  document.exceptions[0].workspaceOwners = ['unrelated@workspace:packages/unrelated'];
  withFixtures([finding], document, (inputPath, exceptionsPath) => {
    const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unreviewed workspace owner\(s\): docs@workspace:packages\/docs/);
  });
});

for (const boundary of ['critical', 'expired', 'new dependent']) {
  test(`exceptions cannot waive ${boundary} findings`, () => {
    const finding = highFinding();
    const document = exception();
    if (boundary === 'critical') finding.children.Severity = 'critical';
    if (boundary === 'expired') document.exceptions[0].expires = '2000-01-01';
    if (boundary === 'new dependent') finding.children.Dependents.push('another-dependent@npm:1.0.0');
    withFixtures([finding], document, (inputPath, exceptionsPath) => {
      const result = spawnSync(process.execPath, [scriptPath, '--input', inputPath, '--exceptions', exceptionsPath], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Blocking dependency findings/);
      assert.doesNotMatch(result.stdout, /Accepted/);
    });
  });
}
