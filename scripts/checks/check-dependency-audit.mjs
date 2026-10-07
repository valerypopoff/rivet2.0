import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertAuditProcessCompleted,
  hasPotentialAuditJsonRows,
  runAuditWithRetries,
} from './dependency-audit-retry.mjs';
import { normalizeAuditLocator, workspaceOwnersForDependent } from './dependency-audit-scope.mjs';

const rootDirectory = resolve(import.meta.dirname, '../..');
const defaultExceptionsPath = resolve(rootDirectory, 'security/dependency-audit-exceptions.json');
const auditProcessTimeoutMs = 180_000;
const isYarnReporterLine = (line) => /^\s*➤\s+YN\d{4}:\s/u.test(line);
const auditSeverities = ['critical', 'high', 'moderate', 'low', 'info'];

const parseArguments = (arguments_) => {
  const inputIndex = arguments_.indexOf('--input');
  const exceptionsIndex = arguments_.indexOf('--exceptions');

  return {
    inputPath: inputIndex >= 0 ? resolve(rootDirectory, arguments_[inputIndex + 1]) : undefined,
    exceptionsPath:
      exceptionsIndex >= 0 ? resolve(rootDirectory, arguments_[exceptionsIndex + 1]) : defaultExceptionsPath,
  };
};

const parseAuditRows = (text) =>
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      if (isYarnReporterLine(line)) {
        if (/^\s*➤\s+YN0000:\s/u.test(line) || /^\s*➤\s+YN0001:\s+No audit suggestions\s*$/u.test(line)) return [];
        throw new Error(`Dependency audit diagnostic at line ${index + 1}: ${line.trim()}`);
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`Unable to parse dependency audit line ${index + 1}.`, { cause: error });
      }
      // Yarn uses an info record (with code YN0001) when the report is empty.
      // Unknown JSON or error records must not silently disappear from a partial report.
      if (row?.type === 'info' && row.name === 1 && row.data === 'No audit suggestions') return [];
      if (
        typeof row?.value !== 'string' ||
        !row.value.trim() ||
        !auditSeverities.includes(row.children?.Severity) ||
        !/^\d+$/.test(String(row.children?.ID)) ||
        typeof row.children?.Issue !== 'string'
      )
        throw new Error(`Invalid dependency audit finding at line ${index + 1}.`);
      return [row];
    });

const runAudit = async () => {
  const result = await runAuditWithRetries({
    run: () =>
      spawnSync(
        process.execPath,
        ['.yarn/releases/yarn-4.17.1.cjs', 'npm', 'audit', '--all', '--recursive', '--json', '--no-deprecations'],
        {
          cwd: rootDirectory,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: auditProcessTimeoutMs,
          // The audit excludes non-security deprecation annotations, so this
          // security-only bulk request does not fan out into metadata requests
          // for every package in the dependency graph.
          env: {
            ...process.env,
            // Keep audit advisories in stdout; suppress Node warning noise so
            // stderr remains a fail-closed channel for an interrupted report.
            NODE_NO_WARNINGS: '1',
            YARN_HTTP_TIMEOUT: process.env.YARN_HTTP_TIMEOUT ?? '120000',
            YARN_NPM_REGISTRY_SERVER: process.env.YARN_NPM_REGISTRY_SERVER ?? 'https://registry.npmjs.org',
          },
        },
      ),
  });

  assertAuditProcessCompleted(result);

  const stdout = result.stdout ?? '';
  if (!stdout.trim()) {
    throw new Error('Dependency audit produced no report.');
  }
  if (result.status !== 0 && !hasPotentialAuditJsonRows(stdout)) {
    throw new Error(
      `Dependency audit exited with status ${result.status} before producing JSON findings.\n${stdout.trim()}`,
    );
  }

  return {
    output: stdout,
    status: result.status,
  };
};

