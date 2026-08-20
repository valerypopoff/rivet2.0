import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const scriptPath = resolve(import.meta.dirname, 'check-rust-audit-exceptions.mjs');

function withFixtures(exceptions, auditConfig, auditReport, callback) {
  const directory = mkdtempSync(resolve(tmpdir(), 'rivet-rust-audit-'));
  const exceptionsPath = resolve(directory, 'exceptions.json');
  const auditConfigPath = resolve(directory, 'audit.toml');
  const auditReportPath = resolve(directory, 'audit.json');
  writeFileSync(exceptionsPath, JSON.stringify(exceptions));
  writeFileSync(auditConfigPath, auditConfig);
  writeFileSync(auditReportPath, JSON.stringify(auditReport));

  try {
    callback(exceptionsPath, auditConfigPath, auditReportPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function exception(id = 'RUSTSEC-2099-0001', expires = '2099-01-01') {
  return {
    version: 1,
    exceptions: [
      {
        advisoryId: id,
        packages: ['fixture-package'],
        expires,
        owner: 'Test owner',
        reason: 'Fixture exception.',
        scope: 'Fixture only.',
      },
    ],
  };
}

function auditReport(id = 'RUSTSEC-2099-0001', packageName = 'fixture-package') {
  return {
    vulnerabilities: {
      list: [
        {
          advisory: { id },
          package: { name: packageName },
        },
      ],
    },
  };
}

test('accepts a current exception that matches audit.toml', () => {
  withFixtures(
    exception(),
    '[advisories]\nignore = ["RUSTSEC-2099-0001"]\n',
    auditReport(),
    (exceptionsPath, auditConfigPath, auditReportPath) => {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--exceptions',
          exceptionsPath,
          '--audit-config',
          auditConfigPath,
          '--audit-report',
          auditReportPath,
        ],
        { encoding: 'utf8' },
      );
    },
  );
});

test('rejects an ignored advisory without a documented exception', () => {
  withFixtures(
    exception(),
    '[advisories]\nignore = ["RUSTSEC-2099-9999"]\n',
    auditReport(),
    (exceptionsPath, auditConfigPath, auditReportPath) => {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          '--exceptions',
          exceptionsPath,
          '--audit-config',
          auditConfigPath,
          '--audit-report',
          auditReportPath,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /without a documented exception/);
    },
  );
});

test('rejects a Rust exception that no longer appears in the unfiltered audit', () => {
  withFixtures(
    exception(),
    '[advisories]\nignore = ["RUSTSEC-2099-0001"]\n',
    { vulnerabilities: { list: [] } },
    (exceptionsPath, auditConfigPath, auditReportPath) => {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          '--exceptions',
          exceptionsPath,
          '--audit-config',
          auditConfigPath,
          '--audit-report',
          auditReportPath,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale Rust audit exception/);
    },
  );
});

test('rejects an impossible exception expiry date', () => {
  withFixtures(
    exception('RUSTSEC-2099-0001', '2099-02-30'),
    '[advisories]\nignore = ["RUSTSEC-2099-0001"]\n',
    auditReport(),
    (exceptionsPath, auditConfigPath, auditReportPath) => {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          '--exceptions',
          exceptionsPath,
          '--audit-config',
          auditConfigPath,
          '--audit-report',
          auditReportPath,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid Rust audit exception expiry date/);
    },
  );
});
