import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '../..');
const defaultExceptionsPath = resolve(rootDirectory, 'security/rust-audit-exceptions.json');
const defaultAuditConfigPath = resolve(rootDirectory, 'packages/app/src-tauri/.cargo/audit.toml');
const defaultLockfilePath = resolve(rootDirectory, 'packages/app/src-tauri/Cargo.lock');

const parseArguments = (arguments_) => {
  const exceptionsIndex = arguments_.indexOf('--exceptions');
  const configIndex = arguments_.indexOf('--audit-config');
  const reportIndex = arguments_.indexOf('--audit-report');
  const lockfileIndex = arguments_.indexOf('--lockfile');

  return {
    exceptionsPath:
      exceptionsIndex >= 0 ? resolve(rootDirectory, arguments_[exceptionsIndex + 1]) : defaultExceptionsPath,
    auditConfigPath: configIndex >= 0 ? resolve(rootDirectory, arguments_[configIndex + 1]) : defaultAuditConfigPath,
    auditReportPath: reportIndex >= 0 ? resolve(rootDirectory, arguments_[reportIndex + 1]) : undefined,
    lockfilePath: lockfileIndex >= 0 ? resolve(rootDirectory, arguments_[lockfileIndex + 1]) : defaultLockfilePath,
  };
};

const loadExceptions = (path) => {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (document.version !== 1 || !Array.isArray(document.exceptions)) {
    throw new Error('Rust audit exceptions must use version 1 and contain an exceptions array.');
  }

  const seenIds = new Set();
  return document.exceptions.map((exception) => {
    const requiredStrings = ['advisoryId', 'scope', 'reason', 'owner', 'expires'];
    const validPackages =
      Array.isArray(exception.packages) &&
      exception.packages.length > 0 &&
      exception.packages.every((packageName) => typeof packageName === 'string' && packageName.trim());
    if (requiredStrings.some((key) => typeof exception[key] !== 'string' || !exception[key].trim()) || !validPackages) {
      throw new Error('Every Rust audit exception needs advisoryId, packages, scope, reason, owner, and expires.');
    }
    if (!/^RUSTSEC-\d{4}-\d{4}$/.test(exception.advisoryId)) {
      throw new Error(`Invalid RustSec advisory ID: ${exception.advisoryId}`);
    }
    if (seenIds.has(exception.advisoryId)) {
      throw new Error(`Duplicate Rust audit exception: ${exception.advisoryId}`);
    }
    seenIds.add(exception.advisoryId);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) {
      throw new Error(`Invalid Rust audit exception expiry date: ${exception.expires}`);
    }
    const expiresAt = new Date(`${exception.expires}T23:59:59.999Z`);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 10) !== exception.expires) {
      throw new Error(`Invalid Rust audit exception expiry date: ${exception.expires}`);
    }

    return { ...exception, expiresAt };
  });
};

