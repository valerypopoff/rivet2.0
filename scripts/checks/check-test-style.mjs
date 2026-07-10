import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceReadingTestAllowlist } from './source-reading-test-allowlist.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const testFilePattern = /\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
const focusedTestPattern = /\b(?:context|describe|it|suite|test)\.only\b/;
const skippedTestPattern = /\b(?:context|describe|it|suite|test)\.skip\b/;
const sourceReadPattern = /\breadFile(?:Sync)?\s*\(/;

function getCandidateTestFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((file) => testFilePattern.test(file.replaceAll('\\', '/')));
}

const focusedTests = [];
const skippedTests = [];
const sourceReadingTests = [];

for (const file of getCandidateTestFiles()) {
  const absolutePath = join(repoRoot, file);
  if (!existsSync(absolutePath)) {
    continue;
  }

  const source = readFileSync(absolutePath, 'utf8');
  const normalizedFile = file.replaceAll('\\', '/');

  if (focusedTestPattern.test(source)) {
    focusedTests.push(normalizedFile);
  }

  if (sourceReadPattern.test(source)) {
    sourceReadingTests.push(normalizedFile);
  }

  if (skippedTestPattern.test(source)) {
    skippedTests.push(normalizedFile);
  }
}

if (focusedTests.length > 0) {
  console.error('Focused tests are not allowed. Remove .only from:');
  for (const file of focusedTests) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log('No committed focused tests found.');
}

const newSourceReadingTests = sourceReadingTests.filter((file) => !sourceReadingTestAllowlist.has(file));
const staleSourceReadingAllowlist = [...sourceReadingTestAllowlist].filter(
  (file) => !sourceReadingTests.includes(file),
);

if (newSourceReadingTests.length > 0) {
  console.error('New source-reading tests are not allowed:');
  for (const file of newSourceReadingTests) console.error(`- ${file}`);
  process.exitCode = 1;
}
if (staleSourceReadingAllowlist.length > 0) {
  console.error('Remove migrated or deleted tests from the source-reading allowlist:');
  for (const file of staleSourceReadingAllowlist) console.error(`- ${file}`);
  process.exitCode = 1;
}

if (sourceReadingTests.length > 0) {
  console.log(`Reviewed source-reading migration queue (${sourceReadingTests.length}, new entries fail):`);
  for (const file of sourceReadingTests) {
    console.log(`- ${file}`);
  }
} else {
  console.log('No source-reading tests found.');
}

if (skippedTests.length > 0) {
  console.log(`Skipped test files (${skippedTests.length}, report only):`);
  for (const file of skippedTests) {
    console.log(`- ${file}`);
  }
} else {
  console.log('No skipped tests found.');
}
