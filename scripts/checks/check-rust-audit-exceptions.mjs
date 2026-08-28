import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '../..');
const defaultExceptionsPath = resolve(rootDirectory, 'security/rust-audit-exceptions.json');
const defaultAuditConfigPath = resolve(rootDirectory, 'packages/app/src-tauri/.cargo/audit.toml');

const parseArguments = (arguments_) => {
  const exceptionsIndex = arguments_.indexOf('--exceptions');
  const configIndex = arguments_.indexOf('--audit-config');
  const reportIndex = arguments_.indexOf('--audit-report');

  return {
    exceptionsPath:
      exceptionsIndex >= 0 ? resolve(rootDirectory, arguments_[exceptionsIndex + 1]) : defaultExceptionsPath,
    auditConfigPath: configIndex >= 0 ? resolve(rootDirectory, arguments_[configIndex + 1]) : defaultAuditConfigPath,
    auditReportPath: reportIndex >= 0 ? resolve(rootDirectory, arguments_[reportIndex + 1]) : undefined,
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
  const content = readFileSync(path, 'utf8');
  const advisorySectionStart = content.match(/^\[advisories\]\s*$/m);
  if (!advisorySectionStart || advisorySectionStart.index === undefined) return [];

  const remainingContent = content.slice(advisorySectionStart.index + advisorySectionStart[0].length);
  const nextSectionIndex = remainingContent.search(/^\[[^\]]+\]\s*$/m);
  const advisorySection = nextSectionIndex >= 0 ? remainingContent.slice(0, nextSectionIndex) : remainingContent;
  const ignoreList = advisorySection.match(/^ignore\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return [...ignoreList.matchAll(/['\"]([^'\"]+)['\"]/g)].map((match) => match[1]);
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
    return { advisoryId, packageName, key: `${advisoryId}:${packageName}` };
  });
};

const { exceptionsPath, auditConfigPath, auditReportPath } = parseArguments(process.argv.slice(2));
const exceptions = loadExceptions(exceptionsPath);
const ignoredAdvisories = parseIgnoredAdvisories(auditConfigPath);
const configuredIds = new Set(ignoredAdvisories);
const documentedIds = new Set(exceptions.map((exception) => exception.advisoryId));
const problems = [];

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
