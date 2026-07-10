import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Shrink this as legacy deep relative imports are moved behind local barrels.
const longRelativeImportBaseline = 154;

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

    const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/from\s+['"]@valerypopoff\/[^'"]+\/src(?:\/[^'"]*)?['"]/.test(line)) {
        reports.push(`${file}:${index + 1}: package deep import`);
      }

      if (!/\.(?:test|spec)\.[^.]+$/.test(file) && /from\s+['"](?:\.\.\/){3,}[^'"]*['"]/.test(line)) {
        reports.push(`${file}:${index + 1}: long relative import`);
      }
    }
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
const packageDeepImports = importBoundaryReports.filter((report) => report.endsWith('package deep import'));
const longRelativeImports = importBoundaryReports.filter((report) => report.endsWith('long relative import'));

if (packageDeepImports.length > 0) {
  console.error('Package source deep imports are not allowed:');
  for (const report of packageDeepImports) console.error(`  - ${report}`);
  process.exitCode = 1;
}
if (longRelativeImports.length > longRelativeImportBaseline) {
  console.error(
    `Long relative imports grew from the reviewed baseline (${longRelativeImportBaseline}) to ${longRelativeImports.length}:`,
  );
  for (const report of longRelativeImports.slice(longRelativeImportBaseline)) console.error(`  - ${report}`);
  process.exitCode = 1;
}

if (importBoundaryReports.length > 0) {
  console.log('');
  console.log(
    `Import-boundary review queue (${longRelativeImports.length}/${longRelativeImportBaseline} long relative imports; new package deep imports fail):`,
  );
  for (const report of importBoundaryReports.slice(0, 100)) {
    console.log(`  - ${report}`);
  }

  if (importBoundaryReports.length > 100) {
    console.log(`  ... ${importBoundaryReports.length - 100} more`);
  }
} else {
  console.log('No package deep imports or long relative imports found.');
}
