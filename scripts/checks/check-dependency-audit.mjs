import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDirectory = resolve(import.meta.dirname, '../..');
const defaultExceptionsPath = resolve(rootDirectory, 'security/dependency-audit-exceptions.json');
const auditRetryDelayMs = 1_000;
const maxAuditAttempts = 2;
const isYarnReporterLine = (line) => /^\s*➤\s+YN\d{4}:\s/u.test(line);
const hasPotentialAuditJsonRows = (text) => text.split(/\r?\n/).some((line) => line.trimStart().startsWith('{'));
const isTransientAuditFailure = (result) =>
  result.status !== 0 &&
  !hasPotentialAuditJsonRows(result.stdout) &&
  /RequestError: Timeout awaiting 'socket'|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/u.test(
    `${result.stdout}\n${result.stderr}`,
  );

const waitForAuditRetry = () => new Promise((resolve) => setTimeout(resolve, auditRetryDelayMs));

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
    .filter(Boolean)
    .flatMap((line, index) => {
      if (isYarnReporterLine(line)) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(`Unable to parse dependency audit line ${index + 1}.`, { cause: error });
      }
    })
    .filter((row) => row.children?.Severity);

const runAudit = async () => {
  let result;
  for (let attempt = 1; attempt <= maxAuditAttempts; attempt += 1) {
    result = spawnSync(
      process.execPath,
      ['.yarn/releases/yarn-4.17.1.cjs', 'npm', 'audit', '--all', '--recursive', '--json'],
      {
        cwd: rootDirectory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (result.error) throw result.error;
    if (!isTransientAuditFailure(result) || attempt === maxAuditAttempts) break;

    console.warn(
      `Dependency audit attempt ${attempt} timed out while contacting the registry; retrying once in ${auditRetryDelayMs}ms.`,
    );
    await waitForAuditRetry();
  }

  if (!result.stdout.trim()) {
    throw new Error(`Dependency audit produced no report.${result.stderr ? `\n${result.stderr.trim()}` : ''}`);
  }
  if (result.status !== 0 && !hasPotentialAuditJsonRows(result.stdout)) {
    const diagnostic = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    throw new Error(
      `Dependency audit exited with status ${result.status ?? 'unknown'} before producing JSON findings.${
        diagnostic ? `\n${diagnostic}` : ''
      }`,
    );
  }

  return {
    output: result.stdout,
    status: result.status,
    stderr: result.stderr,
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
      requiredStrings.some((key) => typeof exception[key] !== 'string' || !exception[key].trim())
    ) {
      throw new Error(
        'Every dependency exception needs advisoryIds, packages, dependents, scope, reason, owner, and expires.',
      );
    }

    const expiresAt = new Date(`${exception.expires}T23:59:59.999Z`);
    if (Number.isNaN(expiresAt.getTime())) {
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

const normalizeDependent = (dependent) => dependent.replace(/@virtual:[^#]+#npm:/, '@npm:');

const unexpectedDependents = (row, exception) =>
  Array.isArray(row.children.Dependents) && row.children.Dependents.length > 0
    ? row.children.Dependents.map(normalizeDependent).filter((dependent) => !exception?.dependents.has(dependent))
    : ['<audit ancestry unavailable>'];

const formatFinding = (row) => {
  const finding = row.children;
  return `${String(finding.Severity).toUpperCase()} ${row.value} (${finding.ID}): ${finding.Issue}`;
};

const { inputPath, exceptionsPath } = parseArguments(process.argv.slice(2));
const auditResult = inputPath ? undefined : await runAudit();
const rows = parseAuditRows(inputPath ? readFileSync(inputPath, 'utf8') : auditResult.output);
if (auditResult && auditResult.status !== 0 && rows.length === 0) {
  throw new Error(
    `Dependency audit exited with status ${auditResult.status ?? 'unknown'} before producing any finding rows.${
      auditResult.stderr ? `\n${auditResult.stderr.trim()}` : ''
    }`,
  );
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
  if (severity === 'critical' || !exception || exception.expiresAt < now || unreviewedDependents.length > 0) {
    blockingFindings.push({ row, exception, unreviewedDependents });
  } else {
    usedExceptions.add(exception.key);
  }
}

const summary = [...severityCounts.entries()]
  .sort(
    ([left], [right]) =>
      ['critical', 'high', 'moderate', 'low'].indexOf(left) - ['critical', 'high', 'moderate', 'low'].indexOf(right),
  )
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
    for (const { row, exception, unreviewedDependents } of blockingFindings) {
      const expired = exception?.expiresAt < now ? ` Exception expired ${exception.expires}.` : '';
      const ancestry =
        unreviewedDependents.length > 0 ? ` Unreviewed dependent(s): ${unreviewedDependents.join(', ')}.` : '';
      const suffix = `${expired}${ancestry}`;
      console.error(`- ${formatFinding(row)}${suffix}`);
    }
  }
  process.exitCode = 1;
}