const loadExceptions = (path) => {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (document.version !== 1 || !Array.isArray(document.exceptions)) {
    throw new Error('Dependency audit exceptions must use version 1 and contain an exceptions array.');
  }

  const seenKeys = new Set();
  return document.exceptions.flatMap((exception) => {
    const requiredStrings = ['scope', 'reason', 'owner', 'expires'];
    const hasNonEmptyStrings = (values) =>
      Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === 'string' && value.trim());
    if (
      !Array.isArray(exception.advisoryIds) ||
      exception.advisoryIds.length === 0 ||
      !hasNonEmptyStrings(exception.packages) ||
      !hasNonEmptyStrings(exception.dependents) ||
      (exception.workspaceOwners !== undefined &&
        (!hasNonEmptyStrings(exception.workspaceOwners) ||
          exception.workspaceOwners.some((owner) => !owner.includes('@workspace:')))) ||
      requiredStrings.some((key) => typeof exception[key] !== 'string' || !exception[key].trim())
    ) {
      throw new Error(
        'Every dependency exception needs advisoryIds, packages, dependents, scope, reason, owner, and expires.',
      );
    }

    const expiresAt = new Date(`${exception.expires}T23:59:59.999Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.toISOString().slice(0, 10) !== exception.expires
    ) {
      throw new Error(`Invalid dependency exception expiry date: ${exception.expires}`);
    }

    return exception.advisoryIds.flatMap((advisoryId) =>
      exception.packages.map((packageName) => {
        const key = `${String(advisoryId)}:${packageName}`;
        if (seenKeys.has(key)) throw new Error(`Duplicate dependency exception: ${key}`);
        seenKeys.add(key);
        return {
          ...exception,
          advisoryId: String(advisoryId),
          packageName,
          dependents: new Set(exception.dependents.map((dependent) => dependent.trim())),
          expiresAt,
          key,
        };
      }),
    );
  });
};

const unexpectedDependents = (row, exception) =>
  Array.isArray(row.children.Dependents) && row.children.Dependents.length > 0
    ? row.children.Dependents.map(normalizeAuditLocator).filter((dependent) => !exception?.dependents.has(dependent))
    : ['<audit ancestry unavailable>'];

const ancestryReports = new Map();
function unexpectedWorkspaceOwners(exception) {
  if (!exception?.workspaceOwners) return [];
  const unreviewed = new Set();
  for (const dependent of exception.dependents) {
    const name = dependent.split('@npm:')[0];
    if (!ancestryReports.has(name)) {
      const result = spawnSync(process.execPath, ['.yarn/releases/yarn-4.17.1.cjs', 'why', '-R', name, '--json'], {
        cwd: rootDirectory,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      });
      if (result.error || result.status !== 0)
        throw new Error(`Unable to verify workspace ancestry for ${name}.`, { cause: result.error });
      ancestryReports.set(
        name,
        result.stdout
          .split(/\r?\n/)
          .filter((line) => line.trim() && !isYarnReporterLine(line))
          .map(JSON.parse),
      );
    }
    const owners = workspaceOwnersForDependent(ancestryReports.get(name), dependent);
    if (!owners.length) throw new Error(`No workspace ancestry found for ${dependent}.`);
    for (const owner of owners) if (!exception.workspaceOwners.includes(owner)) unreviewed.add(owner);
  }
  return [...unreviewed].sort();
}

const formatFinding = (row) => {
  const finding = row.children;
  return `${String(finding.Severity).toUpperCase()} ${row.value} (${finding.ID}): ${finding.Issue}`;
};

const { inputPath, exceptionsPath } = parseArguments(process.argv.slice(2));
const auditResult = inputPath ? undefined : await runAudit();
const rows = parseAuditRows(inputPath ? readFileSync(inputPath, 'utf8') : auditResult.output);
if (auditResult && auditResult.status !== 0 && rows.length === 0) {
  throw new Error(`Dependency audit exited with status ${auditResult.status} before producing any finding rows.`);
}
const exceptions = loadExceptions(exceptionsPath);
const now = new Date();
const usedExceptions = new Set();
const blockingFindings = [];
const severityCounts = new Map();

for (const row of rows) {
  const severity = String(row.children.Severity).toLowerCase();
  severityCounts.set(severity, (severityCounts.get(severity) ?? 0) + 1);
  if (severity !== 'high' && severity !== 'critical') continue;

  const key = `${String(row.children.ID)}:${row.value}`;
  const exception = exceptions.find((candidate) => candidate.key === key);
  const unreviewedDependents = unexpectedDependents(row, exception);
  const unreviewedWorkspaces = unexpectedWorkspaceOwners(exception);
  if (
    severity === 'critical' ||
    !exception ||
    exception.expiresAt < now ||
    unreviewedDependents.length > 0 ||
    unreviewedWorkspaces.length > 0
  ) {
    blockingFindings.push({ row, exception, unreviewedDependents, unreviewedWorkspaces });
  } else {
    usedExceptions.add(exception.key);
  }
}

const summary = [...severityCounts.entries()]
  .sort(([left], [right]) => auditSeverities.indexOf(left) - auditSeverities.indexOf(right))
  .map(([severity, count]) => `${severity}: ${count}`)
  .join(', ');
console.log(`Dependency audit summary: ${summary || 'no findings'}.`);

if (usedExceptions.size > 0) {
  console.log(`Accepted ${usedExceptions.size} high-severity finding(s) through current, documented exceptions.`);
}

const unusedExceptions = [];
for (const exception of exceptions) {
  if (!usedExceptions.has(exception.key)) {
    unusedExceptions.push(exception);
  }
}

if (blockingFindings.length > 0 || unusedExceptions.length > 0) {
  if (unusedExceptions.length > 0) {
    console.error('\nUnused dependency exceptions:');
    for (const exception of unusedExceptions) {
      console.error(`- ${exception.key} (expires ${exception.expires})`);
    }
  }

  if (blockingFindings.length > 0) {
    console.error('\nBlocking dependency findings:');
    for (const { row, exception, unreviewedDependents, unreviewedWorkspaces } of blockingFindings) {
      const expired = exception?.expiresAt < now ? ` Exception expired ${exception.expires}.` : '';
      const ancestry =
        unreviewedDependents.length > 0 ? ` Unreviewed dependent(s): ${unreviewedDependents.join(', ')}.` : '';
      const workspaces = unreviewedWorkspaces.length
        ? ` Unreviewed workspace owner(s): ${unreviewedWorkspaces.join(', ')}.`
        : '';
      const suffix = `${expired}${ancestry}${workspaces}`;
      console.error(`- ${formatFinding(row)}${suffix}`);
    }
  }
  process.exitCode = 1;
}
