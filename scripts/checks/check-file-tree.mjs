import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  edgeKey,
  findImportEdges,
  findRuntimeDependencyPath,
  isLongRelativeImport,
  isPackageDeepImport,
  reviewImportDebt,
} from './import-boundaries.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const sourceFilePattern = /\.(?:mts|ts|tsx)$/;
const generatedPathPatterns = [
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)tsconfig\.tsbuildinfo$/,
  /^build\//,
  /^\.rivet-built-packages\//,
  /^\.local-node\//,
  /^\.node-runtime\//,
  /^packages\/app\/stats\.html$/,
  /^packages\/app\/tmp-icon-test\//,
  /^tmp-macos-signing-test\//,
  /^tmp-rivet-icon-test\//,
];
// Existing debt is explicit per source/specifier. No count-based grandfathering.
const importDebt = JSON.parse(readFileSync(new URL('./import-boundary-debt.json', import.meta.url), 'utf8'));

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function listGit(args) {
  const output = git(args);
  return output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
}

function countBy(items, getKey) {
  const counts = new Map();

  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printCounts(title, counts) {
  console.log(title);

  for (const [name, count] of counts) {
    console.log(`  ${String(count).padStart(5, ' ')} ${name}`);
  }
}

function findImportBoundaryReports(files) {
  const reports = [];

  for (const file of files) {
    if (!file.startsWith('packages/') || !sourceFilePattern.test(file)) {
      continue;
    }

    const absolutePath = join(repoRoot, file);
    if (!existsSync(absolutePath)) {
      continue;
    }

    reports.push(...findImportEdges(file, readFileSync(absolutePath, 'utf8')));
  }

  return reports;
}

const repoFiles = listGit(['ls-files', '--cached', '--others', '--exclude-standard']).filter((file) =>
  existsSync(join(repoRoot, file)),
);
const topLevelCounts = countBy(repoFiles, (file) => file.split('/')[0]);
const packageCounts = countBy(
  repoFiles.filter((file) => file.startsWith('packages/')),
  (file) => file.split('/')[1] ?? '<root>',
);

printCounts('Repository files by top-level area:', topLevelCounts);
console.log('');
printCounts('Repository files by workspace:', packageCounts);
console.log('');

const generatedFiles = repoFiles.filter((file) =>
  generatedPathPatterns.some((pattern) => pattern.test(file.replaceAll('\\', '/'))),
);

if (generatedFiles.length > 0) {
  console.error('Generated/local files are unignored and need review:');
  for (const file of generatedFiles) {
    console.error(`  - ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log('No unignored generated/local output paths found.');
}

const importBoundaryReports = findImportBoundaryReports(repoFiles);
const packageDeepImports = importBoundaryReports.filter(isPackageDeepImport);
const longRelativeImports = importBoundaryReports.filter(isLongRelativeImport);
const formatEdge = (edge) => `${edge.file}:${edge.line}: ${edge.specifier}`;
const debt = reviewImportDebt(importBoundaryReports, importDebt.edges);
const codeRunnerBarrelPath = findRuntimeDependencyPath(
  importBoundaryReports,
  'packages/core/src/integrations/CodeRunner.ts',
  new Set(['packages/core/src/index.ts', 'packages/core/src/exports.ts']),
  { '@valerypopoff/rivet2-core': 'packages/core/src/index.ts' },
);
if (codeRunnerBarrelPath) {
  console.error(
    `CodeRunner must receive its public namespace at composition, not import it: ${codeRunnerBarrelPath.join(' -> ')}`,
  );
  process.exitCode = 1;
}

if (packageDeepImports.length > 0) {
  console.error('Package source deep imports are not allowed:');
  for (const report of packageDeepImports) console.error(`  - ${formatEdge(report)}`);
  process.exitCode = 1;
}
if (debt.added.length || debt.removed.length || debt.duplicates.length) {
  for (const key of debt.added) console.error(`Unreviewed deep relative dependency: ${key}`);
  for (const key of debt.removed) console.error(`Remove obsolete dependency allowance: ${key}`);
  for (const key of debt.duplicates) console.error(`Duplicate dependency allowance: ${key}`);
  process.exitCode = 1;
}

if (longRelativeImports.length > 0) {
  console.log('');
  console.log(
    `Import-boundary debt (${new Set(longRelativeImports.map(edgeKey)).size} exact dependencies; new or stale allowances fail):`,
  );
  for (const report of longRelativeImports.slice(0, 20)) {
    console.log(`  - ${formatEdge(report)}`);
  }

  if (longRelativeImports.length > 20) {
    console.log(`  ... remaining entries are recorded in scripts/checks/import-boundary-debt.json`);
  }
} else {
  console.log('No package deep imports or long relative imports found.');
}