const parseIgnoredAdvisories = (path) => {
  // Advisory IDs contain no '#'; comments may contain quotes or apostrophes.
  const content = readFileSync(path, 'utf8').replace(/#.*$/gm, '');
  const advisorySectionStart = content.match(/^\[advisories\]\s*$/m);
  if (!advisorySectionStart || advisorySectionStart.index === undefined) return [];

  const remainingContent = content.slice(advisorySectionStart.index + advisorySectionStart[0].length);
  const nextSectionIndex = remainingContent.search(/^\[[^\]]+\]\s*$/m);
  const advisorySection = nextSectionIndex >= 0 ? remainingContent.slice(0, nextSectionIndex) : remainingContent;
  const ignoreList = advisorySection.match(/^ignore\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return [...ignoreList.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
};

const parseAuditReport = (path) => {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(document?.vulnerabilities?.list)) {
    throw new Error('Rust audit report must contain vulnerabilities.list.');
  }

  return document.vulnerabilities.list.map((finding) => {
    const advisoryId = finding?.advisory?.id;
    const packageName = finding?.package?.name;
    if (typeof advisoryId !== 'string' || typeof packageName !== 'string') {
      throw new Error('Rust audit report contains a vulnerability without an advisory ID or package name.');
    }
    return { advisoryId, packageName, packageVersion: finding.package.version, key: `${advisoryId}:${packageName}` };
  });
};

// This review is for Tauri's signed Windows updater, not arbitrary ZIP consumers.
// Parse only Cargo's generated package records; a changed identity/graph requires
// a fresh reachability review even when cargo-audit reports the same advisory ID.
const zipReview = {
  zip: {
    version: '0.6.6',
    checksum: '760394e246e4c28189f19d488c058bf16f564016aefac5d32bb1f3b51d5e9261',
  },
  tauri: {
    version: '1.8.3',
    checksum: '3ae1f57c291a6ab8e1d2e6b8ad0a35ff769c9925deb8a89de85425ff08762d0c',
  },
};
const checkZipDependencyScope = (path) => {
  const packages = readFileSync(path, 'utf8')
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((record) => {
      const field = (name) => record.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1];
      return {
        name: field('name'),
        version: field('version'),
        checksum: field('checksum'),
        source: field('source'),
        dependencies: record.match(/^dependencies = \[([\s\S]*?)\]/m)?.[1] ?? '',
      };
    });
  const matchesReview = (name, matches) =>
    matches.length === 1 &&
    matches[0].name === name &&
    matches[0].source === 'registry+https://github.com/rust-lang/crates.io-index' &&
    matches[0].version === zipReview[name].version &&
    matches[0].checksum === zipReview[name].checksum;
  const zipPackages = packages.filter((entry) => entry.name === 'zip');
  const consumers = packages.filter((entry) => /"zip(?: [^"]+)?"/.test(entry.dependencies));
  return matchesReview('zip', zipPackages) && matchesReview('tauri', consumers);
};

const { exceptionsPath, auditConfigPath, auditReportPath, lockfilePath } = parseArguments(process.argv.slice(2));
const exceptions = loadExceptions(exceptionsPath);
const ignoredAdvisories = parseIgnoredAdvisories(auditConfigPath);
const configuredIds = new Set(ignoredAdvisories);
const documentedIds = new Set(exceptions.map((exception) => exception.advisoryId));
const problems = [];

if (exceptions.some((exception) => exception.packages.includes('zip')) && !checkZipDependencyScope(lockfilePath)) {
  problems.push(
    'ZIP exceptions require the reviewed zip 0.6.6 with Tauri 1.8.3 as its only consumer; re-review changed versions, checksums or consumers.',
  );
}

if (configuredIds.size !== ignoredAdvisories.length) {
  problems.push(`${auditConfigPath} declares a RustSec advisory ignore more than once.`);
}

for (const exception of exceptions) {
  if (exception.expiresAt < new Date()) {
    problems.push(`${exception.advisoryId} expired on ${exception.expires}.`);
  }
  if (!configuredIds.has(exception.advisoryId)) {
    problems.push(`${exception.advisoryId} is documented but missing from ${auditConfigPath}.`);
  }
}

for (const advisoryId of configuredIds) {
  if (!documentedIds.has(advisoryId)) {
    problems.push(`${advisoryId} is ignored by ${auditConfigPath} without a documented exception.`);
  }
}

if (auditReportPath) {
  const findings = parseAuditReport(auditReportPath);
  const documentedFindings = new Set(
    exceptions.flatMap((exception) =>
      exception.packages.map((packageName) => `${exception.advisoryId}:${packageName}`),
    ),
  );
  const reportedFindings = new Set(findings.map((finding) => finding.key));

  for (const finding of findings) {
    if (!documentedFindings.has(finding.key)) {
      problems.push(`${finding.key} is an unreviewed Rust vulnerability.`);
    }
    if (
      finding.packageName === 'zip' &&
      documentedFindings.has(finding.key) &&
      finding.packageVersion !== zipReview.zip.version
    ) {
      problems.push(
        `${finding.key} version ${finding.packageVersion ?? '(missing)'} is outside the reviewed ZIP scope.`,
      );
    }
  }

  for (const exceptionKey of documentedFindings) {
    if (!reportedFindings.has(exceptionKey)) {
      problems.push(`${exceptionKey} is a stale Rust audit exception.`);
    }
  }
}

if (problems.length > 0) {
  console.error('Rust audit exception policy failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  const currentQualifier = auditReportPath ? ' and current' : '';
  console.log(
    `Rust audit exception policy is valid${currentQualifier} (${exceptions.length} temporary ignore${exceptions.length === 1 ? '' : 's'}).`,
  );
}
