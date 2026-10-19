import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const scriptPath = resolve(import.meta.dirname, 'check-rust-audit-exceptions.mjs');

function withFixtures(exceptions, auditConfig, auditReport, callback, lockfile = '') {
  const directory = mkdtempSync(resolve(tmpdir(), 'rivet-rust-audit-'));
  const exceptionsPath = resolve(directory, 'exceptions.json');
  const auditConfigPath = resolve(directory, 'audit.toml');
  const auditReportPath = resolve(directory, 'audit.json');
  const lockfilePath = resolve(directory, 'Cargo.lock');
  writeFileSync(exceptionsPath, JSON.stringify(exceptions));
  writeFileSync(auditConfigPath, auditConfig);
  writeFileSync(auditReportPath, JSON.stringify(auditReport));
  writeFileSync(lockfilePath, lockfile);

  try {
    callback(exceptionsPath, auditConfigPath, auditReportPath, lockfilePath);
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

test('ignores quoted advisory IDs and apostrophes inside TOML comments', () => {
  withFixtures(
    exception(),
    `[advisories]
ignore = [
  # Tauri's dependency is reviewed; "RUSTSEC-2099-9999" is only a comment.
  'RUSTSEC-2099-0001', # "RUSTSEC-2099-9998"
]
`,
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
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

function reviewedZipLockfile({ zipVersion = '0.6.6', tauriVersion = '1.8.3', extra = '' } = {}) {
  return `version = 3

[[package]]
name = "zip"
version = "${zipVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "760394e246e4c28189f19d488c058bf16f564016aefac5d32bb1f3b51d5e9261"

[[package]]
name = "tauri"
version = "${tauriVersion}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "3ae1f57c291a6ab8e1d2e6b8ad0a35ff769c9925deb8a89de85425ff08762d0c"
dependencies = [
 "zip",
]
${extra}`;
}

for (const scenario of [
  { name: 'accepts only the reviewed ZIP identities and consumer', lockfile: reviewedZipLockfile(), status: 0 },
  { name: 'accepts generated CRLF lockfiles', lockfile: reviewedZipLockfile().replaceAll('\n', '\r\n'), status: 0 },
  { name: 'rejects a changed ZIP version', lockfile: reviewedZipLockfile({ zipVersion: '0.6.7' }), status: 1 },
  { name: 'rejects a changed Tauri version', lockfile: reviewedZipLockfile({ tauriVersion: '1.8.4' }), status: 1 },
  { name: 'rejects a changed checksum', lockfile: reviewedZipLockfile().replace('760394e2', '00000000'), status: 1 },
  {
    name: 'rejects a changed consumer checksum',
    lockfile: reviewedZipLockfile().replace('3ae1f57c', '00000000'),
    status: 1,
  },
  { name: 'rejects a non-registry source', lockfile: reviewedZipLockfile().replaceAll('registry+', 'git+'), status: 1 },
  { name: 'rejects an absent ZIP dependency', lockfile: '', status: 1 },
  {
    name: 'rejects a new direct or transitive ZIP consumer',
    lockfile: reviewedZipLockfile({
      extra: '\n[[package]]\nname = "other"\nversion = "1.0.0"\ndependencies = [\n "zip 0.6.6",\n]\n',
    }),
    status: 1,
  },
  {
    name: 'rejects another ZIP version alongside the reviewed one',
    lockfile: reviewedZipLockfile({ extra: '\n[[package]]\nname = "zip"\nversion = "9.0.0"\n' }),
    status: 1,
  },
  {
    name: 'rejects an audit finding for a different ZIP version',
    lockfile: reviewedZipLockfile(),
    reportVersion: '8.0.0',
    status: 1,
  },
  {
    name: 'rejects an audit finding with a missing ZIP version',
    lockfile: reviewedZipLockfile(),
    reportVersion: null,
    status: 1,
  },
]) {
  test(scenario.name, () => {
    const policy = exception();
    policy.exceptions[0].packages = ['zip'];
    const report = auditReport('RUSTSEC-2099-0001', 'zip');
    report.vulnerabilities.list[0].package.version =
      scenario.reportVersion === undefined ? '0.6.6' : scenario.reportVersion;
    withFixtures(
      policy,
      '[advisories]\nignore = ["RUSTSEC-2099-0001"]\n',
      report,
      (exceptionsPath, auditConfigPath, auditReportPath, lockfilePath) => {
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
            '--lockfile',
            lockfilePath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, scenario.status, result.stderr);
        if (scenario.status !== 0) assert.match(result.stderr, /reviewed (ZIP scope|zip 0\.6\.6)/);
      },
      scenario.lockfile,
    );
  });
}

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

test('rejects an expired exception even when its finding still matches', () => {
  withFixtures(
    exception('RUSTSEC-2099-0001', '2000-01-01'),
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
      assert.match(result.stderr, /expired on 2000-01-01/);
    },
  );
});

test('rejects a new advisory alongside an otherwise valid reviewed finding', () => {
  const report = auditReport();
  report.vulnerabilities.list.push(...auditReport('RUSTSEC-2099-0002').vulnerabilities.list);
  withFixtures(
    exception(),
    '[advisories]\nignore = ["RUSTSEC-2099-0001"]\n',
    report,
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
      assert.match(result.stderr, /RUSTSEC-2099-0002:fixture-package is an unreviewed Rust vulnerability/);
    },
  );
});
