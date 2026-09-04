import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

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
